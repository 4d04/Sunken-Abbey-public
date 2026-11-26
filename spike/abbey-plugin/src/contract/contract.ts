/* Abbey M0 spike contract: beacon in EndBlock, commit-reveal d20, zero-fee faucet, treasury payout */

import { createHash } from 'crypto';
import Long from 'long';
import protobuf from 'protobufjs/minimal.js';

import { types } from '../proto/types.js';

import {
    IPluginError,
    ErrInsufficientFunds,
    ErrInvalidAddress,
    ErrInvalidAmount,
    ErrInvalidMessageCast,
    ErrTxFeeBelowStateLimit,
    ErrAbbey
} from './error.js';

import type { Plugin, Config } from './plugin.js';
import { JoinLenPrefix, FromAny, Unmarshal } from './plugin.js';
import { fileDescriptorProtos } from '../proto/descriptors.js';

const { Reader } = protobuf;
const accountFields = new Set([1, 2, 7]);
const poolFields = new Set([1, 2]);

// GAME CONSTANTS (spike values; real ones live in GameConfig / Params)

// keyless accounts: sha256(label)[:20], funded in genesis
export const TREASURY_ADDRESS = sha256(Buffer.from('abbey.treasury.v1')).subarray(0, 20);
export const FAUCET_ADDRESS = sha256(Buffer.from('abbey.faucet.v1')).subarray(0, 20);
// 100 GOLD per claim (1 GOLD = 1,000,000 uGOLD)
const FAUCET_AMOUNT = 100_000_000n;
// blocks a player has to reveal before the roll is forfeited
const REVEAL_WINDOW = 10n;
// beacons older than this are pruned
const BEACON_RETENTION = 1000n;

// protobufjs discards unknown fields, so retain fields outside each local schema verbatim.
function encodePreservingUnknownFields(
    MessageType: any,
    message: any,
    original: Uint8Array | null,
    knownFields: Set<number>
): Uint8Array {
    const fields: Uint8Array[] = [MessageType.encode(message).finish()];
    const reader = Reader.create(original || new Uint8Array());
    while (reader.pos < reader.len) {
        const start = reader.pos;
        const tag = reader.uint32();
        reader.skipType(tag & 7);
        if (!knownFields.has(tag >>> 3)) {
            fields.push(reader.buf.subarray(start, reader.pos));
        }
    }
    return Buffer.concat(fields);
}

// ContractConfig: the configuration of the contract
// NOTE: 'send' is intentionally NOT registered so the core handles native transfers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ContractConfig: any = {
    name: 'abbey_spike',
    id: 1,
    version: 1,
    supportedTransactions: ['faucet_claim', 'spike_payout', 'commit_roll', 'reveal_roll'],
    transactionTypeUrls: [
        'type.googleapis.com/types.MessageFaucetClaim',
        'type.googleapis.com/types.MessageSpikePayout',
        'type.googleapis.com/types.MessageCommitRoll',
        'type.googleapis.com/types.MessageRevealRoll'
    ],
    eventTypeUrls: [],
    customStatePrefixes: [Buffer.from('abbey')],
    fileDescriptorProtos
};

// Contract() defines the smart contract that implements the extended logic of the nested chain
export class Contract {
    Config: Config;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FSMConfig: any;
    plugin: Plugin;
    fsmId: Long;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(config: Config, fsmConfig: any, plugin: Plugin, fsmId: Long) {
        this.Config = config;
        this.FSMConfig = fsmConfig;
        this.plugin = plugin;
        this.fsmId = fsmId;
    }

    // Genesis() implements logic to import a json file to create the state at height 0 and export the state at any height
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    Genesis(_request: any): any {
        return {};
    }

    // BeginBlock() is code that is executed at the start of `applying` the block
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    BeginBlock(_request: any): any {
        return {};
    }

