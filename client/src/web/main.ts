/*
 * The Drowned Abbey in a browser, as a terminal (SPEC §8): a pinned status bar, one scrolling transcript you can read
 * back through (kept across reloads), and a prompt. Passkey sign-in; every move signed in the page with no prompts.
 * `npm run web` serves it at http://localhost:5173. ?rpc=…&plugin=…&chain=… point it at another node.
 */

import { ABILITIES, type Character, DOWNED_BLOCKS, type GameEvent, LIE_LOW_BLOCKS, type RoomState, abilityMod, charAC, partyOf, secondsFor } from '@abbey/rules';
import { FeedTeller } from '../lib/feed.ts';
import { mapModel } from '../lib/map.ts';
import { type Edge, groupDice } from '../lib/dicelog.ts';
import { describeProgress, progressMade, roomProgress } from '../lib/progress.ts';
import { TEXT, type Cast, arrival, castOf, purposeOf, describeIntent, human, itemName, monsterName, roomTitle } from '../lib/narrate.ts';
import { type Key, HttpError, Net, newKey } from '../lib/net.ts';
import { type CharRecord, type OnProgress, type OptionEntry, type Outcome, type RollRecord, GameError, Session, content, gold } from '../lib/session.ts';
import { type Recount, condition, fightStatus, recount, thirdPerson } from '../lib/recount.ts';
import { suggestAssignment } from '../lib/stats.ts';
import { verifyRoll } from '../lib/verify.ts';
import { type Method, DeviceSigner, forgetAccount, readLocal, rememberAccount, rememberedAccount, writeLocal } from './device.ts';
import { PasskeyError, createPasskey, keyFromPrf, prfSupport, signIn } from './passkey.ts';
import { type MenuItem, Terminal, esc } from './terminal.ts';
import { startTicker } from './ticker.ts'; // video mode (?ticker); remove with ticker.ts

const L1 = content.levels.get(1)!.def;
const CAMP = L1.camp ?? 0;

const term = new Terminal(document.getElementById('log')!, document.getElementById('cmd') as HTMLInputElement, document.getElementById('plabel')!, document.getElementById('more')!);
const $status = document.getElementById('status')!;

// the chain this build talks to (vite.config.ts: ABBEY_CHAIN_ID / ABBEY_NETWORK_ID at build time; ?chain= / ?network= override)
declare const __ABBEY_CHAIN_ID__: string;
declare const __ABBEY_NETWORK_ID__: string;
const params = new URLSearchParams(location.search);
// on localhost the node's own ports; on a real domain the site's own origin, where the proxy forwards /v1/… to the core and
// /abbey/… to the plugin (and nothing else)
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const net = new Net({
    rpc: params.get('rpc') ?? (local ? `http://${location.hostname}:30002` : location.origin),
    plugin: params.get('plugin') ?? (local ? `http://${location.hostname}:50010` : location.origin),
    chainId: Number(params.get('chain') ?? __ABBEY_CHAIN_ID__),
    networkId: Number(params.get('network') ?? __ABBEY_NETWORK_ID__)
});

let s: Session<DeviceSigner>;
let method: Method = 'device';
let feed: FeedTeller;
let current: Character | null = null; // the character whose turn it is, for the status bar and commands
// party mode: one player runs several of their own characters, taking turns (SPEC §3.3 has no turn order; this is the
// client's). A party of one is ordinary solo play.
let party: string[] = []; // character ids in turn order
let members: Character[] = []; // the party as last read, for the party bar
let allies: Character[] = []; // other players' characters in the actor's room: they fight alongside, shown in the bar
let jumpTo: string | null = null; // a turn asked for by name or by clicking the bar, taken at the next menu
const nudged = new Map<string, number>(); // "extract to heal" said for this character at this HP
const ours = (): Set<string> => new Set(party.length ? party : current ? [current.id] : []);
let busy = false; // an action is in flight: no live updates under it, and warn before leaving
let leaving = false; // "switch": the open menu closes and play goes back to the character list
let shown = ''; // the options on the open menu: when they change (a monster died, someone arrived), print the room again
let lastRoll: RollRecord | null = null;
const rolls = new Map<string, RollRecord>();

class Leave extends Error {}

// ---------------------------------------------------------------- small helpers

function bar(value: number, max: number, width = 10): string {
    const f = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    const n = Math.round(f * width);
    return `<span class="bar ${f <= 0.25 ? 'low' : f <= 0.5 ? 'mid' : ''}"><span class="full">${'█'.repeat(n)}</span><span class="empty">${'░'.repeat(width - n)}</span></span>`;
}

