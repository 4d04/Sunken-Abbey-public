/* Library unit tests: vault, roll verification, encoding, event decoding, narration, map. No chain needed. */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FixedDice, SeededDice, assignStats, commitment, enterDungeon, initialRoom, newCharacter, newSeason, resolve, rollId, rollSeed, type Scene } from '@abbey/rules';
import { bytesToHex } from '@noble/hashes/utils.js';
import { arrival, castOf, narrate, purposeOf, tell } from '../src/lib/narrate.ts';
import { recount } from '../src/lib/recount.ts';
import { groupDice } from '../src/lib/dicelog.ts';
import { decodeEvent, omitDefaults } from '../src/lib/net.ts';
import { type RollRecord, content, gold, intentFields } from '../src/lib/session.ts';
import { Vault, WrongPassphrase } from '../src/lib/vault.ts';
import { verifyRoll } from '../src/lib/verify.ts';
import { drawMap } from '../src/tui/map.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'abbey-client-'));

describe('vault', () => {
    it('round-trips the key and secrets under a passphrase, owner-only, never in plaintext', () => {
        const dir = join(tmp(), 'p');
        const v = Vault.create(dir, 'a long passphrase');
        const again = Vault.open(dir, 'a long passphrase');
        assert.equal(again.key.privateKey, v.key.privateKey);
        assert.equal(Vault.address(dir), v.key.address);
        const file = readFileSync(join(dir, 'key.json'), 'utf8');
        assert.ok(!file.includes(v.key.privateKey), 'private key must not be stored in plaintext');
        assert.equal(statSync(join(dir, 'key.json')).mode & 0o777, 0o600);
        assert.throws(() => Vault.open(dir, 'wrong passphrase'), WrongPassphrase);
        const secret = new Uint8Array(32).fill(7);
        v.saveSecret('aa'.repeat(32), 'bb'.repeat(16), secret);
        assert.ok(!readFileSync(join(dir, 'pending.json'), 'utf8').includes(bytesToHex(secret)));
        assert.deepEqual(again.secret('aa'.repeat(32)), secret);
        assert.deepEqual(again.pending().map((p) => p.charId), ['bb'.repeat(16)]);
        again.dropSecret('aa'.repeat(32));
        assert.deepEqual(v.pending(), []);
    });
});

/** A roll record as the plugin would publish it, with dice drawn from the real seed. */
function rollRecord(sides: number[], tamper?: (r: RollRecord) => void): { roll: RollRecord; beacon: { height: number; value: string } } {
    const secret = new Uint8Array(32).fill(3);
    const beacon = new Uint8Array(32).fill(9);
    const id = rollId(new Uint8Array(16).fill(1), 4);
    const dice = new SeededDice(rollSeed(secret, beacon, id));
    for (const s of sides) dice.roll(s, s === 20 ? 'pc' : 'npc');
    const roll: RollRecord = {
        id: bytesToHex(id), kind: 'act', owner: '00'.repeat(20), charId: '01'.repeat(16), intent: { kind: 'rest' },
        commit: bytesToHex(commitment(secret, id)), committedAt: 50, expiresAt: 60,
        resolved: { height: 51, outcome: 'resolved', secret: bytesToHex(secret), beacon: bytesToHex(beacon), dice: dice.log, success: true, events: [] }
    };
    tamper?.(roll);
    return { roll, beacon: { height: 50, value: bytesToHex(beacon) } };
}