    // CheckMessage() statelessly validates any abbey message: every message is signed by msg.address
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    CheckMessage(msgType: string, msg: any): any {
        if (!msg.address || msg.address.length !== 20) {
            return { error: ErrInvalidAddress() };
        }
        switch (msgType) {
            case 'MessageSpikePayout':
                if (toBig(msg.amount) === 0n) {
                    return { error: ErrInvalidAmount() };
                }
                break;
            case 'MessageCommitRoll':
                if (!msg.commit || msg.commit.length !== 32) {
                    return { error: ErrAbbey('commit must be 32 bytes') };
                }
                break;
            case 'MessageRevealRoll':
                if (!msg.secret || msg.secret.length !== 32) {
                    return { error: ErrAbbey('secret must be 32 bytes') };
                }
                break;
        }
        return { authorizedSigners: [msg.address] };
    }
}

// Async versions of contract methods for proper state handling
export class ContractAsync {
    // CheckTx() is code that is executed to statelessly validate a transaction
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async CheckTx(contract: Contract, request: any): Promise<any> {
        const [msg, msgType, msgErr] = FromAny(request.tx?.msg);
        if (msgErr) {
            return { error: msgErr };
        }
        if (!msg || !msgType) {
            return { error: ErrInvalidMessageCast() };
        }
        // faucet_claim is the only zero-fee message; everything else pays at least the core send fee
        if (msgType !== 'MessageFaucetClaim') {
            const [minFee, feeErr] = await readMinFee(contract);
            if (feeErr) {
                return { error: feeErr };
            }
            if (toBig(request.tx?.fee) < minFee) {
                return { error: ErrTxFeeBelowStateLimit() };
            }
        }
        return contract.CheckMessage(msgType, msg);
    }

    // DeliverTx() is code that is executed to apply a transaction
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async DeliverTx(contract: Contract, request: any): Promise<any> {
        const [msg, msgType, err] = FromAny(request.tx?.msg);
        if (err) {
            return { error: err };
        }
        const height = toBig(request.height);
        const fee = toBig(request.tx?.fee);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let result: any;
        switch (msgType) {
            case 'MessageFaucetClaim':
                result = await ContractAsync.DeliverFaucetClaim(contract, msg, height);
                break;
            case 'MessageSpikePayout':
                result = await ContractAsync.DeliverSpikePayout(contract, msg, fee);
                break;
            case 'MessageCommitRoll':
                result = await ContractAsync.DeliverCommitRoll(contract, msg, fee, height);
                break;
            case 'MessageRevealRoll':
                result = await ContractAsync.DeliverRevealRoll(contract, msg, fee, height);
                break;
            default:
                return { error: ErrInvalidMessageCast() };
        }
        if (result?.error) {
            return result;
        }
        // fold the delivered tx into this block's beacon accumulator
        const accErr = await foldTxIntoAccumulator(contract, request.tx);
        if (accErr) {
            return { error: accErr };
        }
        return result;
    }

    // EndBlock() advances the beacon, sweeps expired rolls and prunes old beacons
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async EndBlock(contract: Contract, request: any): Promise<any> {
        const height = toBig(request.height);
        const proposer: Uint8Array = request.proposerAddress || new Uint8Array();
        const [state, readErr] = await readKeys(contract, [KeyForBeaconLatest(), KeyForTxAccumulator()]);
        if (readErr) {
            return { error: readErr };
        }
        const [latest] = decode(state[0], types.BeaconRecord);
        const [acc] = decode(state[1], types.BeaconRecord);
        const prev: Uint8Array = latest?.value?.length ? latest.value : new Uint8Array(32);
        const accValue: Uint8Array = acc?.value?.length ? acc.value : new Uint8Array();
        const beacon = sha256(Buffer.from('abbey.beacon.v1'), prev, u64be(height), proposer, accValue);
        const record = types.BeaconRecord.encode(
            types.BeaconRecord.create({
                height: toLong(height),
                value: beacon,
                proposer,
                txCount: acc?.txCount || 0
            })
        ).finish();

        // forfeit every roll whose reveal window ends at this height
        const [expired, rangeErr] = await readRange(contract, ExpiryPrefix(height));
        if (rangeErr) {
            return { error: rangeErr };
        }
        const rollKeys = expired.map((e) => e.value as Uint8Array);
        const [rolls, rollErr] = await readKeys(contract, rollKeys);
        if (rollErr) {
            return { error: rollErr };
        }
        const sets = [
            { key: KeyForBeacon(height), value: record },
            { key: KeyForBeaconLatest(), value: record }
        ];
        const deletes = [{ key: KeyForTxAccumulator() }, ...expired.map((e) => ({ key: e.key }))];
        rolls.forEach((bz, i) => {
            const [roll] = decode(bz, types.RollRecord);
            if (roll && toBig(roll.resolvedHeight) === 0n && !roll.forfeited) {
                // forfeit outcome: the player's die counts as its minimum
                roll.forfeited = true;
                roll.d20 = toLong(1n);
                roll.resolvedHeight = toLong(height);
                sets.push({ key: rollKeys[i], value: types.RollRecord.encode(roll).finish() });
            }
        });
        if (height > BEACON_RETENTION) {
            deletes.push({ key: KeyForBeacon(height - BEACON_RETENTION) });
        }
        const writeErr = await writeState(contract, sets, deletes);
        if (writeErr) {
            return { error: writeErr };
        }
        return {};
    }

