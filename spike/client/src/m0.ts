/* M0 functional checks against a running localnet with the abbey spike plugin */

import { randomBytes } from 'crypto';
import {
    Key, newKey, submit, waitTx, balance, feePool, height, get, sleep,
    sha256, u64be, rollDie, PLUGIN_RPC, TREASURY, FAUCET
} from './chain.js';

const GOLD = 1_000_000n;
const FEE = 10_000n; // genesis sendFee
const results: { check: string; ok: boolean; detail: string }[] = [];

function record(check: string, ok: boolean, detail: string): void {
    results.push({ check, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${check} — ${detail}`);
}

async function expectFail(check: string, fn: () => Promise<unknown>): Promise<void> {
    try {
        await fn();
        record(check, false, 'expected rejection but tx committed');
    } catch (e) {
        record(check, true, `rejected: ${String((e as Error).message).slice(0, 140)}`);
    }
}

// commitAndReveal() runs one full roll and returns timings plus the verified d20
async function commitAndReveal(key: Key, nonce: bigint, reveal = true) {
    const secret = randomBytes(32);
    const rollId = sha256(Buffer.from(key.address, 'hex'), u64be(nonce));
    const commit = sha256(secret, rollId);
    const t0 = Date.now();
    const commitHash = await submit(key, 'commit_roll', { address: key.address, nonce: Number(nonce), commit: commit.toString('hex') }, FEE);
    const committed = await waitTx(commitHash, key.address);
    const tCommit = Date.now();
    if (!reveal) {
        return { committedHeight: BigInt(committed.height), t0, tCommit };
    }
    const revealHash = await submit(key, 'reveal_roll', { address: key.address, nonce: Number(nonce), secret: secret.toString('hex') }, FEE);
    const revealed = await waitTx(revealHash, key.address);
    const tReveal = Date.now();
    const roll = (await get(`${PLUGIN_RPC}/abbey/roll?address=${key.address}&nonce=${nonce}`)).body;
    const beacon = (await get(`${PLUGIN_RPC}/abbey/beacon?at=${committed.height}`)).body;
    const seed = sha256(Buffer.from('abbey.roll.v1'), secret, Buffer.from(beacon.value, 'hex'), rollId);
    const expected = rollDie(seed, 0, 20n);
    return {
        committedHeight: BigInt(committed.height),
        revealedHeight: BigInt(revealed.height),
        d20: BigInt(roll.d20),
        expected,
        beaconMatches: roll.beacon === beacon.value,
        latencyMs: tReveal - t0,
        t0, tCommit
    };
}

async function main(): Promise<void> {
    console.log(`start height ${await height()}`);
    const alice = await newKey(`alice-${Date.now()}`);
    const bob = await newKey(`bob-${Date.now()}`);

    // 1. zero-fee faucet claim from an account that has never held gold
    const before = await balance(alice.address);
    const poolBefore = await feePool();
    const faucetBefore = await balance(FAUCET);
    await waitTx(await submit(alice, 'faucet_claim', { address: alice.address }, 0n), alice.address);
    const after = await balance(alice.address);
    record('zero-fee faucet_claim from empty account', before === 0n && after === 100n * GOLD,
        `balance ${before} -> ${after} uGOLD, faucet ${faucetBefore} -> ${await balance(FAUCET)}, fee pool ${poolBefore} -> ${await feePool()}`);
    const rec = (await get(`${PLUGIN_RPC}/abbey/faucet?address=${alice.address}`)).body;
    record('faucet record tracked for future limits', rec.count === '1', JSON.stringify(rec));

    // 2. core send still works because the plugin no longer registers 'send'
    const bobBefore = await balance(bob.address);
    await waitTx(await submit(alice, 'send', { fromAddress: alice.address, toAddress: bob.address, amount: Number(GOLD) }, FEE), alice.address);
    record('core send handled by core (not plugin)', (await balance(bob.address)) - bobBefore === GOLD,
        `bob ${bobBefore} -> ${await balance(bob.address)}`);

    // 3. plugin moves native balance out of the keyless treasury and collects its own fee
    const tBefore = await balance(TREASURY);
    const aBefore = await balance(alice.address);
    const pBefore = await feePool();
    await waitTx(await submit(alice, 'spike_payout', { address: alice.address, amount: Number(5n * GOLD) }, FEE), alice.address);
    const tAfter = await balance(TREASURY);
    const aAfter = await balance(alice.address);
    const pAfter = await feePool();
    record('treasury -> player transfer by plugin', tBefore - tAfter === 5n * GOLD && aAfter - aBefore === 5n * GOLD - FEE,
        `treasury -${tBefore - tAfter}, alice +${aAfter - aBefore}`);
    // pools[chainId] is the committee reward pool: core drains it in every EndBlock, so it reads 0 again
    record('plugin charges exactly the tx fee', aAfter - aBefore === 5n * GOLD - FEE,
        `alice paid ${5n * GOLD - (aAfter - aBefore)} uGOLD fee; reward pool ${pBefore} -> ${pAfter} (distributed each block)`);

    // 4. paid messages below the fee floor are rejected in CheckTx
    await expectFail('commit below fee floor rejected', async () =>
        waitTx(await submit(alice, 'commit_roll', { address: alice.address, nonce: 0, commit: randomBytes(32).toString('hex') }, 0n), alice.address, 20_000));

    // 5. commit -> reveal resolves a d20 the client can reproduce
    const roll = await commitAndReveal(alice, 0n);
    record('commit-reveal d20 matches client recomputation', roll.d20 === roll.expected && roll.beaconMatches,
        `d20=${roll.d20} expected=${roll.expected} commit@${roll.committedHeight} reveal@${roll.revealedHeight} (${roll.latencyMs}ms click->result)`);
    record('reveal lands in a later block than commit', (roll.revealedHeight ?? 0n) > roll.committedHeight,
        `+${(roll.revealedHeight ?? 0n) - roll.committedHeight} blocks`);

    // 6. a wrong secret is rejected
    const nonce1 = 1n;
    const rollId1 = sha256(Buffer.from(bob.address, 'hex'), u64be(nonce1));
    await waitTx(await submit(bob, 'faucet_claim', { address: bob.address }, 0n), bob.address);
    await waitTx(await submit(bob, 'commit_roll', { address: bob.address, nonce: 0, commit: sha256(randomBytes(32), sha256(Buffer.from(bob.address, 'hex'), u64be(0n))).toString('hex') }, FEE), bob.address);
    await expectFail('reveal with wrong secret rejected', async () =>
        waitTx(await submit(bob, 'reveal_roll', { address: bob.address, nonce: 0, secret: randomBytes(32).toString('hex') }, FEE), bob.address, 20_000));
    await expectFail('second commit while a roll is pending rejected', async () =>
        waitTx(await submit(bob, 'commit_roll', { address: bob.address, nonce: Number(nonce1), commit: sha256(randomBytes(32), rollId1).toString('hex') }, FEE), bob.address, 20_000));

    // 7. an unrevealed roll is forfeited by EndBlock after the reveal window
    const pending = (await get(`${PLUGIN_RPC}/abbey/roll?address=${bob.address}&nonce=0`)).body;
    const expires = BigInt(pending.expiresHeight);
    while ((await height()) <= expires + 1n) {
        await sleep(2000);
    }
    const swept = (await get(`${PLUGIN_RPC}/abbey/roll?address=${bob.address}&nonce=0`)).body;
    record('EndBlock forfeits unrevealed roll at expiry', swept.forfeited === true && swept.d20 === '1' && swept.resolvedHeight === String(expires),
        `forfeited=${swept.forfeited} d20=${swept.d20} resolved@${swept.resolvedHeight} expires@${expires}`);

    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    console.log(JSON.stringify(results, null, 2));
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
