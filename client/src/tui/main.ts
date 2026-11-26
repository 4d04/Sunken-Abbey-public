/*
 * The Drowned Abbey, in a terminal (M3). Run against the localnet: npm run play
 * Flags: --export-key (print the key for backup), --import-key (restore one into a new profile), --forget (stop
 * remembering the passphrase). Env: ABBEY_PROFILE (default "default"), ABBEY_HOME (~/.abbey), ABBEY_PASSPHRASE (scripts),
 * ABBEY_KEYCHAIN (mac | secret-service | file), ABBEY_RPC, ABBEY_PLUGIN_RPC, ABBEY_CHAIN_ID, NO_COLOR, ABBEY_NO_ANIM.
 * Piped stdin works too (each line answers one prompt).
 */

import { randomBytes } from 'node:crypto';
import { ABILITIES, type Character, DOWNED_BLOCKS, LIE_LOW_BLOCKS, REVEAL_SECONDS, abilityMod, charAC, secondsFor } from '@abbey/rules';
import { groupDice } from '../lib/dicelog.ts';
import { describeProgress, progressMade } from '../lib/progress.ts';
import { TEXT, type Told, arrival, castOf, purposeOf, describeIntent, human, itemName, monsterName, roomTitle, tell } from '../lib/narrate.ts';
import { HttpError, Net, endpointsFromEnv } from '../lib/net.ts';
import { type Account, type OnProgress, type Outcome, type RollRecord, GameError, Session as LibSession, content, gold } from '../lib/session.ts';
import { FileStore, type SecretStore, secretStore } from '../lib/keychain.ts';
import { Vault, WrongPassphrase, profileDir } from '../lib/vault.ts';
import { verifyRoll } from '../lib/verify.ts';
import { type Tone, FeedTeller } from '../lib/feed.ts';
import { assignmentFrom, suggestAssignment } from '../lib/stats.ts';
import { drawMap } from './map.ts';
import { Ui, bar, c, rollAnimation } from './ui.ts';

/** The terminal's session: the Node vault, which also keeps client state (visited rooms, feed position). */
type Session = LibSession<Vault>;
const Session = LibSession<Vault>;

const ui = new Ui();
const L1 = content.levels.get(1)!.def;
const CAMP = L1.camp ?? 0;

class Quit extends Error {}

async function main(): Promise<void> {
    ui.print(c.bold(`\n  ${TEXT.level.title}`));
    ui.print(c.dim(`  ${TEXT.level.intro}\n`));
    const s = await boot();
    process.on('SIGINT', () => {
        // the secrets are on disk, so a sealed roll can still be revealed: say how long the player has
        const open = s.vault.pending();
        if (open.length) ui.print(c.yellow(`\n  ${open.length} roll(s) still sealed. Start the client again within ~${REVEAL_SECONDS}s to reveal them, or they are forfeited.`));
        ui.print(c.dim('\n  Farewell.'));
        process.exit(130);
    });
    const resumed = await s.resumePending(progress());
    for (const roll of resumed.revealed) {
        const rec = await s.character(roll.charId);
        if (!rec) continue;
        ui.print(c.green(`  ${rec.char.name}'s roll from your last session, revealed before it lapsed:`));
        if (roll.kind === 'act') await showResolution(s, rec.char, roll);
    }
    if ((await s.balance()) === 0n) {
        ui.print('  Your purse is empty. The abbey\'s charity box is free to claim…');
        await s.claimFaucet();
        ui.print(c.green(`  Claimed. Wallet: ${gold(await s.balance())}g`));
    }
    for (;;) {
        const charId = await pickCharacter(s);
        await play(s, charId);
    }
}

// ---------------------------------------------------------------- profile

