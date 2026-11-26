/* Assigning the six rolled scores: a suggestion per class, and parsing a player's own order. */

import { ABILITIES } from '@abbey/rules';

const PRIORITY: Record<string, string[]> = {
    fighter: ['STR', 'CON', 'DEX', 'WIS', 'CHA', 'INT'],
    rogue: ['DEX', 'CON', 'WIS', 'INT', 'CHA', 'STR'],
    cleric: ['WIS', 'CON', 'STR', 'CHA', 'DEX', 'INT'],
    wizard: ['INT', 'CON', 'DEX', 'WIS', 'CHA', 'STR']
};

/** permutation[i] = which rolled score goes to ability i (STR DEX CON INT WIS CHA): the highest to the class's key ability. */
export function suggestAssignment(classId: string, rolled: number[]): number[] {
    const order = PRIORITY[classId] ?? [...ABILITIES];
    const sorted = rolled.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
    return ABILITIES.map((ab) => sorted[order.indexOf(ab)][1]);
}

/** Scores in STR..CHA order, as a permutation of the rolled ones; null if they aren't a reordering of them. */
export function assignmentFrom(rolled: number[], scores: number[]): number[] | null {
    if (scores.length !== 6) return null;
    const used = rolled.map(() => false);
    const out: number[] = [];
    for (const v of scores) {
        const i = rolled.findIndex((r, k) => !used[k] && r === v);
        if (i < 0) return null;
        used[i] = true;
        out.push(i);
    }
    return out;
}
