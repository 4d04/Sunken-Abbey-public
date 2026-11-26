/*
 * End-to-end smoke test against a running localnet (spike/localnet.sh), through the client library only:
 * two players, character creation with sealed stat rolls, movement, combat, a crash between commit and reveal that a
 * fresh session recovers, verification of every resolved roll, the shared feed, and extraction. Run: npm run smoke
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitment, rollId } from '@abbey/rules';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Net, endpointsFromEnv } from '../src/lib/net.ts';
import { type RollRecord, Session } from '../src/lib/session.ts';
import { Vault } from '../src/lib/vault.ts';
import { verifyRoll } from '../src/lib/verify.ts';

const net = new Net(endpointsFromEnv());
const home = mkdtempSync(join(tmpdir(), 'abbey-smoke-'));
const results: [boolean, string][] = [];
const check = (ok: boolean, what: string, detail = '') => {
    results.push([ok, what]);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
};
const rolls: RollRecord[] = [];

async function player(name: string, classId: string): Promise<{ s: Session; charId: string }> {
    const s = new Session(net, Vault.create(join(home, name), `${name} passphrase`));
    await s.claimFaucet();
    const { charId, rolled } = await s.createCharacter(name, classId);
    rolls.push((await s.roll(bytesToHex(rollId(hexToBytes(charId), 0))))!);
    await s.assignStats(charId, [0, 1, 2, 3, 4, 5]);
    await s.enter(charId);
    check((await s.character(charId))?.char.status === 'delving', `${name} rolled ${rolled.join(' ')} and entered`);
    return { s, charId };
}

async function main(): Promise<void> {
    console.log(`chain ${net.ep.chainId} via ${net.ep.rpc}, plugin ${net.ep.plugin}, height ${await net.height()}`);
    const [a, b] = await Promise.all([player('Ilse', 'fighter'), player('Odo', 'wizard')]);

    // a dice-free move (the Narthex's other door leads to an empty room): the outcome comes from the block's events
    const quiet = await a.s.act(a.charId, { kind: 'move', to: 3 }, false);
    check((await a.s.character(a.charId))!.char.room === 3 && quiet.events.some((e) => e.t === 'move'), 'a dice-free move resolves and its events are found');
    await a.s.act(a.charId, { kind: 'move', to: 1 }, false);

    // walking into the Ossuary: its skeletons roll initiative against you (the ambush variant), so the move is a roll
    const toOssuary = (await a.s.options(a.charId)).options.find((o) => o.intent.kind === 'move' && o.intent.to === 2)!;
    const moved = await a.s.act(a.charId, toOssuary.intent, toOssuary.needsRoll);
    if (moved.roll) rolls.push(moved.roll);
    const init = (moved.roll?.resolved?.events ?? []).find((e) => e.t === 'initiative');
    check((await a.s.character(a.charId))!.char.room === 2 && toOssuary.needsRoll && !!init, 'walking into a room with hostiles rolls initiative', init ? `${init.first} first` : 'no initiative event');

    // a dice action: commit, auto-reveal, resolved and verifiable
    // attack whichever skeleton still stands (earlier runs on the same chain may have killed some)
    const attack = (await a.s.options(a.charId)).options.find((o) => o.intent.kind === 'attack')!;
    const fight = await a.s.act(a.charId, attack.intent, true);
    rolls.push(fight.roll!);
    check(fight.outcome === 'resolved' && fight.roll!.resolved!.dice.length >= 2, 'an attack commits, reveals and resolves', `${fight.roll!.resolved!.dice.map((d) => `d${d.sides}=${d.value}`).join(' ')}`);

    // a crash between commit and reveal: the commit lands, the client dies, a fresh session on the same vault reveals
    const rec = (await b.s.character(b.charId))!;
    const rid = bytesToHex(rollId(hexToBytes(b.charId), rec.actionNonce));
    const secret = new Uint8Array(32).map(() => Math.floor(Math.random() * 256));
    b.s.vault.saveSecret(rid, b.charId, secret);
    await b.s.send('act', { charId: hexToBytes(b.charId), kind: 'action', actionId: 'narthex.search_silt', commit: commitment(secret, hexToBytes(rid)) }, async () => !!(await b.s.roll(rid)));
    const reborn = new Session(net, Vault.open(join(home, 'Odo'), 'Odo passphrase'));
    const resumed = await reborn.resumePending();
    check(resumed.revealed.length === 1 && resumed.revealed[0].resolved?.outcome === 'resolved', 'a fresh session reveals a roll sealed before a crash');
    rolls.push(resumed.revealed[0]);

    // every roll verifies against the chain's beacons
    for (const r of rolls) {
        const v = verifyRoll((await a.s.roll(r.id)) ?? r, await a.s.beacon(r.committedAt));
        check(v.ok, `roll ${r.id.slice(0, 12)}… verifies`, v.checks.map((c) => `${c.ok ? '✓' : '✗'}${c.name}`).join(' '));
    }

    // the feed: Odo sees Ilse's attack in the block events
    const evs = await a.s.net.events(fight.height);
    check(evs.some((e) => e.kind === 'ActionResolved' && e.data.rollId === fight.rollId && e.address === a.s.address), "Ilse's attack is in the block's events, attributed to her");

    // back to camp and extract (Ilse flees the Ossuary first if she must)
    const back = await b.s.act(b.charId, { kind: 'action', actionId: 'narthex.wade_out' }, true);
    const odo = (await b.s.character(b.charId))!.char;
    if (back.success && odo.room === 0) {
        await b.s.extract(b.charId);
        check((await b.s.character(b.charId))!.char.status === 'camp', 'Odo waded out and extracted');
    } else check(true, 'Odo failed to wade out (a fair roll); extraction skipped');

    const failed = results.filter(([ok]) => !ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