async function boot(): Promise<Session> {
    const dir = profileDir();
    const net = new Net(endpointsFromEnv());
    const store = secretStore(dir);
    const flag = (f: string) => process.argv.includes(f);
    if (flag('--forget')) {
        if (!store.get(dir)) {
            ui.print(`  Nothing is remembered for ${dir}.`);
            throw new Quit();
        }
        ui.print(c.yellow(`  If this profile was created without you choosing a passphrase, nobody knows it but ${store.name}:`));
        ui.print(c.yellow('  forgetting it locks the account for good unless you have exported the key (--export-key).'));
        const a = await ui.ask('  Type "forget" to go ahead: ');
        if (a === 'forget') {
            store.delete(dir);
            ui.print(`  Forgot the passphrase for ${dir}.`);
        }
        throw new Quit();
    }
    const vault = Vault.exists(dir) ? await unlock(dir, store) : await createProfile(dir, store, flag('--import-key'));
    if (flag('--export-key')) {
        ui.print(c.yellow(`\n  Private key for ${vault.key.address} (anyone with it controls this account):`));
        ui.print(`  ${vault.key.privateKey}`);
        ui.print(c.dim(`  Restore it on another machine with: npm run play -- --import-key`));
        throw new Quit();
    }
    try {
        await net.height();
    } catch (e) {
        throw new Error(`can't reach the chain at ${net.ep.rpc} (${(e as Error).message}). Is the localnet running? See plugin/M2-REPORT.md, "Re-run".`);
    }
    if (!(await net.abbey('/abbey/levels'))) throw new Error(`can't reach the game at ${net.ep.plugin}`);
    return new Session(net, vault);
}

/** Open a profile: the remembered passphrase if there is one, otherwise ask (and offer to remember it). */
async function unlock(dir: string, store: SecretStore): Promise<Vault> {
    ui.print(c.dim(`  Profile ${dir} · ${Vault.address(dir)}`));
    const env = process.env.ABBEY_PASSPHRASE;
    const remembered = env === undefined ? store.get(dir) : null;
    for (const pass of [env, remembered]) {
        if (pass == null) continue;
        try {
            return Vault.open(dir, pass);
        } catch (e) {
            if (!(e instanceof WrongPassphrase) || env !== undefined) throw e;
            store.delete(dir);
            ui.print(c.yellow(`  The passphrase remembered in ${store.name} no longer opens this profile.`));
        }
    }
    for (;;) {
        const pass = await ui.askHidden('  Passphrase: ');
        if (pass === null) throw new Quit();
        let vault: Vault;
        try {
            vault = Vault.open(dir, pass);
        } catch (e) {
            if (!(e instanceof WrongPassphrase)) throw e;
            ui.print(c.red('  Wrong passphrase.'));
            continue;
        }
        const a = await ui.ask(`  Remember it in ${store.name}, so you're not asked again? [Y/n] `);
        if (a !== null && !/^n/i.test(a)) {
            rememberIn(store, dir, pass);
            ui.print(c.dim(`  Remembered. To be asked again: npm run play -- --forget`));
        }
        return vault;
    }
}

/**
 * A new profile with no prompts: a strong random passphrase encrypts the key and is remembered in the keychain, so
 * the player only ever presses play. (ABBEY_PASSPHRASE sets one instead, for scripts.) --import-key restores a key.
 */
async function createProfile(dir: string, store: SecretStore, importKey: boolean): Promise<Vault> {
    let priv: string | undefined;
    if (importKey) {
        const a = await ui.askHidden('  Private key to import (hex): ');
        if (!a || !/^[0-9a-f]{64}$/i.test(a.trim())) throw new Error('that is not a 32-byte hex private key');
        priv = a.trim().toLowerCase();
    }
    const env = process.env.ABBEY_PASSPHRASE;
    const pass = env ?? randomBytes(32).toString('hex');
    const vault = Vault.create(dir, pass, priv);
    const where = env === undefined ? rememberIn(store, dir, pass) : null;
    ui.print(c.green(`  ${priv ? 'Imported' : 'Created'} your account ${vault.key.address}.`));
    if (where) ui.print(c.dim(`  It unlocks automatically from ${where}. Back it up any time with: npm run play -- --export-key`));
    return vault;
}

