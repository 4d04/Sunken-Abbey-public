/*
 * Load test for fast blocks: PLAYERS delvers doing back-to-back commit-reveal silt searches, confirmed from block events.
 * One watcher reads each block's events once and wakes the player whose commit or reveal landed, so the read load is
 * one query per block instead of one per player per poll (which overloads the plugin's read endpoint). A tx not seen
 * within RETRY_BLOCKS blocks is resubmitted; a duplicate that lands later just fails and is evicted.
 * Env: PLAYERS, DURATION_S, RETRY_BLOCKS (6), PORT=300 CHAIN_ID=2 for the nested chain.
 */

import { createHash, randomBytes } from 'crypto';
import { type Key, PLUGIN_RPC, block, google, height, localKey, submit, types } from './chain.js';

const PLAYERS = Number(process.env.PLAYERS || 100);
const DURATION_MS = Number(process.env.DURATION_S || 90) * 1000;
const RETRY_BLOCKS = Number(process.env.RETRY_BLOCKS || 6);
const FEE = 10_000n;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the block watcher

type Want = 'committed' | 'resolved';
const waiters = new Map<string, { want: Want; until: number; done: (ok: boolean) => void }>();
let tip = 0; // the last block whose events were read
let head = 0; // the chain's latest block: deadlines count from here, so a lagging watcher can't expire a tx early

/** Wait until the roll's commit (or resolution) is in a block, or `blocks` blocks pass. */
function waitFor(rollId: string, want: Want, blocks = RETRY_BLOCKS): Promise<boolean> {
    return new Promise((done) => waiters.set(`${want}:${rollId}`, { want, until: Math.max(head, tip) + blocks, done }));
}

/** The watcher's own requests: never queued behind the players' submissions. */
async function direct(path: string, body: unknown): Promise<any> {
    const r = await fetch(`${RPC_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
}

async function watch(): Promise<never> {
    for (;;) {
        try {
            await watchLoop();
        } catch {
            await sleep(300); // a dropped connection: carry on from the last block read
        }
    }
}

async function watchLoop(): Promise<never> {
    if (!tip) tip = Number((await direct('/v1/query/height', {})).height) - 3;
    for (;;) {
        // two blocks behind the tip: a block's events are indexed a moment after the height moves past it
        head = Number((await direct('/v1/query/height', {})).height) - 1;
        const next = head - 2;
        for (let h = tip + 1; h <= next; h++) {
            const page = await direct('/v1/query/events-by-height', { height: h, perPage: 2000 });
            for (const e of page?.results ?? []) {
                const kind = String(e.eventType ?? '');
                if (!kind.startsWith('abbey.')) continue;
                let data: any = {};
                try {
                    data = JSON.parse(types.AbbeyEvent.decode(google.protobuf.Any.decode(Buffer.from(e.msg.orderId, 'hex')).value).data);
                } catch {
                    continue;
                }
                const want: Want | null = kind === 'abbey.ActionCommitted' ? 'committed' : /abbey\.(ActionResolved|ActionForfeited|ActionFizzled|StatsRolled)/.test(kind) ? 'resolved' : null;
                const w = want && waiters.get(`${want}:${data.rollId}`);
                if (w) {
                    waiters.delete(`${want}:${data.rollId}`);
                    w.done(true);
                }
            }
            tip = h;
            for (const [k, w] of waiters) {
                if (tip >= w.until) {
                    waiters.delete(k);
                    w.done(false);
                }
            }
        }
        await sleep(150);
    }
}
const RPC_BASE = `http://127.0.0.1:${process.env.PORT || '500'}02`;

// ---------------------------------------------------------------- players

let rolls = 0;
let resubmits = 0;
const latency: number[] = [];

/** Send until the watcher sees it (resubmitting after RETRY_BLOCKS); CheckTx refusals of a duplicate are ignored. */
async function sendSeen(k: Key, type: string, f: Record<string, any>, rid: string, want: Want): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        if (attempt) resubmits++;
        const seen = waitFor(rid, want);
        await submit(k, type, { address: bytes(k.address), ...f }, type === 'faucet_claim' ? 0n : FEE).catch(() => undefined);
        if (await seen) return;
        if (attempt > 40) throw new Error(`${type} ${rid} never landed`);
    }
}

/** Setup is not measured: plain polling of plugin state, one player at a time per slot. */
async function until(fn: () => Promise<boolean>, send: () => Promise<unknown>): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
        await send().catch(() => undefined);
        for (let i = 0; i < 20; i++) {
            await sleep(500);
            if (await fn()) return;
        }
    }
    throw new Error('setup step never landed');
}

