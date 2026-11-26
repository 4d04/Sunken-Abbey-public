/*
 * Roll verification (SPEC §7.3, "Verifiability"): recompute a resolved roll from what the chain published.
 *   1. the revealed secret matches the commitment sealed before the beacon existed: commit = sha256(secret ‖ rollId)
 *   2. the beacon used is the one the chain recorded for the commit block
 *   3. every die follows from seed = sha256("abbey.roll.v1" ‖ secret ‖ beacon ‖ rollId), drawn in order
 * A forfeited roll is checked against the forfeit rule instead: player dice at their minimum, monster dice at their max.
 * Not checked here: the beacon chain itself (each beacon folds in that block's tx hashes, which the plugin doesn't keep).
 */

import { SeededDice, commitment, rollSeed } from '@abbey/rules';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { RollRecord } from './session.ts';

export interface Check {
    name: string;
    ok: boolean;
    detail: string;
}

export interface Verification {
    ok: boolean;
    checks: Check[];
}

/** Verify a resolved roll against the beacon value the chain reports for its commit block (null if no longer kept). */
export function verifyRoll(roll: RollRecord, chainBeacon: { height: number; value: string } | null): Verification {
    const r = roll.resolved;
    if (!r) return { ok: false, checks: [{ name: 'resolved', ok: false, detail: 'the roll has not resolved yet' }] };
    const checks: Check[] = [];
    const id = hexToBytes(roll.id);

    if (r.outcome === 'forfeited') {
        const bad = r.dice.filter((d) => d.value !== (d.owner === 'pc' ? 1 : d.sides));
        checks.push({
            name: 'forfeit dice',
            ok: bad.length === 0,
            detail: bad.length ? `${bad.length} dice break the forfeit rule` : `${r.dice.length} dice: player dice at 1, monster dice at their maximum`
        });
        return { ok: checks.every((c) => c.ok), checks };
    }

    const secret = r.secret ? hexToBytes(r.secret) : null;
    const commitOk = !!secret && bytesToHex(commitment(secret, id)) === roll.commit;
    checks.push({ name: 'commitment', ok: commitOk, detail: commitOk ? `sha256(secret ‖ rollId) = ${roll.commit.slice(0, 16)}…, sealed at block ${roll.committedAt}` : 'the revealed secret does not match the sealed commitment' });

    if (!chainBeacon) {
        checks.push({ name: 'beacon', ok: false, detail: `the chain no longer keeps the beacon for block ${roll.committedAt}` });
    } else {
        const ok = chainBeacon.height === roll.committedAt && chainBeacon.value === r.beacon;
        checks.push({ name: 'beacon', ok, detail: ok ? `beacon of block ${roll.committedAt} = ${chainBeacon.value.slice(0, 16)}…` : `the roll used ${r.beacon?.slice(0, 16)}…, but block ${roll.committedAt}'s beacon is ${chainBeacon.value.slice(0, 16)}…` });
    }

    if (r.outcome === 'fizzled') {
        checks.push({ name: 'dice', ok: r.dice.length === 0, detail: 'the action fizzled: no dice were rolled' });
    } else if (secret && r.beacon) {
        const dice = new SeededDice(rollSeed(secret, hexToBytes(r.beacon), id));
        const mismatch = r.dice.findIndex((d) => dice.roll(d.sides, d.owner) !== d.value);
        checks.push({
            name: 'dice',
            ok: mismatch < 0,
            detail: mismatch < 0 ? `all ${r.dice.length} dice follow from the seed: ${r.dice.map((d) => `d${d.sides}=${d.value}`).join(' ')}` : `die #${mismatch + 1} (d${r.dice[mismatch].sides}) does not follow from the seed`
        });
    }
    return { ok: checks.every((c) => c.ok), checks };
}
