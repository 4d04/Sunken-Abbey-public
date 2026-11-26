/*
 * A round, told as a beat of a fight rather than a ledger: what you did and what it led to in a few sentences, the
 * arithmetic behind it on one quiet line, and where the fight stands on another. Built from the engine's events, so
 * every number in the math line is the one the chain used.
 */

import type { DieRoll, GameEvent, Intent, RoomState } from '@abbey/rules';
import { type Cast, type LineTone, TEXT, human, monsterName, tell, toneFor } from './narrate.ts';
import { content } from './session.ts';

export interface StorySentence {
    text: string;
    tone: LineTone;
}

export interface Recount {
    story: StorySentence[];
    math: StorySentence[]; // the rolls behind the story, for one line (empty when nothing was rolled); tone colours the outcome word
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const aOrAn = (w: string) => `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;

/** "search" -> "searches", "pry" -> "pries", "parley" -> "parleys": the third person of an action's leading verb. */
export function thirdPerson(verb: string): string {
    if (/[^aeiou]y$/i.test(verb)) return `${verb.slice(0, -1)}ies`;
    if (/(s|sh|ch|x|z|o)$/i.test(verb)) return `${verb}es`;
    return `${verb}s`;
}

/** An action label ("Search the silt", "Cross holding your rope") as what a character does: "searches the silt". */
function does(label: string): string {
    const [first, ...rest] = lower(label).split(' ');
    return [thirdPerson(first), ...rest].join(' ').replace(/\byour\b/g, 'a');
}

/**
 * How hard a blow landed, as MUDs tell it: a verb scaled to the damage against the target's full health, so the story
 * reads as a fight and the number stays alongside for anyone following the math.
 */
export function blow(amount: number, max: number): [you: string, it: string] {
    const f = max > 0 ? amount / max : 1;
    if (f >= 0.75) return ['devastate', 'devastates'];
    if (f >= 0.5) return ['maul', 'mauls'];
    if (f >= 0.3) return ['wound', 'wounds'];
    if (f >= 0.15) return ['hit', 'hits'];
    return ['graze', 'grazes'];
}

/** A creature's state in a word, as MUD prompts show it. */
export function condition(hp: number, max: number): string {
    const f = max > 0 ? hp / max : 0;
    if (hp <= 0) return 'down';
    if (f >= 1) return 'unhurt';
    if (f > 0.75) return 'scratched';
    if (f > 0.5) return 'wounded';
    if (f > 0.25) return 'badly wounded';
    return 'barely standing';
}
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function templateOf(cast: Cast, id: string): string | undefined {
    const m = /^m(\d+)$/.exec(id);
    return m ? cast.rooms.get(cast.actorRoom)?.monsters[Number(m[1])]?.template : undefined;
}

function monsterOf(cast: Cast, id: string): string {
    const tpl = templateOf(cast, id);
    return tpl ? monsterName(tpl) : 'creature';
}

/** Full health of whoever was hit: a monster's from the registry, the actor's from the sheet. */
function maxOf(cast: Cast, id: string, yourMax: number): number {
    const tpl = templateOf(cast, id);
    return tpl ? content.registry.monsters[tpl].hp : id === cast.me ? yourMax : 20;
}

/** "the Skeleton's rusted blade" */
function weaponOf(cast: Cast, id: string): string {
    const tpl = templateOf(cast, id);
    const w = tpl ? content.registry.monsters[tpl].attack.name : '';
    return w ? `the ${monsterOf(cast, id)}'s ${human(w).toLowerCase()}` : name(cast, id);
}

/** "the Skeleton", or a character's name. */
function name(cast: Cast, id: string): string {
    if (/^m\d+$/.test(id)) return `the ${monsterOf(cast, id)}`;
    return cast.names.get(id) ?? 'someone';
}