describe('roll verification', () => {
    it('accepts dice that follow from the sealed secret and the chain beacon', () => {
        const { roll, beacon } = rollRecord([20, 20, 6]);
        const v = verifyRoll(roll, beacon);
        assert.ok(v.ok, JSON.stringify(v.checks));
        assert.deepEqual(v.checks.map((c) => c.name), ['commitment', 'beacon', 'dice']);
    });

    it('rejects a changed die, a different beacon, a secret that was not sealed, and a pruned beacon', () => {
        const die = rollRecord([20, 6], (r) => (r.resolved!.dice[1].value = (r.resolved!.dice[1].value % 6) + 1));
        assert.equal(verifyRoll(die.roll, die.beacon).checks.find((c) => c.name === 'dice')!.ok, false);
        const b = rollRecord([20]);
        assert.equal(verifyRoll(b.roll, { height: 50, value: 'ff'.repeat(32) }).ok, false);
        const s = rollRecord([20], (r) => (r.resolved!.secret = '04'.repeat(32)));
        assert.equal(verifyRoll(s.roll, s.beacon).checks.find((c) => c.name === 'commitment')!.ok, false);
        assert.equal(verifyRoll(b.roll, null).ok, false);
    });

    it('checks a forfeit against the forfeit rule', () => {
        const { roll } = rollRecord([20]);
        roll.resolved = { ...roll.resolved!, outcome: 'forfeited', secret: null, beacon: null, dice: [{ sides: 20, value: 1, owner: 'pc' }, { sides: 6, value: 6, owner: 'npc' }] };
        assert.ok(verifyRoll(roll, null).ok);
        roll.resolved.dice[0].value = 2;
        assert.equal(verifyRoll(roll, null).ok, false);
    });
});

describe('encoding', () => {
    it('drops proto3 defaults so signed bytes match the core', () => {
        assert.deepEqual(omitDefaults({ a: 0, b: '', c: false, d: new Uint8Array(), e: [], f: 1, g: 'x', h: true }), { f: 1, g: 'x', h: true });
    });

    it('maps intents to MessageAct fields the plugin parses back', () => {
        assert.deepEqual(intentFields({ kind: 'attack', target: 2 }), { kind: 'attack', target: '2', itemId: undefined });
        assert.deepEqual(intentFields({ kind: 'move', to: 3 }), { kind: 'move', toRoom: 3 });
        assert.deepEqual(intentFields({ kind: 'move', to: { level: 2, room: 0 } }), { kind: 'move', toLevel: 2, toRoom: 0 });
        assert.deepEqual(intentFields({ kind: 'ability', ability: 'magic_missile', target: 0 }), { kind: 'ability', ability: 'magic_missile', target: '0' });
    });

    it('decodes a plugin event as the core RPC returns it (captured from the localnet)', () => {
        const e = decodeEvent({
            eventType: 'abbey.FaucetClaimed',
            msg: { orderId: '0a24747970652e676f6f676c65617069732e636f6d2f74797065732e41626265794576656e74125c0a0d466175636574436c61696d6564124b7b2261646472657373223a2239656362343630323830303162646263323934623936333737343663383664623464353464336231222c22616d6f756e74223a22313030303030303030227d' },
            height: 13,
            reference: '7ac3e3056f0c68c2ba60968314ccd7e778c83a38edd2462b502e0a69c8f9db0c',
            address: '9ecb46028001bdbc294b9637746c86db4d54d3b1'
        });
        assert.deepEqual(e, { kind: 'FaucetClaimed', height: 13, address: '9ecb46028001bdbc294b9637746c86db4d54d3b1', txHash: '7ac3e3056f0c68c2ba60968314ccd7e778c83a38edd2462b502e0a69c8f9db0c', data: { address: '9ecb46028001bdbc294b9637746c86db4d54d3b1', amount: '100000000' } });
        assert.equal(decodeEvent({ eventType: 'reward', msg: {} }), null);
    });

    it('formats µGOLD exactly', () => {
        assert.deepEqual([gold('100000000'), gold(99_970_000n), gold('1')], ['100', '99.97', '0.000001']);
    });
});