/** Remember a passphrase; if the keychain refuses, fall back to an owner-only file. Returns where it went. */
function rememberIn(store: SecretStore, dir: string, pass: string): string {
    try {
        store.set(dir, pass);
        if (store.get(dir) === pass) return store.name;
    } catch {
        // fall through
    }
    const file = new FileStore(dir);
    file.set(dir, pass);
    return file.name;
}

// ---------------------------------------------------------------- characters

async function pickCharacter(s: Session): Promise<string> {
    const acct = await s.account();
    const living = acct.characters.filter((ch) => ch.status !== 'dead');
    ui.print(c.bold('\n  Your delvers'));
    const items = living.map((ch) => `${ch.name}, ${ch.classId} · ${ch.status === 'delving' || ch.status === 'downed' ? `${ch.status} in the ${roomTitle(ch.room)}` : ch.status}`);
    items.forEach((t, i) => ui.print(`   ${i + 1}) ${t}`));
    ui.print(`   n) New character   q) Quit`);
    const pick = await ui.choose('  > ', items, ['n', 'q']);
    if (pick === null || pick === 'q') throw new Quit();
    if (pick === 'n') return createCharacter(s);
    return living[pick as number].id;
}

const CLASS_BLURB: Record<string, string> = {
    fighter: 'sturdy, hits hard; Second Wind heals once a delve',
    rogue: 'quick and sly; sneak attacks when an ally is close',
    cleric: 'Heal ×3 and Turn Undead; wise and steady',
    wizard: 'fragile, but Magic Missile ×3 never misses'
};

async function createCharacter(s: Session): Promise<string> {
    let name = '';
    while (!name) {
        const a = await ui.ask('  Name: ');
        if (a === null) throw new Quit();
        name = a.slice(0, 24);
    }
    const classes = Object.keys(content.registry.classes);
    classes.forEach((k, i) => {
        const cls = content.registry.classes[k];
        ui.print(`   ${i + 1}) ${human(k).padEnd(8)} HP ${cls.hpBase}, AC ${cls.ac}: ${CLASS_BLURB[k] ?? ''}`);
    });
    const ci = await ui.choose('  Class: ', classes);
    if (ci === null || typeof ci === 'string') throw new Quit();
    const classId = classes[ci];
    ui.print(c.dim('  Rolling 4d6-drop-lowest six times, sealed before the dice exist…'));
    const { charId, rolled } = await s.createCharacter(name, classId, progress());
    await assignFlow(s, charId, classId, rolled);
    ui.print(c.green(`  ${name} the ${classId} is ready at the Lychgate.`));
    return charId;
}

/** Show the rolled scores, suggest an assignment for the class, and let the player reorder them. */
async function assignFlow(s: Session, charId: string, classId: string, rolled: number[]): Promise<void> {
    ui.print(`  Rolled: ${rolled.map((v) => c.bold(String(v))).join('  ')}`);
    const suggested = suggestAssignment(classId, rolled);
    ui.print(`  Suggested for a ${classId}: ${ABILITIES.map((ab, i) => `${ab} ${rolled[suggested[i]]}`).join(' · ')}`);
    let perm = suggested;
    const a = await ui.ask('  Enter to accept, or give the six scores in STR DEX CON INT WIS CHA order: ');
    if (a) {
        const p = assignmentFrom(rolled, a.split(/[\s,]+/).map(Number));
        if (p) perm = p;
        else ui.print(c.yellow('  That isn\'t a reordering of the rolled scores; using the suggestion.'));
    }
    await s.assignStats(charId, perm);
}

// ---------------------------------------------------------------- play loop

