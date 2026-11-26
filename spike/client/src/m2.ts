/* M2 end-to-end on the nested localnet: one player through every message type, against the real core + plugin. */

import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { type Key, CHAIN_ID, FAUCET, PLUGIN_RPC, RPC, TREASURY, balance, height, localKey, post, sleep, submit, waitTx } from './chain.js';

const FEE = 10_000n;
const MICRO = 1_000_000n;
const results: { check: string; ok: boolean; detail?: string }[] = [];
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
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

function check(name: string, ok: boolean, detail?: unknown): void {
    results.push({ check: name, ok, detail: detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail) });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${results.at(-1)!.detail}`}`);
}

async function abbey(path: string): Promise<any> {
    const res = await fetch(`${PLUGIN_RPC}${path}`);
    return res.json();
}

async function send(key: Key, type: string, fields: Record<string, any>, fee = FEE): Promise<any> {
    const msg = type === 'send' ? fields : { address: bytes(key.address), ...fields }; // core send has no `address`
    return waitTx(await submit(key, type, msg, fee), key.address, 90_000);
}

async function expectFail(key: Key, type: string, fields: Record<string, any>, fee = FEE): Promise<string> {
    try {
        await send(key, type, fields, fee);
        return 'unexpectedly succeeded';
    } catch (e) {
        return String((e as Error).message);
    }
}

/** commit-reveal like the client: secret in memory, reveal as soon as the commit block is final */
async function roll(key: Key, charId: string, intent: Record<string, any>): Promise<any> {
    const rec = await abbey(`/abbey/character?id=${charId}`);
    const rid = sha(bytes(charId), u64(rec.actionNonce));
    const secret = new Uint8Array(randomBytes(32));
    const commit = sha(secret, rid);
    const t0 = Date.now();
    await send(key, 'act', { charId: bytes(charId), commit, ...intent });
    await send(key, 'reveal', { rollId: rid, secret });
    const r = await abbey(`/abbey/roll?id=${hx(rid)}`);
    return { ...r, latencyMs: Date.now() - t0 };
}