const mod = (v: number) => `${abilityMod(v) >= 0 ? '+' : ''}${abilityMod(v)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const statsTable = (scores: number[]) =>
    `<pre>${ABILITIES.map((ab) => ab.padStart(4)).join(' ')}\n${scores.map((v) => String(v).padStart(4)).join(' ')}\n${scores.map((v) => `(${mod(v)})`.padStart(4)).join(' ')}</pre>`;

/** The roll's progress on one line, rewritten in place; the resolution finishes it with a verify link. */
let progressLine: HTMLElement | null = null;

function progress(): OnProgress {
    progressLine = null;
    let sealed = '';
    const say = (h: string) => {
        if (progressLine) progressLine.innerHTML = h;
        else progressLine = term.html(h, 'dim');
    };
    return (p) => {
        if (p.phase === 'submitted') say(`${sealed || '…'} ${sealed ? 'revealing…' : `${esc(p.type.replace('_', ' '))} sent, waiting for a block`}`);
        else if (p.phase === 'resubmit') say(`<span class="warn">… ${esc(p.reason)}; sending again</span>`);
        else if (p.phase === 'sealed') {
            sealed = `🔒 sealed at block ${p.committedAt} ·`;
            say(`${sealed} revealing (must land by ${p.expiresAt})`);
        } else if (p.phase === 'revealing') say(`${sealed} revealing…`);
    };
}

// ---------------------------------------------------------------- the fight in this room: rounds and a tally

let fight = { room: -1, round: 0, dealt: 0, taken: 0, kills: 0 };
let hereShown = ''; // who's around, as last printed: only a change is printed again
let progressShown = ''; // shared work under way here (the rubble), as last printed

function tally(events: GameEvent[], mine: Set<string>): void {
    for (const e of events) {
        if (e.t === 'damage' && mine.has(e.target)) fight.taken += e.amount;
        else if (e.t === 'damage' && /^m\d+$/.test(e.target)) fight.dealt += e.amount;
        else if (e.t === 'monster' && e.status === 'dead') fight.kills++;
    }
}

/** Run an action; a refusal is printed, not thrown. */
async function guard(fn: () => Promise<void>): Promise<void> {
    busy = true;
    try {
        await fn();
    } catch (e) {
        if (e instanceof GameError || e instanceof PasskeyError) term.say(e.message, 'bad');
        else if (e instanceof HttpError) term.say(`The node refused: ${e.message}`, 'bad');
        else {
            console.error(e);
            term.say(`Something went wrong: ${(e as Error).message}`, 'bad');
        }
    } finally {
        busy = false;
    }
}

window.addEventListener('beforeunload', (e) => {
    if (busy) e.preventDefault(); // a roll may be mid-flight; its secret is saved, but say so
});

// ---------------------------------------------------------------- the status bar

async function status(): Promise<void> {
    if (!s) return;
    const [h, wallet] = await Promise.all([net.height(), s.balance()]);
    const ch = current;
    const who = ch
        ? `<span class="who"><b>${esc(ch.name)}</b> <span class="dim">${esc(ch.classId)}</span></span>
           <span>HP ${bar(ch.hp, ch.maxHp, 8)} ${ch.hp}/${ch.maxHp} <span class="dim">AC ${charAC(content, ch)}</span></span>
           <span>carried <span class="warn">${ch.carriedGold}g</span></span>
           <span class="dim">${ch.status === 'camp' ? 'at camp' : esc(roomTitle(ch.room))}</span>`
        : '';
    // while playing, the character's numbers take the title's place
    $status.innerHTML = `${ch ? '' : '<span class="title">The Drowned Abbey</span>'}${who}
        <span>wallet <span class="warn">${gold(wallet)}g</span></span>
        <span class="dim blk">block ${h - 1}</span>
        <button id="acct" title="Account" class="${ch ? 'push' : ''}">${method === 'passkey' ? '🔑' : '💻'} ${short(s.address)}</button>
        ${partyBar()}`;
    document.getElementById('acct')?.addEventListener('click', () => void term.commands.account.run(''));
    $status.querySelectorAll<HTMLButtonElement>('button[data-char]').forEach((b) => b.addEventListener('click', () => jump(b.dataset.char!)));
}

/** The party on its own row: whose turn it is, everyone's HP (click a name to take their turn), and allies here. */
function partyBar(): string {
    if (party.length < 2) return '';
    const state = (c: Character) => (c.status === 'downed' ? ' <span class="bad">downed</span>' : c.status === 'camp' ? ' <span class="dim">at camp</span>' : c.room !== current?.room ? ` <span class="dim">${esc(roomTitle(c.room))}</span>` : '');
    const mine = members.map((c) => `<button data-char="${esc(c.id)}" class="member${c.id === current?.id ? ' on' : ''}" title="${esc(c.name)}'s turn">${c.id === current?.id ? '▸ ' : ''}${esc(c.name)} ${bar(c.hp, c.maxHp, 5)} ${c.hp}/${c.maxHp}${state(c)}</button>`);
    const ourParty = current ? partyOf(current) : '';
    const theirs = allies.slice(0, 4).map((c) => `<span class="ally">${c.party && c.party === ourParty ? '⚑ ' : ''}${esc(c.name)} ${bar(c.hp, c.maxHp, 5)} ${c.hp}/${c.maxHp}${c.status === 'downed' ? ' <span class="bad">downed</span>' : ''}</span>`);
    return `<span class="party">${mine.join('')}${theirs.length ? `<span class="dim">with</span>${theirs.join('')}` : ''}</span>`;
}

/** Take a party member's turn: at once if a menu is open, else once the action in flight is done. */
function jump(id: string): void {
    if (!party.includes(id) || id === current?.id) return;
    jumpTo = id;
    if (term.atMenu && !busy) term.interrupt();
}

// ---------------------------------------------------------------- commands (typed at any menu)

function commands(): Terminal['commands'] {
    const need = (fn: (ch: Character) => Promise<void> | void) => async () => {
        if (!current) return void term.say('No character yet.', 'dim');
        await fn(current);
    };
    return {
        help: {
            help: 'this list',
            run: () => {
                term.say('Type a number to choose, or one of:', 'dim');
                for (const [k, c] of Object.entries(term.commands)) term.html(`  <span class="blue">${k.padEnd(8)}</span> <span class="dim">${esc(c.help)}</span>`);
            }
        },
        look: { help: 'the room again, as it is now', run: need(() => term.interrupt()) },
        sheet: { help: 'your character sheet', run: need((ch) => printSheet(ch)) },
        map: { help: 'the rooms you have seen', run: need((ch) => printMap(ch)) },
        feed: { help: 'what others did lately', run: need(async () => void (await printFeed(true))) },
        verify: {
            help: 'check your last roll against the chain',
            run: async () => {
                if (lastRoll) await printVerification(lastRoll);
                else term.say('No roll to verify yet.', 'dim');
            }
        },
        join: {
            help: "join the party of a character standing with you (join bo): you'll move whenever they do",
            run: async (arg) => {
                const ch = current;
                if (!ch) return void term.say('No character yet.', 'dim');
                const { characters: here } = await s.room(ch.levelId, ch.room);
                const name = arg.trim().toLowerCase();
                const who = name ? here.find((c) => c.id !== ch.id && c.name.toLowerCase().startsWith(name)) : undefined;
                if (!who) return void term.say('Name someone standing here: join <name>.', 'dim');
                await guard(async () => {
                    await s.partySet(ch.id, who.id);
                    term.say(`${ch.name} joins ${who.name}'s party: whenever a member moves on, ${ch.name} goes too. Type leave to go your own way.`, 'good');
                });
                term.interrupt();
            }
        },
        leave: {
            help: 'leave your party: move on your own again',
            run: need(async (ch) => {
                if (!ch.party) return void term.say(`${ch.name} isn't in a party.`, 'dim');
                await guard(async () => {
                    await s.partySet(ch.id, null);
                    term.say(`${ch.name} leaves the party and goes their own way.`, 'good');
                });
                term.interrupt();
            })
        },
        next: {
            help: 'pass the turn to the next character in your party',
            run: need((ch) => {
                if (party.length < 2) return void term.say('Only in a party (switch, then "Delve as a party").', 'dim');
                jump(party[(party.indexOf(ch.id) + 1) % party.length]);
            })
        },
        switch: {
            help: 'play another character, or a party',
            run: need(() => {
                leaving = true;
                term.interrupt();
            })
        },
        account: {
            help: 'your address; export the key; sign out',
            run: () => {
                term.rule('Account');
                term.say(s.address);
                term.say(method === 'passkey' ? 'Signed in with a passkey: any device your passkeys sync to opens this same account.' : 'A key kept in this browser only: export it to keep the account if this browser’s data is cleared.', 'dim');
                term.html('Type <span class="blue">export</span> to print your private key, or <span class="blue">signout</span> to sign out of this device.', 'dim');
            }
        },
        faucet: {
            help: 'claim gold from the abbey’s charity box (free; limits are set by the chain)',
            run: async () => {
                await guard(async () => {
                    const before = await s.balance();
                    term.say('Claiming from the charity box…', 'dim');
                    await s.claimFaucet();
                    term.say(`Claimed ${gold((await s.balance()) - before)}g. Wallet: ${gold(await s.balance())}g`, 'good');
                    await status();
                });
            }
        },
        export: { help: 'print your private key (anyone with it controls the account)', run: () => void term.say(`Private key: ${s.vault.key.privateKey}`, 'warn') },
        signout: {
            help: 'forget this account on this device',
            run: async () => {
                if (method === 'device' && !confirm('This account lives only in this browser. Without an exported key, signing out loses it. Sign out?')) return;
                await forgetAccount();
                location.reload();
            }
        },
        clear: { help: 'wipe the scrollback on this device', run: () => term.clearHistory() },
        math: {
            help: 'show or hide the dice and arithmetic behind each outcome (math on / math off)',
            run: (arg) => {
                const v = arg.trim().toLowerCase();
                const on = v === 'on' ? true : v === 'off' ? false : document.body.classList.contains('no-math');
                setMath(on);
                term.say(on ? 'Showing the dice and the math.' : 'Hiding the dice and the math: just the story (math on to bring them back).', 'dim');
            }
        },
        width: {
            help: 'column width in characters (60–200), or full',
            run: (arg) => {
                const v = arg.trim().toLowerCase();
                const n = Number(v);
                if (v !== 'full' && !(n >= 60 && n <= 200)) return void term.say('Try width 80, width 120, or width full.', 'dim');
                setLayout({ ...layout(), width: v === 'full' ? 'full' : n });
                term.say(`Width: ${v === 'full' ? 'the whole window' : `${n} characters`}.`, 'dim');
            }
        },
        align: {
            help: 'left or center',
            run: (arg) => {
                const v = arg.trim().toLowerCase();
                if (v !== 'left' && v !== 'center' && v !== 'centre') return void term.say('Try align left or align center.', 'dim');
                setLayout({ ...layout(), align: v === 'left' ? 'left' : 'center' });
                term.say(`Aligned ${v === 'left' ? 'left' : 'to the center'}.`, 'dim');
            }
        }
    };
}