    // DeliverFaucetClaim() pays FAUCET_AMOUNT from the keyless faucet account to the signer (no fee)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async DeliverFaucetClaim(contract: Contract, msg: any, height: bigint): Promise<any> {
        const [state, readErr] = await readKeys(contract, [
            KeyForAccount(FAUCET_ADDRESS),
            KeyForAccount(msg.address),
            KeyForFaucetRecord(msg.address)
        ]);
        if (readErr) {
            return { error: readErr };
        }
        const faucetBalance = accountAmount(state[0]);
        if (faucetBalance < FAUCET_AMOUNT) {
            return { error: ErrInsufficientFunds() };
        }
        const [record] = decode(state[2], types.FaucetRecord);
        const updatedRecord = types.FaucetRecord.create({
            lastClaimHeight: toLong(height),
            totalClaimed: toLong(toBig(record?.totalClaimed) + FAUCET_AMOUNT),
            count: toLong(toBig(record?.count) + 1n)
        });
        const writeErr = await writeState(contract, [
            accountSet(FAUCET_ADDRESS, state[0], faucetBalance - FAUCET_AMOUNT),
            accountSet(msg.address, state[1], accountAmount(state[1]) + FAUCET_AMOUNT),
            { key: KeyForFaucetRecord(msg.address), value: types.FaucetRecord.encode(updatedRecord).finish() }
        ]);
        return writeErr ? { error: writeErr } : {};
    }

    // DeliverSpikePayout() moves gold from the treasury to the signer (SPIKE ONLY) and charges the fee
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async DeliverSpikePayout(contract: Contract, msg: any, fee: bigint): Promise<any> {
        const amount = toBig(msg.amount);
        const [state, readErr] = await readKeys(contract, [
            KeyForAccount(TREASURY_ADDRESS),
            KeyForAccount(msg.address),
            KeyForFeePool(contract.Config.ChainId)
        ]);
        if (readErr) {
            return { error: readErr };
        }
        const treasury = accountAmount(state[0]);
        const signer = accountAmount(state[1]);
        if (treasury < amount || signer + amount < fee) {
            return { error: ErrInsufficientFunds() };
        }
        const writeErr = await writeState(contract, [
            accountSet(TREASURY_ADDRESS, state[0], treasury - amount),
            accountSet(msg.address, state[1], signer + amount - fee),
            poolSet(contract.Config.ChainId, state[2], poolAmount(state[2]) + fee)
        ]);
        return writeErr ? { error: writeErr } : {};
    }

    // DeliverCommitRoll() stores the commitment and locks the signer until reveal or expiry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async DeliverCommitRoll(contract: Contract, msg: any, fee: bigint, height: bigint): Promise<any> {
        const nonce = toBig(msg.nonce);
        const [state, readErr] = await readKeys(contract, [
            KeyForRoller(msg.address),
            KeyForAccount(msg.address),
            KeyForFeePool(contract.Config.ChainId)
        ]);
        if (readErr) {
            return { error: readErr };
        }
        const [roller] = decode(state[0], types.RollerRecord);
        const nextNonce = toBig(roller?.nextNonce);
        if (nonce !== nextNonce) {
            return { error: ErrAbbey(`wrong nonce: expected ${nextNonce}`) };
        }
        // one pending roll per roller
        if (nextNonce > 0n) {
            const [prevState, prevErr] = await readKeys(contract, [KeyForRoll(msg.address, nextNonce - 1n)]);
            if (prevErr) {
                return { error: prevErr };
            }
            const [prev] = decode(prevState[0], types.RollRecord);
            if (prev && toBig(prev.resolvedHeight) === 0n) {
                return { error: ErrAbbey('previous roll is still pending') };
            }
        }
        const balance = accountAmount(state[1]);
        if (balance < fee) {
            return { error: ErrInsufficientFunds() };
        }
        const expires = height + REVEAL_WINDOW;
        const rollKey = KeyForRoll(msg.address, nonce);
        const roll = types.RollRecord.create({
            address: msg.address,
            nonce: toLong(nonce),
            commit: msg.commit,
            committedHeight: toLong(height),
            expiresHeight: toLong(expires)
        });
        const writeErr = await writeState(contract, [
            { key: rollKey, value: types.RollRecord.encode(roll).finish() },
            { key: KeyForExpiry(expires, msg.address, nonce), value: rollKey },
            {
                key: KeyForRoller(msg.address),
                value: types.RollerRecord.encode(types.RollerRecord.create({ nextNonce: toLong(nonce + 1n) })).finish()
            },
            accountSet(msg.address, state[1], balance - fee),
            poolSet(contract.Config.ChainId, state[2], poolAmount(state[2]) + fee)
        ]);
        return writeErr ? { error: writeErr } : {};
    }

    // DeliverRevealRoll() verifies the commitment and resolves a d20 from secret + beacon of the commit block
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async DeliverRevealRoll(contract: Contract, msg: any, fee: bigint, height: bigint): Promise<any> {
        const nonce = toBig(msg.nonce);
        const rollKey = KeyForRoll(msg.address, nonce);
        const [state, readErr] = await readKeys(contract, [
            rollKey,
            KeyForAccount(msg.address),
            KeyForFeePool(contract.Config.ChainId)
        ]);
        if (readErr) {
            return { error: readErr };
        }
        const [roll] = decode(state[0], types.RollRecord);
        if (!roll || !roll.commit?.length) {
            return { error: ErrAbbey('no such roll') };
        }
        if (toBig(roll.resolvedHeight) !== 0n) {
            return { error: ErrAbbey('roll already resolved') };
        }
        const committedHeight = toBig(roll.committedHeight);
        if (height <= committedHeight) {
            return { error: ErrAbbey('reveal must land after the commit block') };
        }
        const rollId = RollId(msg.address, nonce);
        if (!Buffer.from(sha256(msg.secret, rollId)).equals(Buffer.from(roll.commit))) {
            return { error: ErrAbbey('secret does not match commitment') };
        }
        const [beaconState, beaconErr] = await readKeys(contract, [KeyForBeacon(committedHeight)]);
        if (beaconErr) {
            return { error: beaconErr };
        }
        const [beacon] = decode(beaconState[0], types.BeaconRecord);
        if (!beacon?.value?.length) {
            return { error: ErrAbbey('beacon for commit height not found') };
        }
        const balance = accountAmount(state[1]);
        if (balance < fee) {
            return { error: ErrInsufficientFunds() };
        }
        const seed = sha256(Buffer.from('abbey.roll.v1'), msg.secret, beacon.value, rollId);
        roll.secret = msg.secret;
        roll.beacon = beacon.value;
        roll.d20 = toLong(RollDie(seed, 0, 20n));
        roll.resolvedHeight = toLong(height);
        const writeErr = await writeState(
            contract,
            [
                { key: rollKey, value: types.RollRecord.encode(roll).finish() },
                accountSet(msg.address, state[1], balance - fee),
                poolSet(contract.Config.ChainId, state[2], poolAmount(state[2]) + fee)
            ],
            [{ key: KeyForExpiry(toBig(roll.expiresHeight), msg.address, nonce) }]
        );
        return writeErr ? { error: writeErr } : {};
    }
}

