/* Chain access: the core RPC (txs, blocks, events), the plugin RPC (game state), and signing (SPEC §7.1, §8). */

import { bls12_381 } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
// generated from the plugin's .proto files (npm run build:proto): client and plugin encode messages identically
import { google, types } from './proto.js';

export interface Endpoints {
    rpc: string; // core RPC, e.g. http://127.0.0.1:30002
    plugin: string; // plugin RPC, e.g. http://127.0.0.1:50010
    chainId: number;
    networkId: number;
}

/** The nested localnet from spike/localnet.sh; override with ABBEY_RPC, ABBEY_PLUGIN_RPC, ABBEY_CHAIN_ID, ABBEY_NETWORK_ID. */
export function endpointsFromEnv(env: Record<string, string | undefined> = globalThis.process?.env ?? {}): Endpoints {
    return {
        rpc: env.ABBEY_RPC || 'http://127.0.0.1:30002',
        plugin: env.ABBEY_PLUGIN_RPC || 'http://127.0.0.1:50010',
        chainId: Number(env.ABBEY_CHAIN_ID || 2),
        networkId: Number(env.ABBEY_NETWORK_ID || 1)
    };
}

export interface Key {
    address: string; // 20 bytes hex
    publicKey: string; // BLS12-381 G1 compressed, hex
    privateKey: string; // hex; only ever held in memory
}

/** A fresh BLS key; address = sha256(pubkey)[:20] (core lib/crypto/bls.go). */
export function newKey(): Key {
    const priv = bls12_381.utils.randomSecretKey();
    return keyFromPrivate(bytesToHex(priv));
}

export function keyFromPrivate(privateKey: string): Key {
    const pub = bls12_381.longSignatures.getPublicKey(hexToBytes(privateKey)).toBytes(true);
    return { address: bytesToHex(sha256(pub).subarray(0, 20)), publicKey: bytesToHex(pub), privateKey };
}

/** A message field: bytes as Uint8Array (signed raw, sent as hex), everything else as-is. */
export type MsgFields = Record<string, Uint8Array | string | number | boolean | number[] | undefined>;

const MESSAGES: Record<string, string> = {
    faucet_claim: 'MessageFaucetClaim',
    create_character: 'MessageCreateCharacter',
    assign_stats: 'MessageAssignStats',
    enter_dungeon: 'MessageEnterDungeon',
    act: 'MessageAct',
    reveal: 'MessageReveal',
    give: 'MessageGive',
    extract: 'MessageExtract',
    shop_buy: 'MessageShopBuy',
    shop_sell: 'MessageShopSell',
    stash_move: 'MessageStashMove',
    party_set: 'MessagePartySet',
    set_params: 'MessageSetParams'
};

export class HttpError extends Error {
    readonly status: number;
    readonly body: string;
    constructor(url: string, status: number, body: string) {
        super(`${url} ${status}: ${body.slice(0, 300)}`);
        this.status = status;
        this.body = body;
    }
}

/** A core event: plugin events carry eventType "abbey.<Kind>" and an AbbeyEvent{kind, data} payload. */
export interface ChainEvent {
    kind: string;
    height: number;
    address: string;
    txHash: string; // the tx that emitted it ('' for EndBlock events)
    data: Record<string, unknown>;
}

export class Net {
    readonly ep: Endpoints;
    constructor(ep: Endpoints) {
        this.ep = ep;
    }

    async post<T = any>(path: string, body: unknown): Promise<T> {
        const url = `${this.ep.rpc}${path}`;
        for (let attempt = 1; ; attempt++) {
            try {
                const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                const text = await res.text();
                if (!res.ok) throw new HttpError(url, res.status, text);
                return (text ? JSON.parse(text) : null) as T;
            } catch (e) {
                // a 4xx is an answer; transport errors (a node restarting, a reset connection) are retried
                if ((e instanceof HttpError && e.status < 500) || attempt >= 4) throw e;
                await sleep(400 * attempt);
            }
        }
    }

    /** Plugin RPC: game state at the latest committed height (or ?height=). 404 is a normal "not there yet". */
    async abbey<T = any>(path: string): Promise<T | null> {
        const res = await fetch(`${this.ep.plugin}${path}`);
        if (res.status === 404) return null;
        const text = await res.text();
        if (!res.ok) throw new HttpError(path, res.status, text);
        return JSON.parse(text) as T;
    }

    /** The next height the chain will build: a tx in block h is committed once height() > h. */
    async height(): Promise<number> {
        const h = Number((await this.post<{ height: number }>('/v1/query/height', {})).height);
        if (h > this.tip.h) this.tip = { h, at: Date.now() };
        return h;
    }