// ---------------------------------------------------------------- layout: where the column sits (remembered per device)

interface Layout {
    width: number | 'full';
    align: 'left' | 'center';
}

const layout = (): Layout => ({ width: 100, align: 'center', ...readLocal<Partial<Layout>>('layout', {}) });

function setLayout(l: Layout): void {
    writeLocal('layout', l);
    applyLayout(l);
}

function applyLayout(l: Layout): void {
    const root = document.documentElement.style;
    root.setProperty('--col', l.width === 'full' ? '100%' : `${l.width}ch`);
    if (l.align === 'left' || l.width === 'full') root.setProperty('--gutter', '16px');
    else root.removeProperty('--gutter'); // the stylesheet's centring (and its narrow-screen gutter)
}

applyLayout(layout());

/** The dice and arithmetic lines: shown by default, hidden with `math off` (remembered per device). */
function setMath(on: boolean): void {
    writeLocal('math', on);
    document.body.classList.toggle('no-math', !on);
}
document.body.classList.toggle('no-math', readLocal<boolean>('math', true) === false);

// ---------------------------------------------------------------- start and sign-in

async function main(): Promise<void> {
    try {
        await net.height();
        if (!(await net.abbey('/abbey/levels'))) throw new Error('the game endpoint answered without levels');
    } catch (e) {
        term.say(`Can't reach the abbey at ${net.ep.rpc} / ${net.ep.plugin}: ${(e as Error).message}`, 'bad');
        term.say('Is the localnet running? See plugin/M2-REPORT.md, “Re-run”. Reload to try again.', 'dim');
        return;
    }
    const acct = (await rememberedAccount()) ?? (await signInFlow());
    method = acct.method;
    // check state every 100ms while waiting on your own tx: a fifth of a 500ms block, so a landing is seen at once (?poll= overrides)
    s = new Session(net, new DeviceSigner(acct.key), { pollMs: Number(params.get('poll') ?? 100) });
    feed = new FeedTeller(s);
    term.restore(s.address);
    term.commands = commands();
    term.rule(`${TEXT.level.title} · block ${(await net.height()) - 1}`);
    await status();
    const resumed = await s.resumePending(progress());
    if (resumed.revealed.length) term.say(`Revealed ${resumed.revealed.length} roll(s) left sealed when you were last here.`, 'good');
    if ((await s.balance()) === 0n) {
        term.say('Your purse is empty. The abbey’s charity box is free to claim…', 'dim');
        await s.claimFaucet();
        await status();
    }
    setInterval(() => void live().catch(() => {}), 6000);
    startTicker(net); // video mode (?ticker); remove with ticker.ts
    for (;;) {
        const ids = await pickCharacter();
        try {
            await play(ids);
        } catch (e) {
            if (!(e instanceof Leave)) throw e;
        }
        current = null;
        party = [];
        members = [];
        allies = [];
        jumpTo = null;
        term.commands = commands();
        leaving = false;
        shown = '';
        await status();
    }
}

async function signInFlow(): Promise<{ key: Key; method: Method }> {
    term.html(esc(TEXT.level.title), 'title-ln');
    term.say(TEXT.level.intro, 'prose');
    term.blank();
    term.say('Your account is a passkey: no password, no seed phrase. Face ID or Touch ID signs you in on any device your passkeys sync to.');
    if ((await prfSupport()) === false) term.say("This browser can't use passkeys for the game (no PRF support). You can still play on this device only.", 'warn');
    for (;;) {
        const pick = await term.menu([{ label: 'Create an account with a passkey' }, { label: 'Sign in with a passkey' }, { label: 'Play on this device only (no passkey; back it up later)' }]);
        if (!('index' in pick)) continue;
        try {
            let key: Key;
            let how: Method = 'passkey';
            if (pick.index === 0) {
                const name = (await term.ask('A name for your passkey (it shows in your password manager):')) || 'Drowned Abbey player';
                term.say('Waiting for your passkey…', 'dim');
                const prf = await createPasskey(name);
                if (!prf) {
                    term.say("The passkey was made, but it can't do PRF, so it can't hold a game account. Try another browser, or play on this device only.", 'warn');
                    continue;
                }
                key = keyFromPrf(prf);
            } else if (pick.index === 1) {
                term.say('Waiting for your passkey…', 'dim');
                const prf = await signIn();
                if (!prf) {
                    term.say("That passkey can't do PRF, so it can't hold a game account.", 'warn');
                    continue;
                }
                key = keyFromPrf(prf);
            } else {
                key = newKey();
                how = 'device';
            }
            await rememberAccount(key, how); // this device remembers you until you sign out
            term.say(`Signed in as ${short(key.address)}.`, 'good');
            return { key, method: how };
        } catch (e) {
            term.say(e instanceof PasskeyError ? e.message : `Sign-in failed: ${(e as Error).message}`, 'bad');
        }
    }
}

// ---------------------------------------------------------------- characters

const PARTY_MAX = 4; // the largest party the balance sim covers (SPEC §9)
const whereIs = (ch: Character) => (ch.status === 'delving' || ch.status === 'downed' ? `${ch.status} in the ${roomTitle(ch.room)}` : ch.status);

/** The last party played on this device, per account. */
const savedParty = (): string[] => readLocal<Record<string, string[]>>('party', {})[s.address] ?? [];
const saveParty = (ids: string[]) => writeLocal('party', { ...readLocal<Record<string, string[]>>('party', {}), [s.address]: ids });

/** Who to play: one character, a party of your own (2–4), or a new character. Returns the ids in turn order. */
async function pickCharacter(): Promise<string[]> {
    for (;;) {
        const acct = await s.account();
        const living = acct.characters.filter((ch) => ch.status !== 'dead');
        term.rule('Your delvers');
        const last = savedParty().filter((id) => living.some((c) => c.id === id));
        const items: { item: MenuItem; run: () => Promise<string[] | null> }[] = [];
        if (last.length > 1)
            items.push({ item: { label: `Continue the party: ${last.map((id) => living.find((c) => c.id === id)!.name).join(', ')}` }, run: async () => last });
        for (const ch of living) items.push({ item: { label: `${ch.name}, ${ch.classId}`, note: esc(whereIs(ch)) }, run: async () => [ch.id] });
        if (living.length > 1) items.push({ item: { label: `Delve as a party: pick up to ${Math.min(PARTY_MAX, living.length)} of your delvers to take turns` }, run: () => formParty(living) });
        items.push({ item: { label: 'New character' }, run: async () => {
                // a first character goes straight in; any later one comes back to this list, to play alone or party up
                const made = await createCharacter();
                if (made && !living.length) return [made];
                if (made) term.say('Pick who to play next: the new delver alone, or a party.', 'dim');
                return null;
            }
        });
        const pick = await term.menu(items.map((i) => i.item));
        if (!('index' in pick)) continue;
        const ids = await items[pick.index].run();
        if (ids?.length) return ids;
    }
}

