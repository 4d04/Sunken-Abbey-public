/* M0 load test: concurrent players doing back-to-back commit-reveal rolls; measures block time and latency */

import { randomBytes } from 'crypto';
import { Key, localKey, submit, waitTx, height, block, sha256, u64be } from './chain.js';

const PLAYERS = Number(process.env.PLAYERS || 50);
const DURATION_MS = Number(process.env.DURATION_S || 300) * 1000;
const FEE = 10_000n;

interface RollStat {
    latencyMs: number;
    blocks: number;
}

const stats: RollStat[] = [];
let failures = 0;
const failureSamples: string[] = [];

async function player(key: Key, stopAt: number): Promise<void> {
    let nonce = 0n;
    while (Date.now() < stopAt) {
        const secret = randomBytes(32);
        const rollId = sha256(Buffer.from(key.address, 'hex'), u64be(nonce));
        const t0 = Date.now();
        try {
            const c = await waitTx(await submit(key, 'commit_roll', { address: key.address, nonce: Number(nonce), commit: sha256(secret, rollId).toString('hex') }, FEE), key.address, 90_000);
            const r = await waitTx(await submit(key, 'reveal_roll', { address: key.address, nonce: Number(nonce), secret: secret.toString('hex') }, FEE), key.address, 90_000);
            stats.push({ latencyMs: Date.now() - t0, blocks: Number(BigInt(r.height) - BigInt(c.height)) });
            nonce++;
        } catch (e) {
            failures++;
            if (failureSamples.length < 5) failureSamples.push(String((e as Error).message).slice(0, 200));
            // resync: a failed reveal leaves the roll pending until it is forfeited, then the next nonce is free
            nonce++;
            await new Promise((r) => setTimeout(r, 65_000));
        }
    }
}

function pct(sorted: number[], p: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main(): Promise<void> {
    console.log(`creating ${PLAYERS} players...`);
    const keys: Key[] = [];
    for (let i = 0; i < PLAYERS; i++) keys.push(localKey());
    // fund everyone through the zero-fee faucet in one burst
    await Promise.all(keys.map(async (k) => waitTx(await submit(k, 'faucet_claim', { address: k.address }, 0n), k.address, 120_000)));
    console.log('funded; starting load');

    const startHeight = await height();
    const stopAt = Date.now() + DURATION_MS;
    await Promise.all(keys.map((k) => player(k, stopAt)));
    const endHeight = (await height()) - 1n;

    // block intervals from committed headers (time is in microseconds)
    const intervals: number[] = [];
    let txs = 0;
    let maxTxs = 0;
    let prevTime: bigint | null = null;
    for (let h = startHeight; h <= endHeight; h++) {
        const b = await block(h);
        const header = b.blockHeader || b.block_header || b.header;
        const t = BigInt(header.time);
        const n = Number(header.numTxs || 0);
        txs += n;
        maxTxs = Math.max(maxTxs, n);
        if (prevTime !== null) intervals.push(Number(t - prevTime) / 1000);
        prevTime = t;
    }
    intervals.sort((a, b) => a - b);
    const lat = stats.map((s) => s.latencyMs).sort((a, b) => a - b);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const summary = {
        players: PLAYERS,
        durationS: DURATION_MS / 1000,
        blocks: Number(endHeight - startHeight + 1n),
        txsCommitted: txs,
        maxTxsPerBlock: maxTxs,
        blockIntervalMs: { mean: Math.round(mean(intervals)), p50: pct(intervals, 50), p95: pct(intervals, 95), max: intervals[intervals.length - 1] },
        rollsCompleted: stats.length,
        rollFailures: failures,
        failureSamples,
        clickToResultMs: { mean: Math.round(mean(lat)), p50: pct(lat, 50), p95: pct(lat, 95), max: lat[lat.length - 1] },
        revealBlocksAfterCommit: { mean: mean(stats.map((s) => s.blocks)).toFixed(2), max: Math.max(...stats.map((s) => s.blocks)) }
    };
    console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
