/*
 * What this browser keeps (the web counterpart of vault.ts): the signed-in account, so a returning player isn't asked
 * again, and the per-roll secrets, so a reload can still reveal. Both are encrypted in IndexedDB with an AES-GCM key
 * that WebCrypto marks non-extractable: page scripts can use it, nothing can read it out.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { type Key, keyFromPrivate } from '../lib/net.ts';
import type { Signer } from '../lib/session.ts';

export type Method = 'passkey' | 'device';

interface Sealed {
    iv: Uint8Array;
    ct: ArrayBuffer;
}

const DB = 'drowned-abbey';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

const get = <T>(k: string) => tx<T | undefined>('readonly', (s) => s.get(k) as IDBRequest<T | undefined>);
const put = (k: string, v: unknown) => tx('readwrite', (s) => s.put(v, k));
const del = (k: string) => tx('readwrite', (s) => s.delete(k));
const keys = () => tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys());

async function deviceKey(): Promise<CryptoKey> {
    const have = await get<CryptoKey>('device-key');
    if (have) return have;
    const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await put('device-key', k);
    return k;
}

async function seal(data: Uint8Array): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return { iv, ct: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deviceKey(), new Uint8Array(data)) };
}

async function unseal(s: Sealed): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(s.iv) }, await deviceKey(), s.ct));
}

// ---- the account remembered on this device

export async function rememberAccount(key: Key, method: Method): Promise<void> {
    await put('account', { method, address: key.address, sealed: await seal(hexToBytes(key.privateKey)) });
}

export async function rememberedAccount(): Promise<{ key: Key; method: Method } | null> {
    const a = await get<{ method: Method; address: string; sealed: Sealed }>('account');
    if (!a) return null;
    try {
        const key = keyFromPrivate(bytesToHex(await unseal(a.sealed)));
        return key.address === a.address ? { key, method: a.method } : null;
    } catch {
        return null; // the device key was cleared (site data reset): sign in again
    }
}

/** Sign out: forget the account here. A passkey account comes back with the passkey; a device account only from its export. */
export async function forgetAccount(): Promise<void> {
    await del('account');
}

// ---- roll secrets

export class DeviceSigner implements Signer {
    readonly key: Key;
    constructor(key: Key) {
        this.key = key;
    }
    async saveSecret(rollId: string, charId: string, secret: Uint8Array): Promise<void> {
        await put(`secret:${rollId}`, { charId, sealedAt: Date.now(), owner: this.key.address, sealed: await seal(secret) });
    }
    async secret(rollId: string): Promise<Uint8Array | null> {
        const s = await get<{ sealed: Sealed }>(`secret:${rollId}`);
        return s ? unseal(s.sealed) : null;
    }
    async dropSecret(rollId: string): Promise<void> {
        await del(`secret:${rollId}`);
    }
    async pending(): Promise<{ rollId: string; charId: string; sealedAt: number; secret: Uint8Array }[]> {
        const out = [];
        for (const k of await keys()) {
            const id = String(k);
            if (!id.startsWith('secret:')) continue;
            const s = await get<{ charId: string; sealedAt: number; owner: string; sealed: Sealed }>(id);
            if (s && s.owner === this.key.address) out.push({ rollId: id.slice(7), charId: s.charId, sealedAt: s.sealedAt, secret: await unseal(s.sealed) });
        }
        return out;
    }
}

// ---- small per-character client state (visited rooms, feed position): not secret, so localStorage

export function readLocal<T>(name: string, fallback: T): T {
    try {
        const v = localStorage.getItem(`abbey.${name}`);
        return v ? (JSON.parse(v) as T) : fallback;
    } catch {
        return fallback;
    }
}

export function writeLocal(name: string, value: unknown): void {
    try {
        localStorage.setItem(`abbey.${name}`, JSON.stringify(value));
    } catch {
        // storage blocked: the map and feed just start fresh next time
    }
}