/** Tick party members on and off, then start. Turn order is the order they were picked. */
async function formParty(living: Character[]): Promise<string[] | null> {
    const picked: string[] = [];
    term.rule('A party');
    term.say(`Pick up to ${PARTY_MAX}. They take turns: after each action the next one acts. Click a name in the bar (or type it) to act out of turn.`, 'dim');
    for (;;) {
        const items: MenuItem[] = living.map((c) => ({ label: `${picked.includes(c.id) ? `[${picked.indexOf(c.id) + 1}]` : '[ ]'} ${c.name}, ${c.classId}`, note: esc(whereIs(c)) }));
        items.push({ label: picked.length > 1 ? `Start: ${picked.map((id) => living.find((c) => c.id === id)!.name).join(', ')}` : 'Start (pick at least two)' }, { label: 'Back' });
        const pick = await term.menu(items);
        if (!('index' in pick)) continue;
        if (pick.index === living.length + 1) return null;
        if (pick.index === living.length) {
            if (picked.length < 2) continue;
            saveParty(picked);
            return picked;
        }
        const id = living[pick.index].id;
        if (picked.includes(id)) picked.splice(picked.indexOf(id), 1);
        else if (picked.length < PARTY_MAX) picked.push(id);
        else term.say(`A party is at most ${PARTY_MAX}.`, 'dim');
    }
}

const CLASS_BLURB: Record<string, string> = {
    fighter: 'sturdy, hits hard; Second Wind heals once a delve',
    rogue: 'quick and sly; sneak attacks when an ally is close',
    cleric: 'Heal ×3 and Turn Undead; wise and steady',
    wizard: 'fragile, but Magic Missile ×3 never misses'
};

async function createCharacter(): Promise<string | null> {
    term.rule('A new delver');
    let name = '';
    while (!name) name = (await term.ask('Name:')).slice(0, 24);
    const classes = Object.keys(content.registry.classes);
    term.say('Class:', 'q');
    const pick = await term.menu(classes.map((k) => ({ label: `${human(k)}: ${CLASS_BLURB[k] ?? ''}`, note: `HP ${content.registry.classes[k].hpBase} · AC ${content.registry.classes[k].ac}` })));
    if (!('index' in pick)) return null;
    const classId = classes[pick.index];
    term.say('Rolling 4d6-drop-lowest six times, sealed before the dice exist…', 'dim');
    let id = '';
    await guard(async () => {
        const made = await s.createCharacter(name, classId, progress());
        id = made.charId;
        await assign(made.charId, name, classId, made.rolled);
    });
    return id || null;
}

/** The rolled scores in the suggested places; swap any two by name until it looks right. */
async function assign(id: string, name: string, classId: string, rolled: number[]): Promise<void> {
    term.say(`Rolled: ${rolled.join('  ')}`);
    const perm = suggestAssignment(classId, rolled);
    for (;;) {
        term.html(statsTable(ABILITIES.map((_, i) => rolled[perm[i]])));
        const pick = await term.menu([{ label: `${name} is ready` }, { label: 'Swap two scores' }]);
        if (!('index' in pick)) continue;
        if (pick.index === 0) break;
        const want = (await term.ask('Which two? (for example: str int)')).toUpperCase().split(/[\s,]+/);
        const a = ABILITIES.indexOf(want[0] as (typeof ABILITIES)[number]);
        const b = ABILITIES.indexOf(want[1] as (typeof ABILITIES)[number]);
        if (a < 0 || b < 0) term.say('Name two of STR DEX CON INT WIS CHA.', 'dim');
        else [perm[a], perm[b]] = [perm[b], perm[a]];
    }
    await s.assignStats(id, perm);
    term.say(`${name} the ${classId} is ready at the Lychgate.`, 'good');
}

// ---------------------------------------------------------------- play

/** Where a character stands, as a key: members at the same spot act together. */
const spot = (c: Character): string => (c.status === 'camp' ? 'camp' : `${c.levelId}:${c.room}`);
const placeOf = (c: Character): string => (c.status === 'camp' ? 'at camp' : `in the ${roomTitle(c.room)}`);

/** A character can take a turn: standing (in the dungeon or at camp), or with a sealed roll to finish. */
const canAct = (r: CharRecord | null): boolean => !!r && (!!r.pending || ['delving', 'camp', 'rolling'].includes(r.char.status));

/**
 * Play one character, or a party taking turns: after each action the turn passes to the next member who can act (a
 * downed one is skipped until someone stabilizes them). The room is printed in full whenever the one acting stands
 * somewhere new to the transcript; a turn passing within the same room prints only what changed.
 */
/**
 * Put the party on chain (SPEC §3.6): every member in the first member's party, so any member's move takes the others
 * standing with them along. Playing one character alone takes it out of a party of your own first, so a solo move can't
 * drag the rest. A party with another player is left alone (leave it with the leave command).
 */
async function bandTogether(ids: string[]): Promise<void> {
    const recs = await Promise.all(ids.map((id) => s.character(id)));
    if (ids.length > 1) {
        const leader = ids[0];
        const todo = recs.flatMap((r) => (r && r.char.party !== leader && r.char.status !== 'rolling' ? [r.char] : []));
        if (!todo.length) return;
        await guard(() => allAtOnce(todo, (m) => s.partySet(m.id, leader), (m) => (m.id === leader ? `${m.name} leads the party.` : `${m.name} joins ${recs[0]!.char.name}'s party.`)));
        return;
    }
    const ch = recs[0]?.char;
    if (!ch?.party) return;
    const mine = (await s.account()).characters.some((c) => c.id === ch.party);
    if (mine) await guard(async () => {
        await s.partySet(ch.id, null);
        term.say(`${ch.name} leaves your party to go alone.`, 'dim');
    });
}