async function play(s: Session, charId: string): Promise<void> {
    let lastRoll: RollRecord | null = null;
    const feed = new Feed(s, charId);
    for (;;) {
        const rec = await s.character(charId);
        if (!rec) return;
        const ch = rec.char;
        if (ch.status === 'rolling') {
            if (rec.pending) await s.revealRoll(rec.pending, progress());
            const rolled = (await s.character(charId))?.rolled;
            if (!rolled) return;
            ui.print(c.yellow(`  ${ch.name} still needs their scores assigned.`));
            await assignFlow(s, charId, ch.classId, rolled);
            continue;
        }
        if (ch.status === 'camp') {
            if (!(await campMenu(s, ch))) return;
            continue;
        }
        if (ch.status === 'dead') return;
        if (rec.pending) {
            ui.print(c.dim('  A roll is still sealed; revealing it…'));
            lastRoll = await showResolution(s, ch, await s.revealRoll(rec.pending, progress()));
            continue;
        }
        const next = await dungeon(s, ch, feed, lastRoll);
        if (next === 'leave') return;
        if (next && typeof next === 'object') lastRoll = next;
    }
}

async function campMenu(s: Session, ch: Character): Promise<boolean> {
    const acct = await s.account();
    const wallet = await s.balance();
    ui.print(c.bold(`\n── ${roomTitle(CAMP)} · camp ${'─'.repeat(30)}`));
    ui.print(c.dim(`  ${TEXT.rooms.lychgate.prose}`));
    ui.print(`  ${ch.name} the ${ch.classId} · HP ${ch.hp}/${ch.maxHp} · wallet ${c.yellow(`${gold(wallet)}g`)} · pack ${ch.inventory.length} · stash ${acct.stash.length}`);
    const items = ['Enter the abbey', 'Shop', 'Sell an item', 'Pack ↔ stash', 'Character sheet', 'Switch character'];
    items.forEach((t, i) => ui.print(`   ${i + 1}) ${t}`));
    ui.print('   q) Quit');
    const pick = await ui.choose('  > ', items, ['q']);
    if (pick === null || pick === 'q') throw new Quit();
    await guard(async () => {
        switch (pick) {
            case 0:
                await s.enter(ch.id);
                ui.print(c.dim(`  You wade into the ${roomTitle(L1.entry)}.`));
                break;
            case 1:
                await shop(s, ch);
                break;
            case 2:
                await sell(s, ch);
                break;
            case 3:
                await stash(s, ch, acct);
                break;
            case 4:
                sheet(ch, wallet);
                break;
        }
    });
    return pick !== 5;
}

async function shop(s: Session, ch: Character): Promise<void> {
    const wares = Object.entries(content.registry.items).filter(([, it]) => typeof it.price === 'number');
    wares.forEach(([id, it], i) => ui.print(`   ${i + 1}) ${itemName(id).padEnd(16)} ${it.price}g`));
    const pick = await ui.choose('  Buy which (b to go back): ', wares.map(([id]) => id), ['b']);
    if (pick === null || typeof pick === 'string') return;
    const qty = Number((await ui.ask('  How many? [1] ')) || 1);
    ui.status(c.dim('  Paying the trader…'));
    await s.shopBuy(ch.id, wares[pick][0], Math.max(1, Math.min(8, qty || 1)));
    ui.endStatus();
    ui.print(c.green(`  Bought. Wallet: ${gold(await s.balance())}g`));
}

async function sell(s: Session, ch: Character): Promise<void> {
    if (!ch.inventory.length) return ui.print(c.dim('  Your pack is empty.'));
    ch.inventory.forEach((it, i) => ui.print(`   ${i + 1}) ${itemName(it.template)}${it.escrow ? ` (${it.escrow}g)` : ' (worthless to the trader)'}`));
    const pick = await ui.choose('  Sell which (b to go back): ', ch.inventory.map((i) => i.id), ['b']);
    if (pick === null || typeof pick === 'string') return;
    await s.shopSell(ch.id, ch.inventory[pick].id);
    ui.print(c.green(`  Sold. Wallet: ${gold(await s.balance())}g`));
}

