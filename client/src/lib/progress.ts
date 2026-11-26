/*
 * Shared work that takes several successes (the Cloister's rubble needs two): how far along it is, read from the
 * level data, so any future job like it is shown the same way. The counter lives on the room, so anyone's success
 * counts and a cleared way stays open for everyone until the season resets.
 */

import type { GameEvent, LevelDef, RoomState } from '@abbey/rules';
import { TEXT, human, roomTitle } from './narrate.ts';

export interface Progress {
    actionId: string;
    label: string; // the action, as the menu says it ("Clear the rubble on the east walk")
    counter: string;
    value: number;
    goal: number;
    opens?: number; // the room the finished job opens the way to
}

/** The multi-step jobs in this room: an action offered while a room counter is below its goal. */
function jobs(level: LevelDef, roomId: number): Omit<Progress, 'value'>[] {
    const out: Omit<Progress, 'value'>[] = [];
    for (const a of level.actions) {
        if (a.room !== roomId) continue;
        for (const c of a.when ?? []) {
            if (!('roomCounter' in c) || c.below === undefined || (c.room !== undefined && c.room !== roomId)) continue;
            const edge = level.edges.find((e) => e.from === roomId && (e.requires ?? []).some((r) => 'roomCounter' in r && r.roomCounter === c.roomCounter));
            out.push({
                actionId: a.id,
                label: TEXT.actions[a.id] ?? human(a.id.split('.').pop()!),
                counter: c.roomCounter,
                goal: c.below,
                ...(typeof edge?.to === 'number' ? { opens: edge.to } : {})
            });
        }
    }
    return out;
}

/** This room's jobs with their progress (including ones not started, and finished ones). */
export function roomProgress(level: LevelDef, rs: RoomState): Progress[] {
    return jobs(level, rs.roomId).map((j) => ({ ...j, value: Math.min(j.goal, rs.counters[j.counter] ?? 0) }));
}

/** The jobs an exchange moved forward, from its counter events. */
export function progressMade(level: LevelDef, events: GameEvent[]): Progress[] {
    const out: Progress[] = [];
    for (const e of events) {
        if (e.t !== 'counter') continue;
        const j = jobs(level, e.room).find((x) => x.counter === e.counter);
        if (j) out.push({ ...j, value: Math.min(j.goal, e.value) });
    }
    return out;
}

/** "Clear the rubble on the east walk: 1 of 2 done (anyone can finish it)." or, finished, the way it opened. */
export function describeProgress(p: Progress): string {
    if (p.value >= p.goal) return `${p.label}: done${p.opens !== undefined ? `. The way to the ${roomTitle(p.opens)} is open` : ''}.`;
    return `${p.label}: ${p.value} of ${p.goal} done (anyone's success counts).`;
}