/** How the round opened: the actor's own action, as a sentence fragment told by name ("Wren searches the silt"). */
function opening(intent: Intent, cast: Cast, classId: string): string {
    const me = name(cast, cast.me);
    switch (intent.kind) {
        case 'attack': {
            const weapon = human(content.registry.classes[classId]?.attack.name ?? 'weapon').toLowerCase();
            return `${me} ${weapon === 'fire bolt' ? 'hurls a fire bolt' : `swings ${aOrAn(weapon)}`} at the ${monsterOf(cast, `m${intent.target}`)}`;
        }
        case 'ability':
            if (intent.ability === 'magic_missile') return `${me} looses a Magic Missile at the ${monsterOf(cast, `m${intent.target}`)}`;
            if (intent.ability === 'heal') return intent.target === cast.me || intent.target === undefined ? `${me} calls down healing` : `${me} calls down healing on ${name(cast, String(intent.target))}`;
            if (intent.ability === 'second_wind') return `${me} catches a second wind`;
            if (intent.ability === 'turn_undead') return `${me} raises a holy symbol against the dead`;
            return `${me} uses ${human(intent.ability)}`;
        case 'action':
            return `${me} ${does(TEXT.actions[intent.actionId] ?? human(intent.actionId.split('.').pop()!))}`;
        case 'useItem':
            return `${me} uses an item`;
        case 'rest':
            return `${me} takes a short rest`;
        case 'take':
            return `${me} gathers what lies here`;
        case 'stabilize':
            return `${me} kneels to stabilize ${name(cast, intent.target)}`;
        case 'move':
            return '';
    }
}

/**
 * Tell one exchange: the player's action and its result as sentences, each monster's answer, deaths and spoils; then
 * the rolls on one line. `dice` is the roll's die log (empty for dice-free actions).
 */