    /** The last height seen, if seen lately: good enough for a tx's created height (the core accepts ±4320 blocks). */
    private tip = { h: 0, at: 0 };
    async recentHeight(maxAgeMs = 10_000): Promise<number> {
        return this.tip.h && Date.now() - this.tip.at < maxAgeMs ? this.tip.h : this.height();
    }

    async balance(address: string): Promise<bigint> {
        const acc = await this.post<{ amount?: number | string }>('/v1/query/account', { address });
        return BigInt(acc?.amount ?? 0);
    }

    async sendFee(): Promise<bigint> {
        const p = await this.post<{ sendFee?: number | string }>('/v1/query/fee-params', {});
        return BigInt(p?.sendFee ?? 10_000);
    }

    /** A failed tx's error, if the node recorded one for this sender (failed txs are dropped from the mempool). */
    async failure(address: string, hash: string): Promise<string | null> {
        const page = await this.post<{ results?: any[] }>('/v1/query/failed-txs', { address, perPage: 50 });
        const hit = (page?.results || []).find((f) => f.txHash === hash || f.transaction?.txHash === hash);
        return hit ? String(hit.error?.msg ?? JSON.stringify(hit.error)) : null;
    }

    /** Game events in one block. */
    async events(height: number): Promise<ChainEvent[]> {
        const page = await this.post<{ results?: any[] }>('/v1/query/events-by-height', { height, perPage: 1000 });
        return (page?.results || []).flatMap((e) => decodeEvent(e) ?? []);
    }

    /** Sign and broadcast; returns the tx hash. Submission is not confirmation (SPEC §8): callers confirm from state. */
    /** `created` is the tx's created height; by default the last height seen (no round trip if it's recent). */
    async submit(key: Key, msgType: string, fields: MsgFields, fee: bigint, created?: number): Promise<string> {
        const name = MESSAGES[msgType] ?? fail(`unknown message ${msgType}`);
        const clean = omitDefaults(fields);
        const protoFields: Record<string, unknown> = {};
        const msgJSON: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(clean)) {
            protoFields[k] = v;
            msgJSON[k] = v instanceof Uint8Array ? bytesToHex(v) : v;
        }
        const msgBytes = types[name].encode(types[name].create(protoFields)).finish();
        created ??= await this.recentHeight();
        const time = Date.now() * 1000; // µs
        const unsigned = types.Transaction.create(omitDefaults({
            messageType: msgType,
            msg: google.protobuf.Any.create({ type_url: `type.googleapis.com/types.${name}`, value: msgBytes }),
            createdHeight: created,
            time,
            fee: Number(fee),
            networkId: this.ep.networkId,
            chainId: this.ep.chainId
        }));
        const signBytes = types.Transaction.encode(unsigned).finish();
        const sig = bls12_381.longSignatures.sign(bls12_381.longSignatures.hash(signBytes), hexToBytes(key.privateKey));
        return this.post<string>('/v1/tx', {
            type: msgType,
            msg: msgJSON,
            signature: { publicKey: key.publicKey, signature: bytesToHex(bls12_381.longSignatures.Signature.toBytes(sig)) },
            time,
            createdHeight: created,
            fee: Number(fee),
            memo: '',
            networkID: this.ep.networkId,
            chainID: this.ep.chainId
        });
    }
}

/**
 * protobufjs encodes explicitly set proto3 defaults (0, "", false, empty) but Go omits them, so one extra field makes
 * the signed bytes differ from what the core verifies (found in M0). Drop them before encoding.
 */
export function omitDefaults(fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
        if (v === 0 || v === 0n || v === '' || v === false || v === null || v === undefined) continue;
        if ((v instanceof Uint8Array || Array.isArray(v)) && v.length === 0) continue;
        out[k] = v;
    }
    return out;
}

/**
 * Decode a core event. At canopy 83af2a0 the JSON routes put a plugin event's whole custom Any, protobuf-encoded and
 * hex, under msg.orderId (the field the core's event message reuses); the Any wraps AbbeyEvent{kind, data}.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodeEvent(e: any): ChainEvent | null {
    const type = String(e.eventType ?? '');
    if (!type.startsWith('abbey.')) return null;
    let data: Record<string, unknown> = {};
    const hex = e.msg?.orderId;
    if (typeof hex === 'string' && hex.length) {
        try {
            const any = google.protobuf.Any.decode(hexToBytes(hex));
            data = JSON.parse(types.AbbeyEvent.decode(any.value).data);
        } catch {
            data = {};
        }
    }
    const ref = String(e.reference ?? '');
    return { kind: type.slice('abbey.'.length), height: Number(e.height ?? 0), address: String(e.address ?? ''), txHash: /^[0-9a-f]{64}$/.test(ref) ? ref : '', data };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function fail(msg: string): never {
    throw new Error(msg);
}
