/* The map, drawn for the terminal from the shared model (lib/map.ts). */

import type { LevelDef } from '@abbey/rules';
import { mapModel } from '../lib/map.ts';
import { c } from './ui.ts';

export function drawMap(level: LevelDef, visited: Set<number>, here: number): string[] {
    const m = mapModel(level, visited, here);
    const out = m.lines.map((segs) => `  ${segs.map((s) => ('text' in s ? s.text : s.state === 'here' ? c.yellow(`[@${s.code[0]}]`) : s.state === 'visited' ? `[${s.code}]` : c.dim('[??]'))).join('').trimEnd()}`);
    const legend = m.legend.map((l) => `${l.code} ${l.title}`);
    out.push('');
    for (let i = 0; i < legend.length; i += 3) out.push(c.dim(`  ${legend.slice(i, i + 3).join('   ')}`));
    if (m.stairs) out.push(c.dim('  ▼ stairs down (sealed until level 2 opens)'));
    return out;
}