async function main(): Promise<void> {
    const authority: Key = JSON.parse(readFileSync(new URL('../.m2-authority.json', import.meta.url), 'utf8'));
    console.log(`chain ${CHAIN_ID} via ${RPC}, plugin RPC ${PLUGIN_RPC}, height ${await height()}`);

    // ---- world is up
    const levels = await abbey('/abbey/levels');
    check('level 1 active with a 700g season budget', levels[0]?.id === 1 && levels[0].budgetReserved === 700, { season: levels[0]?.season, contentHash: levels[0]?.contentHash?.slice(0, 16) });
    const treasury0 = await balance(TREASURY);

    // ---- faucet from a zero-balance account, fee 0
    const p = localKey();
    check('new account starts at 0', (await balance(p.address)) === 0n);
    await send(p, 'faucet_claim', {}, 0n);
    check('faucet_claim pays 100 GOLD with fee 0', (await balance(p.address)) === 100n * MICRO);
    const feeOnFree = await expectFail(p, 'faucet_claim', {}, 5n);
    check('a fee on faucet_claim is rejected', /fee 0/.test(feeOnFree), feeOnFree.slice(0, 120));

    // ---- character: create (commit) → reveal stats → assign → enter
    const acct = await abbey(`/abbey/account?address=${p.address}`);
    const charId = hx(sha(bytes(p.address), u64(acct.nextChar)).subarray(0, 16));
    const statsRoll = sha(bytes(charId), u64(0));
    const statsSecret = new Uint8Array(randomBytes(32));
    await send(p, 'create_character', { name: 'Brannoc', classId: 'fighter', commit: sha(statsSecret, statsRoll) });
    await send(p, 'reveal', { rollId: statsRoll, secret: statsSecret });
    const rolled = (await abbey(`/abbey/character?id=${charId}`)).rolled;
    check('stat roll revealed: six 4d6-drop-lowest scores', Array.isArray(rolled) && rolled.length === 6 && rolled.every((v: number) => v >= 3 && v <= 18), rolled);
    await send(p, 'assign_stats', { charId: bytes(charId), permutation: [0, 1, 2, 3, 4, 5] });
    await send(p, 'enter_dungeon', { charId: bytes(charId) });
    let ch = (await abbey(`/abbey/character?id=${charId}`)).char;
    check('entered the Narthex', ch.status === 'delving' && ch.room === 1, { status: ch.status, room: ch.room, hp: ch.hp });

    // ---- options with odds; a plain move resolves without commit-reveal
    const opts = await abbey(`/abbey/options?char=${charId}`);
    check('options list legal intents with odds', opts.options.length > 0, opts.options.map((o: any) => `${o.intent.kind}${o.intent.actionId ? ':' + o.intent.actionId : ''}${o.needsRoll ? '*' : ''}`));
    await send(p, 'act', { charId: bytes(charId), kind: 'move', toRoom: 3 });
    ch = (await abbey(`/abbey/character?id=${charId}`)).char;
    check('a plain move resolves immediately', ch.room === 3);
    await send(p, 'act', { charId: bytes(charId), kind: 'move', toRoom: 1 });

    // ---- a dice action through commit-reveal, verified against the beacon
    const silt = await roll(p, charId, { kind: 'action', actionId: 'narthex.search_silt' });
    const beacon = await abbey(`/abbey/beacon?at=${silt.committedAt}`);
    check('commit-reveal resolves the silt search', silt.resolved?.outcome === 'resolved', { success: silt.resolved?.success, latencyMs: silt.latencyMs });
    check('the roll used the beacon of its commit block', beacon.value === silt.resolved?.beacon);

    // ---- forfeit: commit and never reveal
    {
        const rec = await abbey(`/abbey/character?id=${charId}`);
        const rid = sha(bytes(charId), u64(rec.actionNonce));
        await send(p, 'act', { charId: bytes(charId), kind: 'action', actionId: 'narthex.search_silt', commit: sha(new Uint8Array(randomBytes(32)), rid) });
        // R is the plugin's reveal window (~60s of blocks): the roll record says when it expires
        const { committedAt, expiresAt } = await abbey(`/abbey/roll?id=${hx(rid)}`);
        while ((await height()) <= expiresAt + 1) await sleep(2000);
        const r = await abbey(`/abbey/roll?id=${hx(rid)}`);
        check('an unrevealed roll is forfeited after R blocks', r.resolved?.outcome === 'forfeited' && r.resolved.height === expiresAt, { committedAt, expiresAt, resolvedAt: r.resolved?.height });
    }

    // ---- combat in the Ossuary, then flee
    // walking into the skeletons is an ambush (rules LIVE_VARIANTS): the move rolls initiative, so it's commit-reveal
    await roll(p, charId, { kind: 'move', toRoom: 2 });
    const hit = await roll(p, charId, { kind: 'attack', target: '0' });
    const evs = hit.resolved?.events ?? [];
    check('an attack resolves with a counterattack exchange', evs.filter((e: any) => e.t === 'attack').length >= 1, evs.filter((e: any) => e.t === 'attack').map((e: any) => `${e.attacker}→${e.target} ${e.kept}+=${e.total} vs ${e.ac} ${e.hit ? 'hit' : 'miss'}`));
    // flee (DEX vs 10 + 2 per skeleton) until it works or the skeletons drop us
    let tries = 0;
    for (; tries < 30; tries++) {
        ch = (await abbey(`/abbey/character?id=${charId}`)).char;
        if (ch.status !== 'delving' || ch.room === 1) break;
        await roll(p, charId, { kind: 'move', toRoom: 1 });
    }
    ch = (await abbey(`/abbey/character?id=${charId}`)).char;
    check('fled back to the Narthex, or went down trying', ch.room === 1 || ch.status === 'downed', { room: ch.room, status: ch.status, hp: ch.hp, tries });
    if (ch.status === 'downed') {
        // nobody comes: the Ferryman takes them to the Lychgate after DOWNED_SECONDS (rules/src/timing.ts: 120s = 240 blocks)
        const due = ch.downedAt + 240 + 1;
        while ((await height()) <= due + 1) await sleep(3000);
        ch = (await abbey(`/abbey/character?id=${charId}`)).char;
        check('the Ferryman returns a downed character to the Lychgate at 1 HP', ch.status === 'delving' && ch.room === 0 && ch.hp === 1, { room: ch.room, hp: ch.hp, carried: ch.carriedGold });
    }

    // ---- out: wade to the Lychgate, extract, shop
    ch = (await abbey(`/abbey/character?id=${charId}`)).char;
    if (ch.status === 'delving' && ch.room === 1) await roll(p, charId, { kind: 'action', actionId: 'narthex.wade_out' });
    ch = (await abbey(`/abbey/character?id=${charId}`)).char;
    if (ch.status === 'delving' && ch.room === 0) {
        const carried = BigInt(ch.carriedGold);
        const w0 = await balance(p.address);
        const t0 = await balance(TREASURY);
        await send(p, 'extract', { charId: bytes(charId) });
        const w1 = await balance(p.address);
        const t1 = await balance(TREASURY);
        check('extract moves carried gold treasury → wallet exactly', w1 - w0 === carried * MICRO - FEE && t0 - t1 === carried * MICRO, { carried: Number(carried) });
        await send(p, 'shop_buy', { charId: bytes(charId), template: 'healing_potion', qty: 1 });
        check('shop_buy pays wallet → treasury', (await balance(p.address)) === w1 - 25n * MICRO - FEE && (await balance(TREASURY)) === t1 + 25n * MICRO);
    } else {
        check('reached the Lychgate to extract', false, { room: ch.room, status: ch.status });
    }

    // ---- params authority switches on a faucet limit with one tx
    await submitTo(authority);
    const second = await expectFail(p, 'faucet_claim', {}, 0n);
    check('set_params (authority) enables a cooldown; the next claim is rejected', /cooldown/.test(second), second.slice(0, 120));
    const stranger = await expectFail(p, 'set_params', { paramsJson: JSON.stringify({ faucetCooldownBlocks: 0 }) });
    check('set_params from a non-authority is rejected', /authority/.test(stranger));

    // ---- plugin events are indexed by the core
    const evPage = await post(`${RPC}/v1/query/events-by-address`, { address: p.address, perPage: 100 });
    const abbeyEvents = (evPage?.results || []).filter((e: any) => String(e.eventType || e.event_type).startsWith('abbey.'));
    check('the core indexes plugin events by address', abbeyEvents.length > 0, [...new Set(abbeyEvents.map((e: any) => e.eventType))]);

    const treasury1 = await balance(TREASURY);
    const t = await abbey('/abbey/treasury');
    check('treasury invariant: free ≥ 0 after the session', t.free >= 0, { balanceGold: Number(BigInt(t.balance) / MICRO), free: t.free, ledger: t.ledger, delta: Number((treasury1 - treasury0) / MICRO) });
    check('faucet balance tracked', BigInt((await abbey('/abbey/faucet')).balance) === (await balance(FAUCET)));

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);

    async function submitTo(auth: Key): Promise<void> {
        if ((await balance(auth.address)) < FEE) {
            // fund the authority with a core send from the player (core message, not a game one)
            await send(p, 'send', { fromAddress: bytes(p.address), toAddress: bytes(auth.address), amount: Number(FEE * 10n) });
        }
        await send(auth, 'set_params', { paramsJson: JSON.stringify({ faucetCooldownBlocks: 600 }) });
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