async function stash(s: Session, ch: Character, acct: Account): Promise<void> {
    const rows = [...ch.inventory.map((it) => ({ it, toStash: true })), ...acct.stash.map((it) => ({ it, toStash: false }))];
    if (!rows.length) return ui.print(c.dim('  Nothing in your pack or stash.'));
    rows.forEach((r, i) => ui.print(`   ${i + 1}) ${r.toStash ? 'pack → stash' : 'stash → pack'}: ${itemName(r.it.template)}`));
    const pick = await ui.choose('  Move which (b to go back): ', rows.map((r) => r.it.id), ['b']);
    if (pick === null || typeof pick === 'string') return;
    await s.stashMove(ch.id, rows[pick].it.id, rows[pick].toStash);
    ui.print(c.green('  Moved.'));
}

function sheet(ch: Character, wallet: bigint): void {
    ui.print(c.bold(`\n  ${ch.name}, ${ch.classId}`));
    ui.print(`  HP ${ch.hp}/${ch.maxHp} · AC ${charAC(content, ch)} · hit dice ${ch.hitDice}${ch.rested ? ' · rested' : ''}`);
    ui.print(`  ${ABILITIES.map((ab, i) => `${ab} ${ch.stats[i]} (${abilityMod(ch.stats[i]) >= 0 ? '+' : ''}${abilityMod(ch.stats[i])})`).join(' · ')}`);
    const abil = Object.entries(ch.abilityUses).filter(([, n]) => n > 0);
    if (abil.length) ui.print(`  Abilities: ${abil.map(([k, n]) => `${human(k)} ×${n}`).join(', ')}`);
    if (ch.statuses.length) ui.print(`  Conditions: ${ch.statuses.map((st) => `${human(st.id)} (${st.charges})`).join(', ')}`);
    ui.print(`  Pack: ${ch.inventory.length ? ch.inventory.map((i) => itemName(i.template)).join(', ') : 'empty'}`);
    ui.print(`  Carried gold ${c.yellow(`${ch.carriedGold}g`)} (lost to the Ferryman or the flood unless you extract) · wallet ${c.yellow(`${gold(wallet)}g`)}`);
}

// ---------------------------------------------------------------- the dungeon