// DICE

// RollId() is the deterministic roll identifier the client can compute before signing
export function RollId(address: Uint8Array, nonce: bigint): Uint8Array {
    return sha256(address, u64be(nonce));
}

// RollDie() draws a uniform value in [1, sides] from the seed using rejection sampling (no modulo bias)
export function RollDie(seed: Uint8Array, counter: number, sides: bigint): bigint {
    const limit = (2n ** 32n / sides) * sides;
    for (let i = counter; ; i++) {
        const ctr = Buffer.alloc(4);
        ctr.writeUInt32BE(i >>> 0);
        const x = BigInt(Buffer.from(sha256(seed, ctr)).readUInt32BE(0));
        if (x < limit) {
            return (x % sides) + 1n;
        }
    }
}

// STATE HELPERS

// foldTxIntoAccumulator() mixes the delivered tx into this block's beacon accumulator
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function foldTxIntoAccumulator(contract: Contract, tx: any): Promise<IPluginError | null> {
    const [state, readErr] = await readKeys(contract, [KeyForTxAccumulator()]);
    if (readErr) {
        return readErr;
    }
    const [acc] = decode(state[0], types.BeaconRecord);
    const txHash = sha256(types.Transaction.encode(tx).finish());
    const prev: Uint8Array = acc?.value?.length ? acc.value : new Uint8Array();
    const updated = types.BeaconRecord.create({
        value: sha256(prev, txHash),
        txCount: toLong(toBig(acc?.txCount) + 1n)
    });
    return writeState(contract, [{ key: KeyForTxAccumulator(), value: types.BeaconRecord.encode(updated).finish() }]);
}

