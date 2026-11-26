/*
 * A roll's die log, grouped for display: each d20 is tied to the check, save, attack or initiative it decided, so the
 * dice line can name who rolled it and mark the winning roll, and a d20 rolled with advantage or disadvantage shows as
 * one pair ("DIS: Wren's sneak 2d20 [18, 1]", the 18 struck through) rather than as two separate rolls.
 */

import type { DieRoll, GameEvent } from '@abbey/rules';

export type Edge = 'advantage' | 'disadvantage';

export interface DieGroup {
    owner: 'pc' | 'npc';
    sides: number;
    values: number[]; // one die, or the pair in the order rolled
    kept: number; // index into values of the die that counts
    edge?: Edge; // set for a pair; unknown only when both dice show the same face and nothing says which
    by?: string; // who rolled it (a character id, or m<index> for a monster), when the events say
    won?: boolean; // for a d20: whether it won (check or save made, attack hit, initiative taken)
    purpose: Purpose; // what it was rolled for
    ability?: string; // for a check or save: the ability rolled (DEX, WIS…)
}

/** What a die was rolled for: a d20 by the event it decided; other dice by what they came to (damage or healing). */
export type Purpose = 'attack' | 'check' | 'save' | 'initiative' | 'damage' | 'heal' | 'wandering' | 'roll';

/** Which way a pair went, from the faces: the higher kept is advantage, the lower disadvantage. */
export function edgeOf(d20: number[], kept: number): Edge | undefined {
    if (d20.length !== 2 || d20[0] === d20[1]) return undefined;
    return kept === Math.max(...d20) ? 'advantage' : 'disadvantage';
}

interface Claim {
    purpose: 'attack' | 'check' | 'save' | 'initiative';
    ability?: string;
    owner: 'pc' | 'npc';
    values: number[];
    kept: number;
    by: string;
    won: boolean;
}

const ownerOf = (id: string): 'pc' | 'npc' => (/^m\d+$/.test(id) ? 'npc' : 'pc');

/** Every d20 the events report, in the order the engine rolled them. */
function claims(events: GameEvent[]): Claim[] {
    const out: Claim[] = [];
    for (const e of events) {
        if (e.t === 'check' && e.d20.length) out.push({ purpose: 'check', ability: e.ability, owner: 'pc', values: e.d20, kept: e.kept, by: e.char, won: e.success });
        else if (e.t === 'save' && e.d20.length) out.push({ purpose: 'save', ability: e.ability, owner: ownerOf(e.who), values: e.d20, kept: e.kept, by: e.who, won: e.success });
        else if (e.t === 'attack' && e.d20.length) out.push({ purpose: 'attack', owner: ownerOf(e.attacker), values: e.d20, kept: e.kept, by: e.attacker, won: e.hit });
        else if (e.t === 'initiative' && e.you && e.them) {
            out.push({ purpose: 'initiative', owner: 'pc', values: [e.you.d20], kept: e.you.d20, by: e.char, won: e.first === 'you' });
            out.push({ purpose: 'initiative', owner: 'npc', values: [e.them.d20], kept: e.them.d20, by: e.monster, won: e.first === 'them' });
        }
    }
    return out;
}

/**
 * Group a die log by the events it produced. Each d20 claim takes the next matching d20s in the log (rolls are logged in
 * the order the engine made them); other dice (damage) belong to whoever of that side rolled a d20 last. `hint` names
 * the edge of the player's own first pair when its faces tie (the menu knew it).
 */
export function groupDice(dice: DieRoll[], events: GameEvent[], hint?: Edge): DieGroup[] {
    const want = claims(events);
    const out: DieGroup[] = [];
    const last: Partial<Record<'pc' | 'npc', Claim>> = {};
    // dice that aren't d20s: damage after an attack; otherwise whatever the exchange came to
    const healed = events.some((e) => e.t === 'heal');
    const hurt = events.some((e) => e.t === 'damage');
    const spawned = events.some((e) => e.t === 'spawn');
    // a monster's dice before it has swung: which wandering monster turns up (and how many), not damage
    const other = (owner: 'pc' | 'npc'): Purpose =>
        last[owner]?.purpose === 'attack' ? 'damage' : owner === 'npc' && spawned && !last.npc ? 'wandering' : healed && owner === 'pc' ? 'heal' : hurt ? 'damage' : 'roll';
    let p = 0;
    let hinted = false;
    for (let i = 0; i < dice.length; i++) {
        const d = dice[i];
        const c = d.sides === 20 ? want.slice(p).findIndex((w) => w.owner === d.owner && w.values.every((v, j) => dice[i + j]?.sides === 20 && dice[i + j]?.owner === d.owner && dice[i + j]?.value === v)) : -1;
        if (c < 0) {
            out.push({ owner: d.owner, sides: d.sides, values: [d.value], kept: 0, by: last[d.owner]?.by, purpose: other(d.owner) });
            continue;
        }
        const w = want[p + c];
        p += c + 1;
        last[d.owner] = w;
        let edge = w.values.length === 2 ? edgeOf(w.values, w.kept) : undefined;
        if (w.values.length === 2 && !edge && d.owner === 'pc' && !hinted) edge = hint;
        if (w.values.length === 2 && d.owner === 'pc') hinted = true;
        out.push({ owner: d.owner, sides: 20, values: w.values, kept: w.values[0] === w.kept ? 0 : 1, edge, by: w.by, won: w.won, purpose: w.purpose, ...(w.ability ? { ability: w.ability } : {}) });
        i += w.values.length - 1;
    }
    return out;
}