async function dungeon(s: Session, ch: Character, feed: Feed, lastRoll: RollRecord | null): Promise<RollRecord | 'leave' | null> {
    const [{ room, characters }, opts, h] = await Promise.all([s.room(ch.levelId, ch.room), s.options(ch.id), s.net.height()]);
    const others = characters.filter((o) => o.id !== ch.id);
    const cast = castOf(ch, others, [room]);
    const key = L1.rooms.find((r) => r.id === ch.room)?.key ?? '';
    feed.visit(ch.room);
    ui.print(c.bold(`\n── ${roomTitle(ch.room)} ${'─'.repeat(Math.max(4, 44 - roomTitle(ch.room).length))} block ${h - 1}`));
    ui.print(c.dim(`  ${TEXT.rooms[key]?.prose ?? ''}`));
    for (const [i, m] of room.monsters.entries()) {
        if (m.status === 'dead' || m.status === 'fled' || m.status === 'disguised') continue;
        const max = content.registry.monsters[m.template].hp;
        ui.print(`  ${c.red(monsterName(m.template).padEnd(16))} #${i + 1} ${bar(m.hp, max)} ${m.hp}/${max}${m.status === 'hostile' ? '' : c.dim(` (${m.status})`)}`);
    }
    if (room.pileGold || room.pile.length) ui.print(c.yellow(`  On the floor: ${[room.pileGold ? `${room.pileGold}g` : '', ...room.pile.map((i) => itemName(i.template))].filter(Boolean).join(', ')}`));
    if (room.corpses.length) ui.print(c.yellow(`  ${room.corpses.length} fallen delver's cache${room.corpses.length > 1 ? 's' : ''} lie here.`));
    const awake = others.filter((o) => o.status === 'delving' && h - o.lastActionHeight <= LIE_LOW_BLOCKS);
    const downed = others.filter((o) => o.status === 'downed');
    if (others.length) {
        const names = awake.slice(0, 5).map((o) => `${o.name} (${o.classId})`);
        const rest = others.length - names.length - downed.length;
        ui.print(`  Here: ${[...names, rest > 0 ? c.dim(`${rest} lying low`) : ''].filter(Boolean).join(', ')}${downed.length ? c.red(` · downed: ${downed.map((o) => o.name).join(', ')}`) : ''}`);
    }
    ui.print(`  ${c.bold(ch.name)} HP ${bar(ch.hp, ch.maxHp, 8)} ${ch.hp}/${ch.maxHp} · carried ${c.yellow(`${ch.carriedGold}g`)}${ch.statuses.length ? ` · ${ch.statuses.map((st) => human(st.id).toLowerCase()).join(', ')}` : ''}`);
    for (const line of await feed.lines()) ui.print(`  ${c.cyan('»')} ${line}`);

    if (ch.status === 'downed') {
        ui.print(c.red(`  You are downed. An ally can stabilize you; otherwise the Ferryman comes in ~${Math.max(0, Math.round(secondsFor(ch.downedAt + DOWNED_BLOCKS + 1 - h)))}s.`));
        const a = await ui.ask('  [enter] wait · q quit > ');
        if (a === null || a === 'q') throw new Quit();
        return null;
    }
    const intents = opts.options;
    const labels = intents.map((o) => {
        const odds = o.odds ? `${Math.round(o.odds.bp / 100)}%`.padStart(4) + c.dim(` ${o.odds.kind === 'attack' ? `vs AC ${o.odds.target}` : `DC ${o.odds.target}`}${o.odds.advantage ? ' adv' : ''}${o.odds.disadvantage ? ' dis' : ''}`) : '';
        return `${describeIntent(o.intent, cast).padEnd(34)} ${o.needsRoll ? '🎲' : '  '} ${odds}`;
    });
    const atCamp = ch.levelId === 1 && ch.room === CAMP;
    if (atCamp) labels.push(`${'Extract: bank carried gold, stash items'.padEnd(34)}`);
    labels.forEach((t, i) => ui.print(`   ${String(i + 1).padStart(2)}) ${t}`));
    ui.print(c.dim(`   m map · c character · v verify last roll · r refresh · x switch character · q quit`));
    const pick = await ui.choose('  > ', labels, ['m', 'c', 'v', 'r', 'x', 'q', '']);
    if (pick === null || pick === 'q') throw new Quit();
    if (pick === 'x') return 'leave';
    if (pick === 'm') {
        for (const l of drawMap(L1, feed.visited, ch.room)) ui.print(l);
        await ui.ask(c.dim('  [enter] '));
        return null;
    }
    if (pick === 'c') {
        sheet(ch, await s.balance());
        await ui.ask(c.dim('  [enter] '));
        return null;
    }
    if (pick === 'v') {
        await showVerification(s, lastRoll);
        return null;
    }
    if (pick === 'r' || pick === '') return null;
    if (atCamp && pick === intents.length) {
        await guard(async () => {
            await s.extract(ch.id);
            ui.print(c.green(`  You step out through the Lychgate with ${ch.carriedGold}g. Wallet: ${gold(await s.balance())}g`));
        });
        return null;
    }
    const opt = intents[pick as number];
    let result: RollRecord | null = null;
    await guard(async () => {
        const out = await s.act(ch.id, opt.intent, opt.needsRoll, progress());
        result = await showOutcome(s, ch, out, cast);
    });
    return result;
}