async function play(ids: string[]): Promise<void> {
    party = ids;
    await bandTogether(ids);
    let turn = 0;
    let advance = false;
    let lastRoom = -1; // the room printed last (for any member): a new one is printed in full
    let lastTurn = '';
    let lastSplit = '';
    // each member's name is a command that takes their turn ("wren")
    if (party.length > 1) {
        for (const r of await Promise.all(party.map((id) => s.character(id)))) {
            const key = r?.char.name.split(/\s+/)[0].toLowerCase();
            if (r && key && !(key in term.commands)) term.commands[key] = { help: `${r.char.name}'s turn`, run: () => jump(r.char.id) };
        }
    }
    for (;;) {
        if (leaving) throw new Leave();
        const recs = await Promise.all(party.map((id) => s.character(id)));
        if (recs.every((r) => !r)) throw new Leave();
        members = recs.flatMap((r) => (r ? [r.char] : []));
        if (jumpTo && party.includes(jumpTo)) turn = party.indexOf(jumpTo);
        else if (advance || !canAct(recs[turn])) {
            // turns stay with whoever is together: the next member standing where this one stands, else this one again;
            // only if neither can act (downed, say) does the turn go to someone elsewhere. A member off on their own is
            // played by clicking their name, never jumped to mid-fight.
            const here = recs[turn] ? spot(recs[turn]!.char) : '';
            const order = party.map((_, k) => (turn + 1 + k) % party.length); // the next ones, then this one last
            turn = order.find((i) => canAct(recs[i]) && spot(recs[i]!.char) === here) ?? order.find((i) => canAct(recs[i])) ?? turn;
        }
        jumpTo = null;
        advance = false;
        const rec = recs[turn] ?? recs.find(Boolean)!;
        current = rec.char;
        await status();
        const ch = rec.char;
        if (party.length > 1) {
            // a split party is said once, whenever who-is-where changes
            const groups = new Map<string, Character[]>();
            for (const m of members) groups.set(spot(m), [...(groups.get(spot(m)) ?? []), m]);
            const split = [...groups.values()].map((g) => `${g.map((m) => m.name).join(', ')} ${placeOf(g[0])}`).join(' · ');
            if (groups.size > 1 && split !== lastSplit)
                term.html(`<span class="warn">Your party is split:</span> ${esc(split)}. <span class="dim">Turns stay with whoever is together; click a name in the bar to play someone elsewhere.</span>`);
            lastSplit = groups.size > 1 ? split : '';
        }
        if (party.length > 1 && ch.id !== lastTurn) {
            term.html(`<span class="turn">▸ ${esc(ch.name)}'s turn</span> <span class="dim">· ${esc(placeOf(ch))} · ${esc(ch.classId)}, HP ${ch.hp}/${ch.maxHp}</span>`, 'turn-ln');
            lastTurn = ch.id;
        }
        if (rec.pending) {
            await guard(async () => {
                term.say(`${ch.name}'s roll is still sealed; revealing it…`, 'dim');
                await showResolution(ch, await s.revealRoll(rec.pending!, progress()));
            });
            advance = true;
            continue;
        }
        if (ch.status === 'rolling') {
            await guard(() => assign(ch.id, ch.name, ch.classId, rec.rolled ?? []));
            continue;
        }
        if (ch.status === 'camp') {
            advance = await camp(ch, members);
            lastRoom = -1;
            continue;
        }
        const arrived = ch.room !== lastRoom;
        lastRoom = ch.room;
        advance = await room(ch, arrived, recs);
    }
}

/**
 * The same action for several party members, one after another (each signs its own tx and rolls its own dice).
 * Someone who can't (a roll pending, the option gone) is told and skipped; the rest carry on.
 */
async function together(chars: Character[], intent: OptionEntry['intent'], hostile: boolean): Promise<void> {
    // who can: each member's own options must still offer it (a pending roll, say, rules one out)
    const want = JSON.stringify(intent);
    const ready: { m: Character; o: OptionEntry; cast: Cast }[] = [];
    for (const m of chars) {
        const opts = await s.options(m.id);
        const o = opts.options.find((x) => JSON.stringify(x.intent) === want);
        if (!o) {
            term.say(`${m.name} can't: ${opts.pending ? 'a roll is still sealed' : 'not an option for them right now'}.`, 'dim');
            continue;
        }
        const { room: rs, characters: here } = await s.room(m.levelId, m.room);
        ready.push({ m, o, cast: castOf(m, here.filter((x) => x.id !== m.id), [rs], party) });
    }
    // everyone's tx goes out at once (each its own commit and reveal, landing in the same blocks), then the results are
    // told in party order: one wait instead of one per member
    const track = partyProgress(ready.map((r) => r.m.name));
    const results = await Promise.allSettled(ready.map((r) => s.act(r.m.id, r.o.intent, r.o.needsRoll, track(r.m.name))));
    track.done(results.map((r) => r.status === 'fulfilled'));
    for (const [i, r] of results.entries()) {
        const { m, o, cast } = ready[i];
        if (r.status === 'rejected') {
            term.say(`${m.name}: ${r.reason instanceof Error ? cleanMsg(r.reason) : String(r.reason)}`, 'bad');
            continue;
        }
        await tellOutcome(m, o, cast, hostile, r.value);
    }
}

/** The same one-off step (enter, extract) for several members at once; each line is printed as it lands. */
async function allAtOnce(chars: Character[], step: (m: Character) => Promise<void>, told: (m: Character) => string): Promise<void> {
    const track = partyProgress(chars.map((m) => m.name));
    const results = await Promise.allSettled(chars.map(async (m) => {
        track(m.name)({ phase: 'submitted', type: '' });
        await step(m);
    }));
    track.done(results.map((r) => r.status === 'fulfilled'));
    for (const [i, r] of results.entries()) {
        if (r.status === 'fulfilled') await term.type(told(chars[i]), 'good');
        else term.say(`${chars[i].name}: ${r.reason instanceof Error ? cleanMsg(r.reason) : String(r.reason)}`, 'bad');
    }
}

/** One progress line for a party action: each member's tx as it goes (… sent, 🔒 sealed, 🔓 revealing, ✓ landed). */
function partyProgress(names: string[]): ((name: string) => OnProgress) & { done: (ok: boolean[]) => void } {
    const state = new Map(names.map((n) => [n, '…']));
    const line = term.html('', 'dim');
    const render = () => (line.innerHTML = `Party: ${names.map((n) => `${esc(n)} ${state.get(n)}`).join(' · ')}`);
    render();
    const track = (name: string): OnProgress => (p) => {
        const now = state.get(name);
        if (p.phase === 'sealed') state.set(name, '🔒');
        else if (p.phase === 'revealing') state.set(name, '🔓');
        else if (p.phase === 'resubmit') state.set(name, '↻');
        else if (p.phase === 'submitted' && now !== '🔒' && now !== '🔓') state.set(name, '…');
        render();
    };
    return Object.assign(track, {
        done: (ok: boolean[]) => {
            names.forEach((n, i) => state.set(n, ok[i] ? '✓' : '✗'));
            render();
            progressLine = null; // each member's result gets its own sealed / resolved / verify line
        }
    });
}

const cleanMsg = (e: Error) => (e instanceof HttpError ? `the node refused: ${e.message}` : e.message);