/** A plugin read; a dropped connection (the read endpoint resets under heavy polling) reads as "not yet". */
const abbey = async (path: string) => {
    try {
        const r = await fetch(`${PLUGIN_RPC}${path}`);
        return r.status === 200 ? r.json() : null;
    } catch {
        await sleep(500 + Math.random() * 1000);
        return null;
    }
};

async function delver(k: Key): Promise<{ charId: string; nonce: number }> {
    const a = bytes(k.address);
    await until(async () => (await abbey(`/abbey/faucet?address=${k.address}`))?.record != null, () => submit(k, 'faucet_claim', { address: a }, 0n));
    const charId = hx(sha(a, u64(0)).subarray(0, 16));
    const rid = hx(sha(bytes(charId), u64(0)));
    const secret = new Uint8Array(randomBytes(32));
    // creating a character emits no ActionCommitted: confirm the stat roll from state (and reveal fast: R is 10 blocks)
    await until(async () => (await abbey(`/abbey/roll?id=${rid}`)) != null, () => submit(k, 'create_character', { address: a, name: 'fast', classId: 'cleric', commit: sha(secret, bytes(rid)) }, FEE));
    await sendSeen(k, 'reveal', { rollId: bytes(rid), secret }, rid, 'resolved');
    const status = async () => (await abbey(`/abbey/character?id=${charId}`))?.char?.status;
    await until(async () => (await status()) !== 'rolling', () => submit(k, 'assign_stats', { address: a, charId: bytes(charId), permutation: [0, 1, 2, 3, 4, 5] }, FEE));
    await until(async () => (await status()) === 'delving', () => submit(k, 'enter_dungeon', { address: a, charId: bytes(charId) }, FEE));
    return { charId, nonce: (await abbey(`/abbey/character?id=${charId}`)).actionNonce };
}

async function player(k: Key, me: { charId: string; nonce: number }, stopAt: number): Promise<void> {
    while (Date.now() < stopAt) {
        const rid = hx(sha(bytes(me.charId), u64(me.nonce)));
        const secret = new Uint8Array(randomBytes(32));
        const t0 = performance.now();
        await sendSeen(k, 'act', { charId: bytes(me.charId), kind: 'action', actionId: 'narthex.search_silt', commit: sha(secret, bytes(rid)) }, rid, 'committed');
        me.nonce++;
        await sendSeen(k, 'reveal', { rollId: bytes(rid), secret }, rid, 'resolved');
        latency.push((performance.now() - t0) / 1000);
        rolls++;
    }
}

async function main(): Promise<void> {
    void watch();
    await sleep(500);
    const keys = Array.from({ length: PLAYERS }, () => localKey());
    const t = Date.now();
    const chars = await Promise.all(keys.map(delver));
    console.log(`${PLAYERS} delvers ready in ${((Date.now() - t) / 1000).toFixed(0)}s; load for ${DURATION_MS / 1000}s`);
    const start = Number(await height());
    const t0 = Date.now();
    const stopAt = t0 + DURATION_MS;
    await Promise.all(keys.map((k, i) => player(k, chars[i], stopAt)));
    const secs = (Date.now() - t0) / 1000;
    const end = Number(await height()) - 1;
    const gaps: number[] = [];
    const perBlock: number[] = [];
    let prev = 0n;
    for (let h = start; h <= end; h++) {
        const hd = (await block(BigInt(h))).blockHeader;
        perBlock.push(Number(hd.numTxs || 0));
        if (prev) gaps.push(Number(BigInt(hd.time) - prev) / 1e6);
        prev = BigInt(hd.time);
    }
    const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    const txs = perBlock.reduce((a, b) => a + b, 0);
    console.log(JSON.stringify({
        players: PLAYERS, seconds: Math.round(secs), blocks: perBlock.length, txs,
        txPerSec: Number((txs / gaps.reduce((a, b) => a + b, 0)).toFixed(1)),
        txsPerBlock: { mean: Number((txs / perBlock.length).toFixed(1)), p50: pct(perBlock, 0.5), p95: pct(perBlock, 0.95), max: Math.max(...perBlock) },
        blockS: { mean: Number((gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(3)), p50: pct(gaps, 0.5), p95: pct(gaps, 0.95), max: Math.max(...gaps) },
        rolls, resubmits,
        diceMoveS: { p50: pct(latency, 0.5).toFixed(2), p95: pct(latency, 0.95).toFixed(2), max: Math.max(...latency).toFixed(2) }
    }, null, 2));
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