describe('narration', () => {
    it('tells an exchange from the engine events, naming the character and the monster', () => {
        const me = newCharacter(content, 'aa', 'owner', 'Aria', 'cleric');
        assignStats(content, me, [14, 14, 14, 14, 14, 14], [0, 1, 2, 3, 4, 5]);
        enterDungeon(content, me);
        me.room = 2;
        me.prevRoom = 1;
        me.lastActionHeight = 100;
        const rooms: Scene['rooms'] = {};
        for (const r of content.levels.get(1)!.def.rooms) rooms[r.id] = initialRoom(content, 1, r.id);
        const scene: Scene = { height: 100, level: newSeason(content, 1, 1, 0, 1_000_000), rooms, chars: { aa: me }, activeLevels: [1] };
        const res = resolve(content, scene, 'aa', { kind: 'attack', target: 0 }, new SeededDice(new Uint8Array(32)), () => 'id');
        assert.ok(res.ok);
        const lines = narrate(res.events, castOf(me, [], [scene.rooms[2]]));
        assert.match(lines[0], /^Aria attacks the Skeleton: d20 \d+, \d+ vs AC 13: (hit|miss)\.$/);
        assert.ok(lines.some((l) => /^The Skeleton attacks Aria/.test(l)));
        // tagged: attacks are rolls, toned from the player's side (my hit is good, their hit on me is bad)
        const told = tell(res.events, castOf(me, [], [scene.rooms[2]]));
        const mine = told.find((t) => /^Aria attacks/.test(t.text))!;
        assert.equal(mine.kind, 'roll');
        assert.equal(mine.tone, /: hit\.$/.test(mine.text) ? 'good' : 'bad');
        const theirs = told.find((t) => /^The Skeleton attacks Aria/.test(t.text))!;
        assert.equal(theirs.tone, /: hit\.$/.test(theirs.text) ? 'bad' : 'good');
        for (const t of told.filter((x) => /damage/.test(x.text))) assert.equal(t.kind, 'effect');
    });

    /** Aria the cleric, delving in a room, with every room of level 1 loaded. */
    function delver(room: number) {
        const me = newCharacter(content, 'aa', 'owner', 'Aria', 'cleric');
        assignStats(content, me, [14, 14, 14, 14, 14, 14], [0, 1, 2, 3, 4, 5]);
        enterDungeon(content, me);
        me.room = room;
        me.lastActionHeight = 100;
        const rooms: Scene['rooms'] = {};
        for (const r of content.levels.get(1)!.def.rooms) rooms[r.id] = initialRoom(content, 1, r.id);
        const scene: Scene = { height: 100, level: newSeason(content, 1, 1, 0, 1_000_000), rooms, chars: { aa: me }, activeLevels: [1] };
        return { me, scene };
    }

    it('an ambush is told in the room you walked into, with the initiative dice on the math line', () => {
        const { me, scene } = delver(1);
        const res = resolve(content, scene, 'aa', { kind: 'move', to: 2 }, new FixedDice([2, 19, 15, 3]), () => 'id'); // they win; a hit for 3 + 2
        assert.ok(res.ok);
        assert.equal(arrival(res.events, 'aa'), 2);
        const r = recount({ kind: 'move', to: 2 }, res.events, castOf(me, [], [scene.rooms[2]]), 'cleric', res.dice, me.maxHp);
        const story = r.story.map((x) => x.text);
        assert.ok(story.some((t) => /^The Skeleton was waiting: it strikes as Aria steps in!$/.test(t)), story.join(' | '));
        assert.ok(story.some((t) => /^The Skeleton's .+ Aria \(5, \d+ HP left\)\.$/.test(t)), story.join(' | '));
        assert.match(r.math[0].text, /^Initiative: Aria d20 2 \+ 2 = 4 vs the Skeleton d20 19 \+ 0 = 19: failure$/);
    });

    it('disadvantage: both dice are shown as one pair with the lower kept, and a failed sneak is told as an attempt', () => {
        const { me, scene } = delver(2); // the Ossuary: sneaking past its skeletons is DEX DC 14 at disadvantage
        const intent = { kind: 'action', actionId: 'ossuary.sneak_scriptorium' } as const;
        const res = resolve(content, scene, 'aa', intent, new FixedDice([18, 1, 2]), () => 'id'); // 18 and 1: the 1 counts; the skeleton misses
        assert.ok(res.ok);
        const groups = groupDice(res.dice, res.events);
        assert.deepEqual(groups[0], { owner: 'pc', sides: 20, values: [18, 1], kept: 1, edge: 'disadvantage', by: 'aa', won: false, purpose: 'check', ability: 'DEX' });
        assert.deepEqual(groups[1], { owner: 'npc', sides: 20, values: [2], kept: 0, edge: undefined, by: 'm0', won: false, purpose: 'attack' }); // the skeleton's swing, a miss
        const r = recount(intent, res.events, castOf(me, [], [scene.rooms[2]]), 'cleric', res.dice, me.maxHp);
        assert.equal(r.story[0].text, 'Aria tries to sneak past to the Scriptorium, but fails.');
        assert.deepEqual(groups.map((x) => purposeOf(x, intent)), ['sneak', 'attack', 'damage'].slice(0, groups.length));
        assert.match(r.math[0].text, /d20 DIS \[18, 1\] → 1/);
        // a tie can't say which way it went from the faces; the menu's hint does
        assert.equal(groupDice([{ owner: 'pc', sides: 20, value: 7 }, { owner: 'pc', sides: 20, value: 7 }], [{ t: 'check', char: 'aa', ability: 'DEX', d20: [7, 7], kept: 7, mod: 0, total: 7, dc: 14, success: false }], 'disadvantage')[0].edge, 'disadvantage');
    });

    it('every die is tied to who rolled it and whether it won: initiative, the blow, and its damage', () => {
        const { scene } = delver(1);
        const res = resolve(content, scene, 'aa', { kind: 'move', to: 2 }, new FixedDice([2, 19, 15, 3]), () => 'id'); // they win; a hit for 3 + 2
        assert.ok(res.ok);
        const g = groupDice(res.dice, res.events).map((x) => [x.by, purposeOf(x, { kind: 'move', to: 2 }), x.values.join(','), x.won]);
        assert.deepEqual(g, [['aa', 'initiative', '2', false], ['m0', 'initiative', '19', true], ['m0', 'attack', '15', true], ['m0', 'damage', '3', undefined]]);
    });

    it('a quick monster strikes before your action, and the story tells it in that order', () => {
        const { me, scene } = delver(5); // the giant rats' room
        const res = resolve(content, scene, 'aa', { kind: 'attack', target: 0 }, new FixedDice([2, 2]), () => 'id'); // both miss
        assert.ok(res.ok);
        const r = recount({ kind: 'attack', target: 0 }, res.events, castOf(me, [], [scene.rooms[5]]), 'cleric', res.dice, me.maxHp);
        const story = r.story.map((x) => x.text);
        assert.equal(story.length, 3, story.join(' | '));
        assert.match(story[0], /^The Giant Rat darts in before Aria can act!$/);
        assert.match(story[1], /^The Giant Rat's .+ misses\.$/);
        assert.match(story[2], /^Aria swings an? .+ at the Giant Rat, but misses\.$/);
    });
});

describe('party narration', () => {
    it('tells every character by name, and tones by whose side they are on', async () => {
        const { recount, thirdPerson } = await import('../src/lib/recount.ts');
        const tess = newCharacter(content, 'aa', 'owner', 'Tess', 'fighter');
        const wren = newCharacter(content, 'bb', 'owner', 'Wren', 'rogue');
        const rooms: Scene['rooms'] = {};
        for (const r of content.levels.get(1)!.def.rooms) rooms[r.id] = initialRoom(content, 1, r.id);
        tess.room = wren.room = 2;
        const hit = [{ t: 'attack', attacker: 'm0', target: 'bb', d20: [15], kept: 15, total: 17, ac: 15, hit: true }, { t: 'damage', target: 'bb', amount: 4, hp: 16 }] as never[];
        // Wren is in Tess's party: the skeleton hitting her is bad news, with her HP left
        const party = recount({ kind: 'rest' }, hit, castOf(tess, [wren], [rooms[2]], ['aa', 'bb']), 'fighter', [], tess.maxHp);
        assert.equal(party.story.at(-1)!.tone, 'bad');
        assert.match(party.story.at(-1)!.text, /Wren \(4, 16 HP left\)\.$/);
        // a stranger's Wren: told plainly
        const solo = recount({ kind: 'rest' }, hit, castOf(tess, [wren], [rooms[2]]), 'fighter', [], tess.maxHp);
        assert.equal(solo.story.at(-1)!.tone, '');
        assert.deepEqual(['search', 'pry', 'parley', 'cross', 'wade', 'smash'].map(thirdPerson), ['searches', 'pries', 'parleys', 'crosses', 'wades', 'smashes']);
    });
});

describe('wandering monsters', () => {
    it("the dice that pick a wandering monster aren't its damage", async () => {
        const { recount } = await import('../src/lib/recount.ts');
        const tess = newCharacter(content, 'aa', 'owner', 'Tess', 'fighter');
        tess.room = 1;
        const rooms: Scene['rooms'] = {};
        for (const r of content.levels.get(1)!.def.rooms) rooms[r.id] = initialRoom(content, 1, r.id);
        const dice = [{ owner: 'pc', sides: 8, value: 4 }, { owner: 'npc', sides: 4, value: 4 }, { owner: 'npc', sides: 2, value: 2 }, { owner: 'npc', sides: 20, value: 13 }, { owner: 'npc', sides: 6, value: 2 }] as never[];
        const events = [
            { t: 'heal', target: 'aa', amount: 6, hp: 26 },
            { t: 'spawn', room: 1, index: 0, template: 'skeleton' },
            { t: 'attack', attacker: 'm0', target: 'aa', d20: [13], kept: 13, total: 17, ac: 16, hit: true },
            { t: 'damage', target: 'aa', amount: 4, hp: 22 }
        ] as never[];
        assert.deepEqual(groupDice(dice, events).map((g) => g.purpose), ['heal', 'wandering', 'wandering', 'attack', 'damage']);
        const r = recount({ kind: 'rest' }, events, castOf(tess, [], [rooms[1]]), 'fighter', dice, tess.maxHp);
        assert.equal(r.math.at(-1)!.text, "foes' damage d6 2 → 4");
    });
});

describe('shared work', () => {
    it("tells the rubble's progress from the room counter, and what clearing it opens", async () => {
        const { roomProgress, progressMade, describeProgress } = await import('../src/lib/progress.ts');
        const l1 = content.levels.get(1)!.def;
        const rs = initialRoom(content, 1, 5); // the Collapsed Cloister
        const [job] = roomProgress(l1, rs);
        assert.deepEqual([job.actionId, job.value, job.goal, job.opens], ['cloister.clear_rubble', 0, 2, 8]);
        rs.counters.rubble = 1;
        assert.equal(describeProgress(roomProgress(l1, rs)[0]), 'Clear the rubble on the east walk: 1 of 2 done (anyone\'s success counts).');
        const done = progressMade(l1, [{ t: 'counter', room: 5, counter: 'rubble', value: 2 }] as never[]);
        assert.equal(describeProgress(done[0]), 'Clear the rubble on the east walk: done. The way to the Kitchens & Cellar is open.');
        // counters that aren't a job (the Abbot's wail count) are left alone
        assert.deepEqual(progressMade(l1, [{ t: 'counter', room: 12, counter: 'wail', value: 3 }] as never[]), []);
    });
});

describe('map', () => {
    it('shows visited rooms, the doors seen from them, and hides a secret door until both sides are known', () => {
        const l1 = content.levels.get(1)!.def;
        const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
        const start = drawMap(l1, new Set([1]), 1).map(plain).join('\n');
        assert.match(start, /\[@N\]/);
        assert.equal((start.match(/\[\?\?\]/g) ?? []).length, 3); // the Lychgate, the Ossuary, the Chapel
        const deep = drawMap(l1, new Set([1, 3, 6, 7]), 7).map(plain).join('\n');
        assert.ok(!deep.includes('SA'), 'the Sacristy door is hidden until it has been used');
        assert.ok(drawMap(l1, new Set([7, 10]), 10).map(plain).join('\n').includes('[@S]'));
    });
});

describe('remembered passphrases', () => {
    it('the file store round-trips owner-only, and ABBEY_KEYCHAIN picks the store', async () => {
        const { FileStore, MacKeychain, secretStore } = await import('../src/lib/keychain.ts');
        const dir = tmp();
        const f = new FileStore(dir);
        assert.equal(f.get(dir), null);
        f.set(dir, 'remembered');
        assert.equal(f.get(dir), 'remembered');
        assert.equal(statSync(join(dir, 'passphrase')).mode & 0o777, 0o600);
        f.delete(dir);
        assert.equal(f.get(dir), null);
        assert.ok(secretStore(dir, 'file') instanceof FileStore);
        assert.ok(secretStore(dir, 'mac') instanceof MacKeychain);
    });

    it('the macOS Keychain round-trips (opt-in: ABBEY_TEST_KEYCHAIN=1, writes one item and removes it)', { skip: process.env.ABBEY_TEST_KEYCHAIN !== '1' || process.platform !== 'darwin' }, async () => {
        const { MacKeychain } = await import('../src/lib/keychain.ts');
        const k = new MacKeychain();
        const account = join(tmp(), 'keychain-test');
        k.set(account, 'first');
        k.set(account, 'second'); // -U updates in place
        assert.equal(k.get(account), 'second');
        k.delete(account);
        assert.equal(k.get(account), null);
    });
});

describe('passkey accounts', () => {
    it('derive one fixed key per PRF output: the same on every device, different for another passkey', async () => {
        const { keyFromPrf, PRF_SALT } = await import('../src/web/passkey.ts');
        const prf = new Uint8Array(32).fill(42);
        const a = keyFromPrf(prf);
        assert.deepEqual(keyFromPrf(new Uint8Array(32).fill(42)), a);
        assert.notEqual(keyFromPrf(new Uint8Array(32).fill(43)).address, a.address);
        assert.match(a.privateKey, /^[0-9a-f]{64}$/);
        assert.match(a.address, /^[0-9a-f]{40}$/);
        // pinned: changing the salt or the derivation would move every passkey account to a new address
        assert.equal(bytesToHex(PRF_SALT), 'da520836f9db8d47df33553627be9defec72869f268767b3427c95f83ef126c7');
        assert.equal(a.address, 'b0e2df6dc5333c382ec36c765a741feddd93b4fc');
    });
});

describe('send', () => {
    it('a submission refused because an earlier attempt already landed counts as done', async () => {
        const { Session } = await import('../src/lib/session.ts');
        const net = {
            abbey: async () => ({ params: { fees: {} } }),
            sendFee: async () => 10_000n,
            submit: async () => {
                throw new Error('{"code":100,"msg":"abbey: roll already resolved"}');
            }
        } as unknown as import('../src/lib/net.ts').Net;
        const signer = { key: { address: '00'.repeat(20), publicKey: '', privateKey: '' }, saveSecret() {}, secret: () => null, dropSecret() {}, pending: () => [] };
        const s = new Session(net, signer);
        assert.equal(await s.send('reveal', {}, async () => true), '');
        await assert.rejects(s.send('reveal', {}, async () => false), /roll already resolved/);
    });
});

describe('round recap', () => {
    it('tells a round as story sentences, with the math on one line', async () => {
        const { recount, blow, condition } = await import('../src/lib/recount.ts');
        const me = newCharacter(content, 'aa', 'owner', 'Tess', 'fighter');
        assignStats(content, me, [14, 14, 14, 14, 14, 14], [0, 1, 2, 3, 4, 5]);
        enterDungeon(content, me);
        me.room = 2;
        const rooms: Scene['rooms'] = {};
        for (const r of content.levels.get(1)!.def.rooms) rooms[r.id] = initialRoom(content, 1, r.id);
        const cast = castOf(me, [], [rooms[2]]);
        const events = [
            { t: 'attack', attacker: 'aa', target: 'm0', d20: [14], kept: 14, total: 19, ac: 13, hit: true },
            { t: 'damage', target: 'm0', amount: 10, hp: 3 },
            { t: 'attack', attacker: 'm0', target: 'aa', d20: [6], kept: 6, total: 10, ac: 16, hit: false }
        ] as never[];
        const r = recount({ kind: 'attack', target: 0 }, events, cast, 'fighter', [{ sides: 20, value: 14, owner: 'pc' }, { sides: 8, value: 7, owner: 'pc' }, { sides: 20, value: 6, owner: 'npc' }], me.maxHp);
        assert.deepEqual(r.story.map((x) => x.text), [
            'Tess swings a longsword at the Skeleton and devastates it (10).',
            "The Skeleton's rusted blade swings at Tess and misses."
        ]);
        assert.deepEqual(r.story.map((x) => x.tone), ['good', 'good']);
        assert.deepEqual(r.math.map((x) => x.text), ['Tess attacks the Skeleton: d20 14, 19 vs AC 13: hit', 'The Skeleton attacks Tess: d20 6, 10 vs AC 16: miss', "Tess's damage d8 7 → 10"]);
        assert.deepEqual([blow(1, 13)[0], blow(3, 13)[0], blow(5, 13)[0], blow(7, 13)[0], blow(10, 13)[0]], ['graze', 'hit', 'wound', 'maul', 'devastate']);
        assert.deepEqual([condition(13, 13), condition(11, 13), condition(7, 13), condition(4, 13), condition(2, 13), condition(0, 13)], ['unhurt', 'scratched', 'wounded', 'badly wounded', 'barely standing', 'down']);
    });
});