async function camp(ch: Character, team: Character[]): Promise<boolean> {
    const acct = await s.account();
    const atCamp = team.filter((m) => m.id !== ch.id && m.status === 'camp');
    term.rule(`${roomTitle(CAMP)} · camp`);
    term.say(TEXT.rooms.lychgate.prose, 'prose');
    const wares = Object.entries(content.registry.items).filter(([, it]) => typeof it.price === 'number');
    const moves = [...ch.inventory.map((it) => ({ it, to: true })), ...acct.stash.map((it) => ({ it, to: false }))];
    const items: { item: MenuItem; run: () => Promise<void> }[] = [
        {
            item: { label: 'Enter the abbey' },
            run: async () => {
                await s.enter(ch.id);
                await term.type(`${ch.name} wades into the ${roomTitle(L1.entry)}.`);
            }
        },
        ...(atCamp.length
            ? [
                  {
                      item: { label: `Party: everyone at camp enters the abbey (${[ch, ...atCamp].map((m) => m.name).join(', ')})` },
                      run: () => allAtOnce([ch, ...atCamp], (m) => s.enter(m.id), (m) => `${m.name} wades into the ${roomTitle(L1.entry)}.`)
                  }
              ]
            : []),
        ...wares.map(([tid, it]) => ({
            item: { label: `Buy ${itemName(tid)}`, note: `${it.price}g` },
            run: async () => {
                await s.shopBuy(ch.id, tid);
                term.say(`${ch.name} bought ${aOrAn(itemName(tid))}.`, 'good');
            }
        })),
        ...ch.inventory
            .filter((it) => it.escrow)
            .map((it) => ({
                item: { label: `Sell ${itemName(it.template)}`, note: `+${it.escrow}g` },
                run: async () => {
                    await s.shopSell(ch.id, it.id);
                    term.say('Sold.', 'good');
                }
            })),
        ...moves.map((m) => ({
            item: { label: `${m.to ? 'Pack → stash' : 'Stash → pack'}: ${itemName(m.it.template)}` },
            run: async () => {
                await s.stashMove(ch.id, m.it.id, m.to);
                term.say('Moved.', 'dim');
            }
        })),
        {
            item: { label: `Back to your delvers (play someone else, ${party.length > 1 ? 'or change the party' : 'make a new one, or form a party'})` },
            run: async () => {
                leaving = true;
            }
        }
    ];
    shown = '';
    const pick = await term.menu(items.map((i) => i.item));
    if (!('index' in pick)) return false;
    await guard(items[pick.index].run);
    return true;
}