// readMinFee() returns the governance 'send' fee, used as the minimum for every paid abbey message
async function readMinFee(contract: Contract): Promise<[bigint, IPluginError | null]> {
    const [state, err] = await readKeys(contract, [KeyForFeeParams()]);
    if (err) {
        return [0n, err];
    }
    const [params] = decode(state[0], types.FeeParams);
    return [toBig(params?.sendFee), null];
}

// readKeys() reads several keys in one round trip and returns values in request order (null if absent)
async function readKeys(contract: Contract, keys: Uint8Array[]): Promise<[(Uint8Array | null)[], IPluginError | null]> {
    if (keys.length === 0) {
        return [[], null];
    }
    const ids = keys.map((_, i) => Long.fromNumber(i + 1));
    const [resp, err] = await contract.plugin.StateRead(contract, {
        keys: keys.map((key, i) => ({ queryId: ids[i], key }))
    });
    if (err) {
        return [[], err];
    }
    if (resp?.error) {
        return [[], resp.error];
    }
    const out: (Uint8Array | null)[] = keys.map(() => null);
    for (const r of resp?.results || []) {
        const idx = Long.fromValue(r.queryId).toNumber() - 1;
        const value = r.entries?.[0]?.value;
        out[idx] = value && value.length ? value : null;
    }
    return [out, null];
}

// readRange() returns every entry under a prefix
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readRange(contract: Contract, prefix: Uint8Array): Promise<[any[], IPluginError | null]> {
    const [resp, err] = await contract.plugin.StateRead(contract, {
        ranges: [{ queryId: Long.fromNumber(1), prefix }]
    });
    if (err) {
        return [[], err];
    }
    if (resp?.error) {
        return [[], resp.error];
    }
    return [resp?.results?.[0]?.entries || [], null];
}