export function recount(intent: Intent, events: GameEvent[], cast: Cast, classId: string, dice: DieRoll[], yourMax: number): Recount {
    const story: StorySentence[] = [];
    let open = opening(intent, cast, classId);
    let openTone: LineTone = '';
    const flush = () => {
        if (open) story.push({ text: `${open}.`, tone: openTone });
        open = '';
    };
    const used = new Set<number>();
    // a monster that wins initiative strikes before your action: its blow is told first, your action after it
    let held = false;
    let struckFirst = false;
    for (let i = 0; i < events.length; i++) {
        if (used.has(i)) continue;
        const e = events[i];
        if (e.t === 'initiative') {
            for (const t of tell([e], cast).filter((x) => x.kind !== 'roll')) story.push({ text: t.text, tone: t.tone });
            held = e.first === 'them';
            struckFirst = held;
            continue;
        }
        if (e.t === 'downed' && e.char === cast.me && struckFirst) open = ''; // struck down before acting: the action never happened
        if (e.t === 'check' && e.char === cast.me && open) {
            // a failed action didn't happen: "Wren tries to sneak past…, but fails"
            if (!e.success && intent.kind === 'action') open = `${name(cast, cast.me)} tries to ${lower(TEXT.actions[intent.actionId] ?? human(intent.actionId.split('.').pop()!)).replace(/\byour\b/g, 'a')}`;
            open += e.success ? ', and succeeds' : ', but fails';
            openTone = e.success ? 'good' : 'bad';
            continue;
        }
        if (e.t === 'attack') {
            // an attack and the damage it dealt, as one sentence
            const j = events.findIndex((x, k) => k > i && !used.has(k) && x.t === 'damage' && x.target === e.target);
            const dmg = e.hit && j > i ? (events[j] as Extract<GameEvent, { t: 'damage' }>) : null;
            if (dmg) used.add(j);
            const crit = e.kept === 20 && e.hit;
            const amount = dmg?.amount ?? 0;
            const itVerb = blow(amount, maxOf(cast, e.target, yourMax))[1];
            if (e.attacker === cast.me && open) {
                open += e.hit ? ` and ${crit ? `lands a critical blow that ${itVerb} it` : `${itVerb} it`} (${amount})` : ', but misses';
                openTone = e.hit ? 'good' : 'bad';
                continue;
            }
            if (held && e.attacker !== cast.me) held = false;
            else flush();
            const t = name(cast, e.target);
            const tone: LineTone = cast.ours.has(e.target) ? (e.hit ? 'bad' : 'good') : cast.ours.has(e.attacker) ? (e.hit ? 'good' : 'bad') : '';
            if (!/^m\d+$/.test(e.attacker)) story.push({ text: e.hit ? `${name(cast, e.attacker)} ${crit ? 'lands a critical blow and ' : ''}${itVerb} ${t} (${amount}).` : `${name(cast, e.attacker)} misses ${t}.`, tone });
            else if (!e.hit) story.push({ text: sentence(`${weaponOf(cast, e.attacker)} swings at ${t} and misses.`), tone });
            else story.push({ text: sentence(`${crit ? 'A critical blow: ' : ''}${weaponOf(cast, e.attacker)} ${itVerb} ${t} (${amount}${dmg && cast.ours.has(e.target) ? `, ${dmg.hp} HP left` : ''}).`), tone });
            continue;
        }
        if (e.t === 'damage' && open && intent.kind !== 'attack') {
            open += `: ${e.amount} damage`;
            openTone = toneFor(cast, e.target, false) || 'good';
            continue;
        }
        if (e.t === 'heal' && open && (intent.kind === 'ability' || intent.kind === 'useItem')) {
            open += `: ${e.amount} HP back (${e.hp})`;
            openTone = 'good';
            continue;
        }
        if (e.t === 'monster' && e.status === 'dead') {
            flush();
            story.push({ text: `The ${monsterOf(cast, `m${e.index}`)} falls!`, tone: 'good' });
            continue;
        }
        // bookkeeping and the math stay out of the story; everything else is told as the narrator tells it
        if (e.t === 'check' || e.t === 'save' || e.t === 'outcome' || e.t === 'counter' || e.t === 'flag' || e.t === 'charFlag') continue;
        const told = tell([e], cast).filter((t) => t.kind !== 'roll');
        if (!told.length) continue;
        flush();
        for (const t of told) story.push({ text: t.text, tone: t.tone });
    }
    flush();

    // the math: every check, save and attack in the round, then the dice that made them
    const rolls = tell(events, cast)
        .filter((t) => t.kind === 'roll')
        .map((t) => ({ text: t.text.replace(/\.$/, ''), tone: t.tone }));
    // damage: the dice beyond the d20s, and what they came to (the dice line already shows every face)
    // damage dice: those a side rolls after its first d20 (a monster's earlier dice pick which wandering monster appears)
    const dmgDice = (owner: 'pc' | 'npc') => {
        const first = dice.findIndex((d) => d.owner === owner && d.sides === 20);
        return dice.filter((d, i) => d.owner === owner && d.sides !== 20 && (owner === 'pc' || (first >= 0 && i > first))).map((d) => `d${d.sides} ${d.value}`);
    };
    const dealt = events.reduce((n, e) => (e.t === 'damage' && e.target !== cast.me ? n + e.amount : n), 0);
    const taken = events.reduce((n, e) => (e.t === 'damage' && e.target === cast.me ? n + e.amount : n), 0);
    const extra: StorySentence[] = [];
    if (dmgDice('pc').length && dealt) extra.push({ text: `${name(cast, cast.me)}'s damage ${dmgDice('pc').join(' + ')} → ${dealt}`, tone: '' });
    if (dmgDice('npc').length && taken) extra.push({ text: `foes' damage ${dmgDice('npc').join(' + ')} → ${taken}`, tone: '' });
    return { story, math: [...rolls, ...extra] };
}

/** Where a fight stands, on one line: the hostiles left (with HP) and the actor. */
export function fightStatus(room: RoomState, hp: number, maxHp: number): { monsters: { label: string; hp: number; max: number }[]; you: { hp: number; max: number } } {
    const monsters = room.monsters
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => m.status === 'hostile' || m.status === 'wary')
        .map(({ m, i }) => ({ label: `${monsterName(m.template)} #${i + 1}`, hp: m.hp, max: content.registry.monsters[m.template].hp }));
    return { monsters, you: { hp, max: maxHp } };
}