/** An exchange, coded like the browser's: story in the normal (bright) colour, rolls dim with the outcome word coloured, effects coloured by whether they're good or bad for you. */
function show(lines: Told[]): void {
    const tone = (t: Told['tone']) => (t === 'good' ? c.green : t === 'bad' ? c.red : (x: string) => x);
    for (const l of lines) {
        if (l.kind === 'roll') {
            const m = /^(.*: )(success|failure|hit|miss|saved|failed)(.*)$/.exec(l.text);
            ui.print(m ? `  ${c.dim(m[1])}${tone(l.tone)(m[2])}${c.dim(m[3])}` : `  ${c.dim(l.text)}`);
        } else if (l.kind === 'effect') ui.print(`  ${tone(l.tone)(l.text)}`);
        else ui.print(`  ${c.bold(tone(l.tone)(l.text))}`);
    }
}

/** Show an outcome: the dice landing on their real values, then the story. */
async function showOutcome(s: Session, ch: Character, out: Outcome, cast: ReturnType<typeof castOf>): Promise<RollRecord | null> {
    if (out.roll) return showResolution(s, ch, out.roll, cast);
    show(tell(out.events, cast));
    for (const p of progressMade(content.levels.get(1)!.def, out.events)) ui.print(c.green(`  ${describeProgress(p)}`));
    return null;
}

async function showResolution(s: Session, ch: Character, roll: RollRecord, castIn?: ReturnType<typeof castOf>): Promise<RollRecord> {
    const r = roll.resolved!;
    if (r.outcome === 'fizzled') {
        ui.print(c.yellow(`  ${ch.name} can't: ${r.fizzled}. No dice, no counterattack.`));
        return roll;
    }
    if (r.outcome === 'forfeited') ui.print(c.red('  The reveal never landed: forfeited (your dice at 1, theirs at their max).'));
    const monsters = (await s.room(ch.levelId, arrival(r.events ?? [], ch.id) ?? ch.room)).room.monsters;
    for (const g of groupDice(r.dice, r.events ?? [])) {
        // every die names who rolled it: characters by name, monsters (in red) by kind
        const by = g.by ?? (g.owner === 'pc' ? ch.id : '');
        const who = /^m\d+$/.test(by) ? c.red(monsterName(monsters[Number(by.slice(1))]?.template ?? 'foe')) : by === ch.id ? ch.name : by ? 'someone' : c.red('foe');
        // the d20 that won (a hit, a check or save made, initiative taken) is green, whoever rolled it
        const shown = (v: number) => (g.won ? c.green(c.bold(String(v))) : c.bold(String(v)));
        if (g.values.length < 2) {
            await rollAnimation(ui, `${who}'s ${purposeOf(g, roll.intent ?? null)} d${g.sides}`, g.sides, g.values[0], g.won ? (t) => c.green(c.bold(t)) : c.bold);
            continue;
        }
        // a pair rolled with advantage or disadvantage: "DIS: Wren's sneak 2d20 [18, 1]", the die that doesn't count struck
        const strike = (v: number) => `\x1b[9m${v}\x1b[29m`;
        const faces = g.values.map((v, j) => (j !== g.kept && g.values[0] !== g.values[1] ? c.dim(strike(v)) : shown(v)));
        const tag = g.edge === 'advantage' ? 'ADV: ' : g.edge === 'disadvantage' ? 'DIS: ' : '';
        ui.print(`  ${tag}${who}'s ${purposeOf(g, roll.intent ?? null)} 2d${g.sides} [${faces.join(', ')}]`);
    }
    // a move is told against the room it arrived in: whoever was waiting there is who the story names
    const arrived = arrival(r.events ?? [], ch.id);
    // a monster that turned up mid-exchange isn't in the room as it was read before: read it again to name it
    let cast = arrived === null && !(r.events ?? []).some((e) => e.t === 'spawn') ? castIn : undefined;
    if (!cast) {
        const roomId = arrived ?? ch.room;
        const here = await s.room(ch.levelId, roomId);
        cast = castOf({ ...ch, room: roomId }, here.characters.filter((o) => o.id !== ch.id), [here.room]);
    }
    show(tell(r.events ?? [], cast));
    for (const p of progressMade(content.levels.get(1)!.def, r.events ?? [])) ui.print(c.green(`  ${describeProgress(p)}`));
    ui.print(c.dim(`  sealed at block ${roll.committedAt} · resolved at ${r.height} · v to verify`));
    return roll;
}