const aOrAn = (w: string) => `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;

/** The room: in full on arrival (prose, monsters, who's here), then the menu; afterwards only what's new. */
async function room(ch: Character, arrived: boolean, recs: (CharRecord | null)[]): Promise<boolean> {
    const [{ room: rs, characters: here }, opts, h] = await Promise.all([s.room(ch.levelId, ch.room), s.options(ch.id), net.height()]);
    const others = here.filter((o) => o.id !== ch.id);
    const cast = castOf(ch, others, [rs], party);
    // the rest of the party standing here, free to act with you; and other players here, for the party bar
    const mates = recs.flatMap((r) => (r && r.char.id !== ch.id && !r.pending && r.char.status === 'delving' && r.char.levelId === ch.levelId && r.char.room === ch.room ? [r.char] : []));
    // other players fighting alongside: awake ones (idle delvers lie low and are left out, SPEC §3.3) and the downed
    allies = others.filter((o) => !party.includes(o.id) && ((o.status === 'delving' && h - o.lastActionHeight <= LIE_LOW_BLOCKS) || o.status === 'downed'));
    await status();
    visit(ch);
    const hostile = rs.monsters.some((m) => m.status === 'hostile');
    if (arrived) {
        fight = { room: ch.room, round: 0, dealt: 0, taken: 0, kills: 0 };
        hereShown = '';
        term.rule(roomTitle(ch.room));
        const key = L1.rooms.find((r) => r.id === ch.room)?.key ?? '';
        term.say(TEXT.rooms[key]?.prose ?? '', 'prose');
        printMonsters(rs);
        printFloor(rs);
    } else if (fight.round > 0 && hostile) printStrip(rs, ch);
    else if (fight.round > 0 && !hostile && fight.kills > 0) {
        await term.type(`The fight is over: ${fight.round} round${fight.round > 1 ? 's' : ''}, ${fight.dealt} damage dealt, ${fight.taken} taken.`, 'story good');
        fight = { room: ch.room, round: 0, dealt: 0, taken: 0, kills: 0 };
        printFloor(rs);
    }
    printHere(others.filter((o) => !party.includes(o.id)), h);
    // shared work under way here (the rubble: anyone's success counts), printed on arrival and whenever it moves
    const jobs = roomProgress(L1, rs);
    const underway = jobs.filter((j) => j.value > 0 && j.value < j.goal);
    const key = `${ch.room}:${underway.map((j) => `${j.counter}=${j.value}`).join(',')}`;
    if (arrived || key !== progressShown) for (const j of underway) term.say(describeProgress(j), 'warn');
    progressShown = key;
    for (const d of [ch, ...members.filter((m) => m.id !== ch.id && m.status === 'downed' && m.room === ch.room)])
        if (d.status === 'downed') term.say(`${d.name} is downed. An ally can stabilize them; otherwise the Ferryman comes in ~${Math.max(0, Math.round(secondsFor(d.downedAt + DOWNED_BLOCKS + 1 - h)))}s.`, 'bad');
    await printFeed(false);
    // back at the Lychgate badly hurt (the Ferryman leaves you at 1 HP): extracting heals fully, so say so once
    const atGate = ch.levelId === 1 && ch.room === CAMP && ch.status === 'delving';
    const low = (c: Character) => c.hp <= c.maxHp / 4;
    if (atGate && low(ch) && nudged.get(ch.id) !== ch.hp) {
        nudged.set(ch.id, ch.hp);
        term.say(`${ch.name} is at the Lychgate with ${ch.hp}/${ch.maxHp} HP. Extract to rest at camp and heal fully before going back in.`, 'warn');
    }

    // helping someone who is down comes first: they have two minutes
    const downed = new Set(here.filter((o) => o.status === 'downed').map((o) => o.id));
    const helps = (o: OptionEntry) => o.intent.kind === 'stabilize' || ('target' in o.intent && downed.has(String(o.intent.target)));
    const ordered = [...opts.options.filter(helps), ...opts.options.filter((o) => !helps(o))];
    // a multi-step job says how far along it is on its menu line ("· 1/2 done")
    const jobNote = (o: OptionEntry) => {
        const j = o.intent.kind === 'action' ? jobs.find((x) => x.actionId === (o.intent as { actionId: string }).actionId) : undefined;
        return j && j.value > 0 ? ` <span class="warn">· ${j.value}/${j.goal} done</span>` : '';
    };
    // leaving the Lychgate for the dungeon badly hurt gets a red flag on the way out
    const hurtNote = (cs: Character[]) => (atGate ? cs.filter(low).map((c) => ` <span class="bad">⚠ ${esc(c.name)} ${c.hp}/${c.maxHp} HP</span>`).join('') : '');
    const choices: { item: MenuItem; run: () => Promise<void> }[] = ordered.map((o) => ({
        item: { label: describeIntent(o.intent, cast), note: (o.needsRoll ? '🎲 ' : '') + oddsText(o) + jobNote(o) + (o.intent.kind === 'move' ? hurtNote([ch]) : '') },
        run: () => act(ch, o, cast, hostile)
    }));
    // a move within the level takes along the party members standing here (on chain, one tx, one initiative roll); in
    // a fight a move is a flee, and everyone flees on their own
    const along = hostile ? [] : here.filter((c) => c.id !== ch.id && c.status === 'delving' && c.party === partyOf(ch) && !recs.some((r) => r?.char.id === c.id && r.pending));
    for (const c of choices) {
        const o = ordered[choices.indexOf(c)];
        if (o?.intent.kind === 'move' && typeof o.intent.to === 'number' && along.length) c.item.label += ` (with ${along.map((m) => m.name).join(', ')})`;
    }
    // party-wide rest (each member's own tx, all at once)
    if (mates.length) {
        const all = [ch, ...mates];
        const names = all.map((m) => m.name).join(', ');
        for (const o of opts.options.filter((x) => x.intent.kind === 'rest'))
            choices.push({
                item: { label: `Party: everyone ${everyone(describeIntent(o.intent, cast))} (${names})`, note: o.needsRoll ? '🎲' : '' },
                run: () => together(all, o.intent, hostile)
            });
    }
    if (atGate) {
        // extracting is how you heal between trips (SPEC §3.5): full HP, abilities and the short rest back
        const extractAll = (leavers: Character[]) =>
            allAtOnce(leavers, (m) => s.extract(m.id), (m) => `${m.name} steps out through the Lychgate with ${m.carriedGold}g and rests at camp: ${m.hp < m.maxHp ? `healed to ${m.maxHp}/${m.maxHp}, ` : ''}abilities back.`);
        const heals = (cs: Character[]) => {
            const hurt = cs.filter((c) => c.hp < c.maxHp);
            return hurt.length ? `<span class="good">heals ${hurt.map((c) => `${esc(c.name)} ${c.hp}→${c.maxHp}`).join(', ')}</span>` : '';
        };
        const leave: typeof choices = [
            { item: { label: `Extract ${ch.name}: rest at camp (full HP and abilities back), bank carried gold, stash items`, note: heals([ch]) }, run: () => extractAll([ch]) }
        ];
        if (mates.length) {
            const all = [ch, ...mates];
            leave.push({ item: { label: `Party: everyone extracts and rests at camp (${all.map((m) => m.name).join(', ')})`, note: heals(all) }, run: () => extractAll(all) });
        }
        // hurt? resting at camp is the first thing offered
        if ([ch, ...mates].some((c) => c.hp < c.maxHp)) choices.unshift(...leave);
        else choices.push(...leave);
    }
    shown = optionsKey(opts.options);
    if (!choices.length) {
        // downed, or nothing to do: wait for the world (a rescue, the Ferryman); "look" or a change reprints
        term.say(party.length > 1 ? `${ch.name} can only wait. (Click another name in the bar, or type next.)` : 'Nothing to do but wait. (Type help for commands.)', 'dim');
        await term.menu([{ label: 'Look again' }]);
        return false;
    }
    const pick = await term.menu(choices.map((c) => c.item));
    if (!('index' in pick)) return false; // refreshed: the loop prints what changed
    await guard(choices[pick.index].run);
    return true;
}

/** "Go to the Ossuary Hall" -> "goes to the Ossuary Hall", for "Party: everyone goes to…". */
const everyone = (label: string) => {
    const [first, ...rest] = label.split(' ');
    return [thirdPerson(first.toLowerCase()), ...rest].join(' ');
};

function printMonsters(rs: RoomState): void {
    for (const [i, m] of rs.monsters.entries()) {
        if (m.status === 'dead' || m.status === 'fled' || m.status === 'disguised') continue;
        const max = content.registry.monsters[m.template].hp;
        term.html(`<span class="bad">${esc(`${monsterName(m.template)} #${i + 1}`.padEnd(18))}</span>${bar(m.hp, max)} ${String(m.hp).padStart(2)}/${max}${m.status === 'hostile' ? '' : ` <span class="dim">${esc(m.status)}</span>`}`);
    }
}

function printFloor(rs: RoomState): void {
    if (rs.pileGold || rs.pile.length) term.say(`On the floor: ${[rs.pileGold ? `${rs.pileGold}g` : '', ...rs.pile.map((i) => itemName(i.template))].filter(Boolean).join(', ')}`, 'warn');
    if (rs.corpses.length) term.say(`${rs.corpses.length} fallen delver’s cache${rs.corpses.length > 1 ? 's' : ''} lie here.`, 'warn');
}

/** The fight on one line, as a MUD prompt shows it: the round, each foe's condition, and yours. */
function printStrip(rs: RoomState, ch: Character): void {
    const f = fightStatus(rs, ch.hp, ch.maxHp);
    const foes = f.monsters.map((m) => `${esc(m.label)} <span class="dim">${condition(m.hp, m.max)}</span> ${bar(m.hp, m.max, 6)} ${m.hp}/${m.max}`);
    term.html(`<span class="dim">⚔ round ${fight.round} ·</span> ${foes.join(' <span class="dim">·</span> ')} <span class="dim">· ${esc(ch.name)}</span> ${bar(ch.hp, ch.maxHp, 6)} ${ch.hp}/${ch.maxHp}`, 'strip');
}

/** Who else is here, printed on arrival and whenever it changes. */
function printHere(others: Character[], h: number): void {
    const awake = others.filter((o) => o.status === 'delving' && h - o.lastActionHeight <= LIE_LOW_BLOCKS);
    const downed = others.filter((o) => o.status === 'downed');
    const idle = others.length - awake.length - downed.length;
    const parts = [...awake.slice(0, 6).map((o) => `${esc(o.name)} <span class="dim">(${esc(o.classId)})</span>`), idle > 0 ? `<span class="dim">${idle} idle delver${idle > 1 ? 's' : ''}</span>` : ''].filter(Boolean);
    const line = others.length ? `Also here: ${parts.join(', ')}${downed.length ? ` <span class="bad">downed: ${downed.map((o) => esc(o.name)).join(', ')}</span>` : ''}` : '';
    if (line === hereShown) return;
    hereShown = line;
    if (line) term.html(line);
}

function oddsText(o: OptionEntry): string {
    if (!o.odds) return '';
    return `${Math.round(o.odds.bp / 100)}% ${o.odds.kind === 'attack' ? `vs AC ${o.odds.target}` : `DC ${o.odds.target}`}${o.odds.advantage ? ' adv' : ''}${o.odds.disadvantage ? ' dis' : ''}`;
}

async function act(ch: Character, o: OptionEntry, cast: Cast, hostile: boolean): Promise<void> {
    await tellOutcome(ch, o, cast, hostile, await s.act(ch.id, o.intent, o.needsRoll, progress()));
}

/** Tell one exchange's outcome: a roll with its dice and verify link, or a dice-free action's story. */
async function tellOutcome(ch: Character, o: OptionEntry, cast: Cast, hostile: boolean, out: Outcome): Promise<void> {
    if (hostile) fight.round++;
    if (out.roll) await showResolution(ch, out.roll, cast, o.odds?.advantage ? 'advantage' : o.odds?.disadvantage ? 'disadvantage' : undefined);
    else {
        tally(out.events, ours());
        await showRecount(recount(o.intent, out.events, cast, ch.classId, [], ch.maxHp), out.events);
    }
}

/** A round as story first (typed), then its math on one quiet line with each outcome word coloured. */
async function showRecount(r: Recount, events: GameEvent[] = []): Promise<void> {
    for (const l of r.story) await term.type(l.text, `story ${l.tone}`);
    for (const p of progressMade(L1, events)) await term.type(describeProgress(p), 'story good');
    if (!r.math.length) return;
    const parts = r.math.map((m) => esc(m.text).replace(/: (success|failure|hit|miss|saved|failed)\b/, (_x, w: string) => `: <span class="outcome ${m.tone}">${w}</span>`));
    term.html(`∑ ${parts.join(' · ')}`, 'roll');
}

async function showResolution(ch: Character, roll: RollRecord, castIn?: Cast, edge?: Edge): Promise<void> {
    const r = roll.resolved!;
    rolls.set(roll.id, roll);
    lastRoll = roll;
    if (r.outcome === 'fizzled') return void term.say(`${ch.name} can't: ${r.fizzled}. No dice, no counterattack.`, 'warn');
    if (r.outcome === 'forfeited') term.say('The reveal never landed: forfeited (your dice at 1, theirs at their max).', 'bad');
    // a move is told against the room it arrived in: whoever was waiting there is who the story names
    const arrived = arrival((r.events ?? []) as GameEvent[], ch.id);
    // a monster that turned up mid-exchange isn't in the room as it was read before: read it again to name it
    const spawned = (r.events ?? []).some((e) => (e as GameEvent).t === 'spawn');
    let cast = arrived === null && !spawned ? castIn : undefined;
    if (!cast) {
        const roomId = arrived ?? ch.room;
        const { room: rs, characters: here } = await s.room(ch.levelId, roomId);
        cast = castOf({ ...ch, room: roomId }, here.filter((x) => x.id !== ch.id), [rs], party);
    }
    // the progress line becomes the record: sealed, resolved, verify
    const record = `<span class="dim">🔒 sealed at block ${roll.committedAt} · resolved at ${r.height} ·</span> <a href="#" data-roll="${esc(roll.id)}">verify ▸</a>`;
    const line = progressLine ?? term.html('', 'dim');
    line.innerHTML = record;
    progressLine = null;
    const events = (r.events ?? []) as GameEvent[];
    // every die names who rolled it: characters by name, monsters (in red) by kind
    const roller = (g: { owner: string; by?: string }) => {
        const by = g.by ?? (g.owner === 'pc' ? ch.id : '');
        if (/^m\d+$/.test(by)) return `<span class="bad">${esc(monsterName(cast!.rooms.get(cast!.actorRoom)?.monsters[Number(by.slice(1))]?.template ?? 'foe'))}</span>`;
        if (!by) return g.owner === 'npc' ? '<span class="bad">the dark</span>' : 'someone';
        return esc(by === ch.id ? ch.name : (cast!.names.get(by) ?? 'someone'));
    };
    await term.diceLine(groupDice(r.dice, events, edge).map((g) => ({ ...g, who: roller(g), what: esc(purposeOf(g, roll.intent ?? null)) })));
    tally(events, ours());
    await showRecount(recount(roll.intent ?? { kind: 'rest' }, events, cast, ch.classId, r.dice, ch.maxHp), events);
    line.querySelector('a')!.addEventListener('click', (e) => {
        e.preventDefault();
        void printVerification(rolls.get(roll.id) ?? roll);
    });
}

