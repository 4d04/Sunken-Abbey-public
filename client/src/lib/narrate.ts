/* Engine events -> lines of text, using the level's text pack (rules/levels/<level>/text.<lang>.json). */

import { type DieGroup, edgeOf } from './dicelog.ts';
import { type Character, DOWNED_SECONDS, type GameEvent, type Intent, type LevelDef, type RoomState } from '@abbey/rules';
import text from '../../../rules/levels/01-drowned-abbey/text.en.json' with { type: 'json' };
import { content } from './session.ts';

export interface TextPack {
    level: { title: string; intro: string };
    rooms: Record<string, { title: string; prose: string }>;
    actions: Record<string, string>;
    outcomes: Record<string, string>;
    monsters: Record<string, string>;
    items: Record<string, string>;
    map?: { rows: string[] };
}

export const TEXT = text as unknown as TextPack;
const L1: LevelDef = content.levels.get(1)!.def;

export const roomKey = (roomId: number, level: LevelDef = L1): string => level.rooms.find((r) => r.id === roomId)?.key ?? `room ${roomId}`;
export const roomTitle = (roomId: number): string => TEXT.rooms[roomKey(roomId)]?.title ?? `Room ${roomId}`;
export const itemName = (template: string): string => TEXT.items[template] ?? human(template);
export const monsterName = (template: string): string => TEXT.monsters[template] ?? human(template);
export const human = (id: string): string => id.replace(/[_.]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/**
 * Who's who while narrating: the acting character, everyone's names, the monsters in the actor's room, and which
 * characters are the reader's own (a party played from one account): their wins read green and their hurts red.
 * Everyone is told by name, the actor too, so a party's turns read unambiguously.
 */
export interface Cast {
    me: string; // the acting character's id
    names: Map<string, string>; // char id -> name
    rooms: Map<number, RoomState>; // room id -> state (monster templates by index)
    actorRoom: number;
    ours: Set<string>; // the reader's own characters (the actor, and the rest of their party)
}

export function castOf(me: Character, others: Character[], rooms: RoomState[], ours: Iterable<string> = [me.id]): Cast {
    return {
        me: me.id,
        names: new Map([me, ...others].map((c) => [c.id, c.name])),
        rooms: new Map(rooms.map((r) => [r.roomId, r])),
        actorRoom: me.room,
        ours: new Set([me.id, ...ours])
    };
}

/** A character by name, a monster as "the Skeleton". */
function who(cast: Cast, id: string, capital = true): string {
    if (/^m\d+$/.test(id)) return the(monsterAt(cast, cast.actorRoom, Number(id.slice(1))), capital);
    return cast.names.get(id) ?? (capital ? 'Someone' : 'someone');
}

/** Good or bad for the reader: their own characters' successes are good, their failures and hurts bad. */
export function toneFor(cast: Cast, id: string, good: boolean): LineTone {
    return cast.ours.has(id) ? (good ? 'good' : 'bad') : '';
}

function monsterAt(cast: Cast, room: number, index: number): string {
    const m = cast.rooms.get(room)?.monsters[index];
    return m ? monsterName(m.template) : 'the creature';
}

const sentenceCase = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
const the = (name: string, capital: boolean): string => `${capital ? 'The' : 'the'} ${name}`;
const dice = (d20: number[], kept: number): string => {
    if (d20.length < 2) return `${kept}`;
    const edge = edgeOf(d20, kept);
    return `${edge ? `${edge === 'advantage' ? 'ADV' : 'DIS'} ` : ''}[${d20.join(', ')}] → ${kept}`;
};

/**
 * What a line is, so a front end can make the story stand out and keep the math readable but quiet:
 * story (what happens), roll (the dice and the numbers behind them), effect (what changed: damage, healing, gold, items).
 */
export type LineKind = 'story' | 'roll' | 'effect';
/** Good or bad for the player reading it ('' when neither). */
export type LineTone = 'good' | 'bad' | '';

export interface Told {
    text: string;
    kind: LineKind;
    tone: LineTone;
}

/** Narrate one exchange's events as tagged lines. Bookkeeping events (counters, flags) are left out. */
export function tell(events: GameEvent[], cast: Cast): Told[] {
    const out: Told[] = [];
    const say = (kind: LineKind, text: string, tone: LineTone = '') => out.push({ text, kind, tone });
    const mine = (ok: boolean, id: string): LineTone => toneFor(cast, id, ok);
    for (const e of events) {
        switch (e.t) {
            case 'check':
                say('roll', `${who(cast, e.char)} rolls ${e.ability}: d20 ${dice(e.d20, e.kept)} ${sign(e.mod)} = ${e.total} vs DC ${e.dc}: ${e.success ? 'success' : 'failure'}${e.auto ? ' (automatic)' : ''}.`, mine(e.success, e.char));
                break;
            case 'attack':
                say('roll', `${who(cast, e.attacker)} attacks ${who(cast, e.target, false)}: d20 ${dice(e.d20, e.kept)}, ${e.total} vs AC ${e.ac}: ${e.hit ? 'hit' : 'miss'}.`, cast.ours.has(e.attacker) ? (e.hit ? 'good' : 'bad') : cast.ours.has(e.target) ? (e.hit ? 'bad' : 'good') : '');
                break;
            case 'damage':
                say('effect', `${who(cast, e.target)} takes ${e.amount} damage (${e.hp} HP left).`, cast.ours.has(e.target) ? 'bad' : /^m\d+$/.test(e.target) ? 'good' : '');
                break;
            case 'heal':
                say('effect', `${who(cast, e.target)} heals ${e.amount} (${e.hp} HP).`, 'good');
                break;
            case 'save':
                say('roll', `${who(cast, e.who)} saves vs ${e.ability}: ${dice(e.d20, e.kept)} → ${e.total} vs DC ${e.dc}: ${e.success ? 'saved' : 'failed'}.`, mine(e.success, e.who));
                break;
            case 'monster':
                say('story', `${the(monsterAt(cast, e.room, e.index), true)} ${e.status === 'dead' ? 'falls' : e.status === 'fled' ? 'flees' : `is now ${e.status}`}.`, e.status === 'dead' || e.status === 'fled' ? 'good' : '');
                break;
            case 'spawn':
                say('story', `A ${monsterName(e.template)} appears!`, 'bad');
                break;
            case 'downed':
                say('story', `${who(cast, e.char)} collapses, downed! Someone has ${Math.round(DOWNED_SECONDS / 60)} minutes to stabilize them.`, 'bad');
                break;
            case 'died':
                say('story', `${who(cast, e.char)} is gone.`, 'bad');
                break;
            case 'stabilized':
                say('story', `${who(cast, e.char)} is stabilized by ${who(cast, e.by, false)}.`, 'good');
                break;
            case 'gold':
                if (e.delta > 0) say('effect', `${who(cast, e.char)} picks up ${e.delta}g.`, mine(true, e.char));
                else if (e.delta < 0) say('effect', `${who(cast, e.char)} loses ${-e.delta}g.`, mine(false, e.char));
                break;
            case 'item': {
                const name = itemName(e.template);
                const v = { inventory: ['take', 'takes'], pile: ['drop', 'drops'], consumed: ['use', 'uses'], taken: ['take', 'takes'] }[e.to];
                say('effect', `${who(cast, e.char)} ${v[1]} ${aOrAn(name)}.`);
                break;
            }
            case 'status':
                say('effect', e.charges > 0 ? `${who(cast, e.char)} is ${human(e.status).toLowerCase()} (${e.charges}).` : `${who(cast, e.char)} is no longer ${human(e.status).toLowerCase()}.`);
                break;
            case 'move':
                say('story', `${who(cast, e.char)} goes to the ${roomTitle(e.room)}.`);
                break;
            case 'loot':
                if (e.already) say('story', 'Someone got here first: nothing left.');
                else if (e.gold || e.items.length) say('effect', `Loot: ${[e.gold ? `${e.gold}g` : '', ...e.items.map(itemName)].filter(Boolean).join(', ')}.`, 'good');
                break;
            case 'bossDefeated':
                say('story', `*** The Drowned Abbot is defeated, by ${who(cast, e.by, false)}! The bell will toll for the flood. ***`, 'good');
                break;
            case 'tideWail':
                say('story', 'The Abbot raises a Tide Wail: black water crashes through the room!', 'bad');
                break;
            case 'recovered':
                say('story', `${the(monsterAt(cast, e.room, e.index), true)} recovers, wounds closing (${e.hp} HP).`, 'bad');
                break;
            case 'initiative': {
                // who struck first (the ambush and quick variants); the story says it, the roll line shows the d20s
                const it = who(cast, e.monster);
                const them = e.first === 'them';
                const tone: LineTone = toneFor(cast, e.char, !them);
                const you = who(cast, e.char, false);
                if (e.reason === 'quick') say('story', `${it} darts in before ${you} can act!`, tone);
                else if (e.reason === 'ambush') say('story', them ? `${it} was waiting: it strikes as ${you} steps in!` : `${sentenceCase(you)} steps in ready, before ${who(cast, e.monster, false)} can strike.`, tone);
                else say('story', them ? `${it} is quicker.` : `${sentenceCase(you)} is quicker than ${who(cast, e.monster, false)}.`, tone);
                if (e.you && e.them) {
                    const yd = e.you.total - e.you.d20;
                    const td = e.them.total - e.them.d20;
                    say('roll', `Initiative: ${you} d20 ${e.you.d20} ${sign(yd)} = ${e.you.total} vs ${who(cast, e.monster, false)} d20 ${e.them.d20} ${sign(td)} = ${e.them.total}: ${them ? 'failure' : 'success'}.`, tone);
                }
                break;
            }
            case 'narrate':
                say('story', TEXT.outcomes[e.outcome] ?? human(e.outcome));
                break;
            case 'pool':
                if (e.value > 0) say('effect', `The ${e.pool} now holds ${e.value}g.`);
                break;
            case 'outcome':
            case 'flag':
            case 'counter':
            case 'charFlag':
                break;
        }
    }
    return out;
}

/** Where an exchange left the player, if it moved them within the level: its monsters are the ones the story names. */
export function arrival(events: GameEvent[], me: string): number | null {
    const m = events.find((e) => e.t === 'move' && e.char === me) as Extract<GameEvent, { t: 'move' }> | undefined;
    return m ? m.room : null;
}

/**
 * What a die was rolled for, in a word or two for the dice line: "attack", "damage", "initiative", "DEX save", or for
 * the actor's own check the action it was for ("sneak", "search", "flee", "stabilize").
 */
export function purposeOf(g: Pick<DieGroup, 'purpose' | 'ability' | 'owner'>, intent: Intent | null): string {
    if (g.purpose === 'save') return `${g.ability ?? ''} save`.trim();
    if (g.purpose !== 'check') return g.purpose;
    if (intent?.kind === 'action') return (TEXT.actions[intent.actionId] ?? human(intent.actionId.split('.').pop()!)).split(/\s+/)[0].toLowerCase();
    if (intent?.kind === 'move') return 'flee';
    if (intent?.kind === 'stabilize') return 'stabilize';
    return `${g.ability ?? ''} check`.trim();
}

/** Narrate one exchange's events as plain lines. */
export function narrate(events: GameEvent[], cast: Cast): string[] {
    return tell(events, cast).map((t) => t.text);
}

/** A menu label for an intent. */
export function describeIntent(intent: Intent, cast: Cast): string {
    switch (intent.kind) {
        case 'action':
            return TEXT.actions[intent.actionId] ?? human(intent.actionId.split('.').pop()!);
        case 'attack':
            return `Attack ${monsterAt(cast, cast.actorRoom, intent.target).toLowerCase()} #${intent.target + 1}${intent.weapon ? ' (with an item)' : ''}`;
        case 'ability':
            if (intent.target === cast.me) return `${human(intent.ability)} yourself`;
            return `${human(intent.ability)}${intent.target === undefined ? '' : typeof intent.target === 'number' ? ` at ${monsterAt(cast, cast.actorRoom, intent.target).toLowerCase()} #${intent.target + 1}` : ` on ${who(cast, intent.target, false)}`}`;
        case 'useItem':
            return `Use an item${intent.target && intent.target !== cast.me ? ` on ${who(cast, intent.target, false)}` : ''}`;
        case 'move':
            return typeof intent.to === 'number' ? `Go to the ${roomTitle(intent.to)}` : `Descend to level ${intent.to.level}`;
        case 'rest':
            return 'Take a short rest';
        case 'take':
            return intent.lootRef === 'pile' ? 'Take what lies here' : `Take ${intent.lootRef.startsWith('corpse:') ? "a fallen delver's cache" : intent.lootRef}`;
        case 'stabilize':
            return `Stabilize ${who(cast, intent.target, false)}`;
    }
}

const sign = (n: number): string => (n < 0 ? `- ${-n}` : `+ ${n}`);
const aOrAn = (name: string): string => `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