async function writeState(
    contract: Contract,
    sets: { key: Uint8Array; value: Uint8Array }[],
    deletes: { key: Uint8Array }[] = []
): Promise<IPluginError | null> {
    const [resp, err] = await contract.plugin.StateWrite(contract, { sets, deletes });
    if (err) {
        return err;
    }
    return resp?.error || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decode(bz: Uint8Array | null, MessageType: any): [any | null, IPluginError | null] {
    if (!bz) {
        return [null, null];
    }
    return Unmarshal(bz, MessageType);
}

function accountAmount(bz: Uint8Array | null): bigint {
    const [acc] = decode(bz, types.Account);
    return toBig(acc?.amount);
}

function poolAmount(bz: Uint8Array | null): bigint {
    const [pool] = decode(bz, types.Pool);
    return toBig(pool?.amount);
}

function accountSet(address: Uint8Array, original: Uint8Array | null, amount: bigint) {
    const [acc] = decode(original, types.Account);
    const updated = types.Account.create({ address, amount: toLong(amount), nonce: acc?.nonce });
    return {
        key: KeyForAccount(address),
        value: encodePreservingUnknownFields(types.Account, updated, original, accountFields)
    };
}

function poolSet(chainId: number, original: Uint8Array | null, amount: bigint) {
    const updated = types.Pool.create({ id: toLong(BigInt(chainId)), amount: toLong(amount) });
    return {
        key: KeyForFeePool(chainId),
        value: encodePreservingUnknownFields(types.Pool, updated, original, poolFields)
    };
}

// NUMBERS AND HASHING

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toBig(v: any): bigint {
    if (v === undefined || v === null) {
        return 0n;
    }
    if (Long.isLong(v)) {
        return BigInt(v.toUnsigned().toString());
    }
    return BigInt(v);
}

function toLong(v: bigint): Long {
    if (v < 0n || v > 2n ** 64n - 1n) {
        throw new Error(`uint64 overflow: ${v}`);
    }
    return Long.fromString(v.toString(), true);
}

function sha256(...parts: Uint8Array[]): Uint8Array {
    const h = createHash('sha256');
    for (const p of parts) {
        h.update(p);
    }
    return h.digest();
}

function u64be(v: bigint): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(v);
    return b;
}

// KEYS

const accountPrefix = Buffer.from([1]); // store key prefix for accounts
const poolPrefix = Buffer.from([2]); // store key prefix for pools
const paramsPrefix = Buffer.from([7]); // store key prefix for governance parameters
const abbeyPrefix = Buffer.from('abbey'); // plugin-owned records (multi-byte, cannot collide with core 1-15)

// KeyForAccount() returns the state database key for an account
export function KeyForAccount(addr: Uint8Array): Uint8Array {
    return JoinLenPrefix(accountPrefix, Buffer.from(addr));
}

// KeyForFeeParams() returns the state database key for governance controlled 'fee parameters'
export function KeyForFeeParams(): Uint8Array {
    return JoinLenPrefix(paramsPrefix, Buffer.from('/f/'));
}

// KeyForFeePool() returns the state database key for the chain's fee pool
export function KeyForFeePool(chainId: number): Uint8Array {
    return JoinLenPrefix(poolPrefix, u64be(BigInt(chainId)));
}

export function KeyForBeacon(height: bigint): Uint8Array {
    return JoinLenPrefix(abbeyPrefix, Buffer.from('beacon'), u64be(height));
}

export function KeyForBeaconLatest(): Uint8Array {
    return JoinLenPrefix(abbeyPrefix, Buffer.from('beacon-latest'));
}

export function KeyForTxAccumulator(): Uint8Array {
    return JoinLenPrefix(abbeyPrefix, Buffer.from('txacc'));
}

export function KeyForRoller(addr: Uint8Array): Uint8Array {
    return JoinLenPrefix(abbeyPrefix, Buffer.from('roller'), Buffer.from(addr));
}

export function KeyForRoll(addr: Uint8Array, nonce: bigint): Uint8Array {
    return JoinLenPrefix(abbeyPrefix, Buffer.from('roll'), Buffer.from(addr), u64be(nonce));
}

export function ExpiryPrefix(height: bigint): Uint8Array {
    return JoinLenPrefix(abbeyPrefix, Buffer.from('expiry'), u64be(height));
}

export function KeyForExpiry(height: bigint, addr: Uint8Array, nonce: bigint): Uint8Array {
    return JoinLenPrefix(abbeyPrefix, Buffer.from('expiry'), u64be(height), Buffer.from(addr), u64be(nonce));
}

export function KeyForFaucetRecord(addr: Uint8Array): Uint8Array {
    return JoinLenPrefix(abbeyPrefix, Buffer.from('faucet'), Buffer.from(addr));
}
