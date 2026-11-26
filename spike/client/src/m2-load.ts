/* M2 load test: PLAYERS delvers doing back-to-back commit-reveal silt searches; reveals wait for the roll record. */

import { createHash, randomBytes } from 'crypto';
import { type Key, PLUGIN_RPC, RPC, block, height, localKey, post, submit, waitTx } from './chain.js';

const PLAYERS = Number(process.env.PLAYERS || 100);
const DURATION_MS = Number(process.env.DURATION_S || 180) * 1000;
const FEE = 10_000n;
const POLL_MS = Number(process.env.POLL_MS || 1000); // how often a player checks for its roll (about half a block suits)
const sha = (...p: Uint8Array[]) => {
    const h = createHash('sha256');
    for (const x of p) h.update(x);
    return new Uint8Array(h.digest());
};
const u64 = (v: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(v));
    return b;
};
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

let resubmits = 0;
/** After "block is full", wait a block or two (with jitter) instead of resubmitting into the same crowd. */
const backoff = () => new Promise((r) => setTimeout(r, (Number(process.env.BACKOFF_S ?? 6) + Math.random() * 6) * 1000));
const full = (e: unknown) => String((e as Error).message).includes('block is full');
/** Submit and wait; a tx dropped by the per-block cap is resubmitted (the core removes failed txs from its mempool). */
async function send(k: Key, type: string, f: Record<string, any>, fee = FEE): Promise<any> {
    for (;;) {
        try {
            return await waitTx(await submit(k, type, { address: bytes(k.address), ...f }, fee), k.address, 120_000);
        } catch (e) {
            if (!full(e)) throw e;
            resubmits++;
            await backoff();
        }
    }
}
const abbey = async (path: string) => (await fetch(`${PLUGIN_RPC}${path}`)).json();
/**
 * Confirm a commit or reveal from committed plugin state: the roll record exists (commit) or is resolved (reveal).
 * waitTx's tx-by-hash heuristic misfires when a mempool tx misses the next block (it is stamped with that height).
 */
async function sendRoll(k: Key, type: string, f: Record<string, any>, rid: Uint8Array, until: 'committed' | 'resolved'): Promise<void> {
    for (;;) {
        try {
            return await sendRollOnce(k, type, f, rid, until);
        } catch (e) {
            if (!full(e)) throw e;
            resubmits++;
            await backoff();
        }
    }
}

async function sendRollOnce(k: Key, type: string, f: Record<string, any>, rid: Uint8Array, until: 'committed' | 'resolved'): Promise<void> {
    const hash = await submit(k, type, { address: bytes(k.address), ...f }, FEE);
    const stop = Date.now() + 120_000;
    for (let i = 1; Date.now() < stop; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const res = await fetch(`${PLUGIN_RPC}/abbey/roll?id=${hx(rid)}`);
        if (res.status === 200 && (until === 'committed' || (await res.json()).resolved)) return;
        if (i % Math.max(1, Math.round(5000 / POLL_MS)) === 0) {
            const failed = await post(`${RPC}/v1/query/failed-txs`, { address: k.address, perPage: 50 });
            const hit = (failed?.results || []).find((x: any) => x.txHash === hash || x.transaction?.txHash === hash);
            if (hit) throw new Error(`tx ${hash} failed: ${JSON.stringify(hit.error)}`);
        }
    }
    throw new Error(`${type} ${hx(rid)} not ${until} within 120s`);
}

let rolls = 0;
let failures = 0;
const samples: string[] = [];

/** Send until the effect shows in plugin state (tx-by-hash can report a tx that missed its block as committed). */
async function sendUntil(k: Key, type: string, f: Record<string, any>, fee: bigint, done: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await send(k, type, f, fee);
        } catch (e) {
            if (await done()) return; // an earlier attempt landed after all
            throw e;
        }
        for (let i = 0; i < 30; i++) {
            if (await done()) return;
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    throw new Error(`${type} never took effect`);
}

async function delver(k: Key): Promise<string> {
    await sendUntil(k, 'faucet_claim', {}, 0n, async () => (await abbey(`/abbey/faucet?address=${k.address}`)).record !== null);
    const charId = hx(sha(bytes(k.address), u64(0)).subarray(0, 16));
    const rid = sha(bytes(charId), u64(0));
    const secret = new Uint8Array(randomBytes(32));
    await sendRoll(k, 'create_character', { name: 'loadtest', classId: 'cleric', commit: sha(secret, rid) }, rid, 'committed');
    await sendRoll(k, 'reveal', { rollId: rid, secret }, rid, 'resolved');
    const status = async () => (await fetch(`${PLUGIN_RPC}/abbey/character?id=${charId}`).then((r) => (r.ok ? r.json() : null)))?.char?.status;
    await sendUntil(k, 'assign_stats', { charId: bytes(charId), permutation: [0, 1, 2, 3, 4, 5] }, FEE, async () => (await status()) !== 'rolling');
    await sendUntil(k, 'enter_dungeon', { charId: bytes(charId) }, FEE, async () => (await status()) === 'delving');
    return charId;
}

async function player(k: Key, charId: string, stopAt: number): Promise<void> {
    while (Date.now() < stopAt) {
        try {
            const rec = await abbey(`/abbey/character?id=${charId}`);
            const rid = sha(bytes(charId), u64(rec.actionNonce));
            const secret = new Uint8Array(randomBytes(32));
            await sendRoll(k, 'act', { charId: bytes(charId), kind: 'action', actionId: 'narthex.search_silt', commit: sha(secret, rid) }, rid, 'committed');
            await sendRoll(k, 'reveal', { rollId: rid, secret }, rid, 'resolved');
            rolls++;
        } catch (e) {
            failures++;
            if (samples.length < 5) samples.push(String((e as Error).message).slice(0, 160));
            await new Promise((r) => setTimeout(r, 70_000)); // let a stuck roll forfeit
        }
    }
}

async function main(): Promise<void> {
    const keys = Array.from({ length: PLAYERS }, () => localKey());
    const chars = await Promise.all(keys.map(delver));
    console.log(`${PLAYERS} delvers in the Narthex; load for ${DURATION_MS / 1000}s`);
    const start = await height();
    const stopAt = Date.now() + DURATION_MS;
    await Promise.all(keys.map((k, i) => player(k, chars[i], stopAt)));
    const end = (await height()) - 1n;
    const xs: number[] = [];
    let prev = 0n;
    let txs = 0;
    let maxTxs = 0;
    for (let h = start; h <= end; h++) {
        const hd = (await block(h)).blockHeader;
        const n = Number(hd.numTxs || 0);
        txs += n;
        maxTxs = Math.max(maxTxs, n);
        if (prev) xs.push(Number(BigInt(hd.time) - prev) / 1e6);
        prev = BigInt(hd.time);
    }
    xs.sort((a, b) => a - b);
    if (xs.length === 0) throw new Error(`no blocks between heights ${start} and ${end}: the chain stalled`);
    const pct = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))].toFixed(2);
    console.log(JSON.stringify({
        players: PLAYERS, blocks: Number(end - start + 1n), txs, maxTxsPerBlock: maxTxs,
        txPerSec: Number((txs / (xs.reduce((a, b) => a + b, 0) || 1)).toFixed(1)),
        blockS: { mean: (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2), p50: pct(0.5), p95: pct(0.95), max: xs.at(-1)!.toFixed(2) },
        rolls, failures, resubmits, samples
    }, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