async function showVerification(s: Session, roll: RollRecord | null): Promise<void> {
    if (!roll) return ui.print(c.dim('  No roll to verify yet this session.'));
    const fresh = (await s.roll(roll.id)) ?? roll; // a pruned roll is checked from the copy we kept
    const v = verifyRoll(fresh, await s.beacon(fresh.committedAt));
    ui.print(c.bold(`\n  Roll ${roll.id.slice(0, 16)}…`));
    for (const ck of v.checks) ui.print(`  ${ck.ok ? c.green('✓') : c.red('✗')} ${ck.name}: ${ck.detail}`);
    ui.print(v.ok ? c.green('  Verified: these dice follow from your sealed secret and the chain\'s beacon.') : c.red('  Verification failed.'));
    await ui.ask(c.dim('  [enter] '));
}

// ---------------------------------------------------------------- the feed

/** Other players' doings on your level, block by block since the last look (SPEC §8, shared-world presence). */
class Feed {
    private readonly s: Session;
    private readonly charId: string;
    private readonly teller: FeedTeller;
    private seen: number;
    readonly visited: Set<number>;

    constructor(s: Session, charId: string) {
        this.s = s;
        this.charId = charId;
        this.teller = new FeedTeller(s);
        this.seen = s.vault.readState<Record<string, number>>('feed', {})[charId] ?? 0;
        this.visited = new Set(s.vault.readState<Record<string, number[]>>('visited', {})[charId] ?? []);
    }

    visit(room: number): void {
        if (this.visited.has(room)) return;
        this.visited.add(room);
        const all = this.s.vault.readState<Record<string, number[]>>('visited', {});
        all[this.charId] = [...this.visited];
        this.s.vault.writeState('visited', all);
    }

    async lines(): Promise<string[]> {
        const { lines, tip } = await this.teller.since(this.seen);
        this.seen = tip;
        const all = this.s.vault.readState<Record<string, number>>('feed', {});
        all[this.charId] = tip;
        this.s.vault.writeState('feed', all);
        return lines.slice(-8).map((l) => `${c.dim(`[${l.height}] `)}${tone(l.tone)(l.text)}${tone(l.tagTone)(l.tag)}`);
    }
}

const tone = (t: Tone): ((s: string) => string) => ({ plain: (x: string) => x, quiet: c.dim, good: c.green, warn: c.yellow, bad: c.red })[t];

// ---------------------------------------------------------------- shared helpers

function progress(): OnProgress {
    return (p) => {
        switch (p.phase) {
            case 'submitted':
                ui.status(c.dim(`  … ${p.type.replace('_', ' ')} sent, waiting for a block`));
                break;
            case 'resubmit':
                ui.status(c.yellow(`  … ${p.reason}; sending again`));
                break;
            case 'sealed':
                ui.status(`  🔒 sealed at block ${p.committedAt} → revealing (must land by ${p.expiresAt})`);
                ui.endStatus();
                break;
            case 'revealing':
                ui.status(c.dim('  … revealing your secret'));
                break;
        }
    };
}

/** Run an action; show refusals to the player instead of crashing. */
async function guard(fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (e) {
        ui.endStatus();
        if (e instanceof GameError) ui.print(c.red(`  ${e.message}`));
        else if (e instanceof HttpError) ui.print(c.red(`  The node refused: ${e.message}`));
        else throw e;
    }
}

main()
    .catch((e) => {
        if (!(e instanceof Quit)) {
            ui.print(c.red(`\n  ${(e as Error).message}`));
            process.exitCode = 1;
        }
    })
    .finally(() => {
        ui.print(c.dim('\n  Farewell.'));
        ui.close();
    });