// ---------------------------------------------------------------- printed views

function printSheet(ch: Character): void {
    term.rule(`${ch.name}, ${ch.classId}`);
    term.html(`HP ${bar(ch.hp, ch.maxHp)} ${ch.hp}/${ch.maxHp} · AC ${charAC(content, ch)} · hit dice ${ch.hitDice}${ch.rested ? ' · rested' : ''}`);
    term.html(statsTable(ch.stats));
    const abil = Object.entries(ch.abilityUses).filter(([, n]) => n > 0);
    if (abil.length) term.say(`Abilities: ${abil.map(([k, n]) => `${human(k)} ×${n}`).join(', ')}`);
    if (ch.statuses.length) term.say(`Conditions: ${ch.statuses.map((st) => `${human(st.id)} (${st.charges})`).join(', ')}`, 'warn');
    term.say(`Pack: ${ch.inventory.length ? ch.inventory.map((i) => itemName(i.template)).join(', ') : 'empty'}`);
    term.html(`Carried <span class="warn">${ch.carriedGold}g</span> <span class="dim">(lost to the Ferryman or the flood unless you extract)</span>`);
}

function visit(ch: Character): void {
    const all = readLocal<Record<string, number[]>>('visited', {});
    const v = new Set(all[ch.id] ?? []);
    if (v.has(ch.room)) return;
    v.add(ch.room);
    all[ch.id] = [...v];
    writeLocal('visited', all);
}

function printMap(ch: Character): void {
    // what the whole party has seen (on this device), where you stand, and the Lychgate everyone set out from
    const seen = readLocal<Record<string, number[]>>('visited', {});
    const visited = new Set([...(party.length ? party : [ch.id]).flatMap((id) => seen[id] ?? []), ch.room, CAMP]);
    const m = mapModel(L1, visited, ch.room);
    term.rule('Map');
    term.html(`<pre class="map">${m.lines.map((segs) => segs.map((sg) => ('text' in sg ? esc(sg.text) : `<span class="${sg.state}" title="${esc(roomTitle(sg.room))}">[${sg.state === 'known' ? '??' : sg.code}]</span>`)).join('')).join('\n')}</pre>`);
    term.say(m.legend.map((l) => `${l.code} ${l.title}`).join(' · '), 'dim');
    if (m.stairs) term.say('▼ stairs down (sealed until level 2 opens)', 'dim');
}

async function printVerification(roll: RollRecord): Promise<void> {
    const fresh = (await s.roll(roll.id)) ?? roll; // a pruned roll is checked from the copy kept here
    const v = verifyRoll(fresh, await s.beacon(fresh.committedAt));
    term.rule(`Roll ${roll.id.slice(0, 16)}…`);
    for (const c of v.checks) term.html(`${c.ok ? '<span class="good">✓</span>' : '<span class="bad">✗</span>'} ${esc(c.name)}: <span class="dim">${esc(c.detail)}</span>`);
    term.say(v.ok ? 'Verified: these dice follow from your sealed secret and the chain’s beacon.' : 'Verification failed.', v.ok ? 'good' : 'bad');
}

/** Others' doings since last time, printed inline. `all` reprints the recent ones even if already seen. */
async function printFeed(all: boolean): Promise<void> {
    if (!current) return;
    const seen = readLocal<Record<string, number>>('feed', {});
    const { lines, tip } = await feed.since(all ? 0 : (seen[current.id] ?? 0));
    seen[current.id] = tip;
    writeLocal('feed', seen);
    const tone = { plain: '', quiet: 'dim', good: 'good', warn: 'warn', bad: 'bad' } as const;
    if (all && !lines.length) term.say('Quiet, for now.', 'dim');
    for (const l of lines.slice(-10)) term.html(`<span class="dim">[${l.height}]</span> <span class="${tone[l.tone]}">${esc(l.text)}</span><span class="${tone[l.tagTone]}">${esc(l.tag)}</span>`, 'feed');
}

// ---------------------------------------------------------------- live: the world moves while you read

const optionsKey = (opts: OptionEntry[]) => JSON.stringify(opts.map((o) => [o.intent, o.odds?.bp ?? null]));

/** Every block: others' doings print inline, the status bar updates, and the room reprints if your choices changed. */
async function live(): Promise<void> {
    if (!s || busy || document.visibilityState !== 'visible') return;
    if (current && term.atMenu) {
        await printFeed(false);
        const rec = await s.character(current.id);
        if (rec) current = rec.char;
        if (shown && (current.status === 'delving' || current.status === 'downed')) {
            const opts = await s.options(current.id);
            if (optionsKey(opts.options) !== shown && term.atMenu && !busy) {
                term.say('The room has changed.', 'dim');
                term.interrupt();
            }
        }
    }
    await status();
}

void main().catch((e) => {
    console.error(e);
    term.say(`Something went wrong: ${(e as Error).message}. Reload to try again.`, 'bad');
});
