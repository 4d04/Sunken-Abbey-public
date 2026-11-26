/* The map model (SPEC §8): rooms visited, doors seen from them, where you stand. Renderers decide the look. Level 1 only. */

import type { LevelDef } from '@abbey/rules';
import { roomTitle } from './narrate.ts';

// grid positions (col, row) for level 1, laid out so every door is a straight line
const LAYOUT: Record<number, [number, number]> = {
    0: [0, 4], 1: [1, 4], 3: [1, 3], 6: [1, 2], 2: [2, 4], 4: [2, 5], 5: [3, 4],
    8: [3, 3], 7: [3, 2], 10: [3, 1], 9: [4, 2], 11: [5, 2], 12: [6, 2]
};
export const ROOM_CODE: Record<number, string> = { 0: 'LG', 1: 'NX', 2: 'OS', 3: 'CH', 4: 'SC', 5: 'CL', 6: 'BS', 7: 'RQ', 8: 'KI', 9: 'CB', 10: 'SA', 11: 'DC', 12: 'SE' };
export const CELL = 4; // a room is "[XX]"
const GAP = 2;

/** One line of the map: runs of plain characters, and rooms. */
export type MapSegment = { text: string } | { room: number; code: string; state: 'here' | 'visited' | 'known' };

export interface MapModel {
    lines: MapSegment[][];
    legend: { code: string; title: string }[];
    stairs: boolean;
}

export function mapModel(level: LevelDef, visited: Set<number>, here: number): MapModel {
    const edges = level.edges.filter((e) => typeof e.to === 'number') as { from: number; to: number; hidden?: boolean }[];
    // a room is known once visited or seen through an open door from a visited room; hidden doors show once used
    const known = new Set(visited);
    const shown = edges.filter((e) => {
        const seen = visited.has(e.from) || visited.has(e.to);
        const ok = seen && (!e.hidden || (visited.has(e.from) && visited.has(e.to)));
        if (ok) known.add(e.from).add(e.to);
        return ok;
    });
    const rows = 6;
    const width = 7 * (CELL + GAP);
    const grid: string[][] = Array.from({ length: rows * 2 }, () => Array(width).fill(' '));
    const x0 = (col: number) => col * (CELL + GAP);
    for (const e of shown) {
        const [ac, ar] = LAYOUT[e.from];
        const [bc, br] = LAYOUT[e.to];
        if (ar === br) for (let x = x0(Math.min(ac, bc)) + CELL; x < x0(Math.max(ac, bc)); x++) grid[ar * 2][x] = '─';
        else if (ac === bc) for (let y = Math.min(ar, br) * 2 + 1; y < Math.max(ar, br) * 2; y++) grid[y][x0(ac) + 1] = '│';
    }
    const stairs = level.edges.find((e) => typeof e.to !== 'number' && visited.has(e.from));
    if (stairs) {
        const [sc, sr] = LAYOUT[stairs.from];
        grid[sr * 2 + 1][x0(sc) + 1] = '▼';
    }
    const cells = [...known].map((id) => {
        const [col, row] = LAYOUT[id] ?? [0, 0];
        return { r: row * 2, x: x0(col), room: id, state: (id === here ? 'here' : visited.has(id) ? 'visited' : 'known') as 'here' | 'visited' | 'known' };
    });
    const lines: MapSegment[][] = [];
    for (let r = 1; r < rows * 2; r++) {
        const segs: MapSegment[] = [];
        let x = 0;
        for (const cell of cells.filter((k) => k.r === r).sort((a, b) => a.x - b.x)) {
            segs.push({ text: grid[r].slice(x, cell.x).join('') }, { room: cell.room, code: ROOM_CODE[cell.room] ?? '??', state: cell.state });
            x = cell.x + CELL;
        }
        segs.push({ text: grid[r].slice(x).join('').trimEnd() });
        if (segs.some((s) => 'room' in s || s.text.trim())) lines.push(segs);
    }
    return { lines, legend: [...visited].sort((a, b) => a - b).map((id) => ({ code: ROOM_CODE[id], title: roomTitle(id) })), stairs: !!stairs };
}
