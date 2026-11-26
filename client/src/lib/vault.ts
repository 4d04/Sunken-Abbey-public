/*
 * The player's vault (SPEC §8): an encrypted key file and the per-action roll secrets, under one passphrase.
 * Secrets are written before the commit is sent, so a restart can still reveal before the roll is forfeited.
 * Nothing secret is ever logged; decrypted values live only in memory.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Key, keyFromPrivate, newKey } from './net.ts';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

interface Sealed {
    iv: string;
    tag: string;
    ct: string;
}

interface KeyFile {
    version: 1;
    address: string;
    publicKey: string;
    kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number };
    key: Sealed;
}

export interface PendingSecret {
    rollId: string;
    charId: string;
    sealedAt: number; // wall clock, for display only
    secret: Uint8Array;
}

/** Profile directory: $ABBEY_HOME/<profile>, default ~/.abbey/default. */
export function profileDir(profile = process.env.ABBEY_PROFILE || 'default', home = process.env.ABBEY_HOME || join(homedir(), '.abbey')): string {
    return join(home, profile);
}

export class WrongPassphrase extends Error {}

export class Vault {
    readonly dir: string;
    readonly key: Key;
    private readonly aes: Buffer;

    private constructor(dir: string, key: Key, aes: Buffer) {
        this.dir = dir;
        this.key = key;
        this.aes = aes;
    }

    static exists(dir: string): boolean {
        return existsSync(join(dir, 'key.json'));
    }

    /** Create a profile with a fresh key (or an imported private key, hex). */
    static create(dir: string, passphrase: string, privateKey?: string): Vault {
        if (Vault.exists(dir)) throw new Error(`a key already exists in ${dir}`);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const key = privateKey ? keyFromPrivate(privateKey) : newKey();
        const salt = randomBytes(16);
        const aes = derive(passphrase, salt);
        const file: KeyFile = {
            version: 1,
            address: key.address,
            publicKey: key.publicKey,
            kdf: { name: 'scrypt', salt: salt.toString('hex'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
            key: seal(aes, Buffer.from(key.privateKey, 'hex'))
        };
        writePrivate(join(dir, 'key.json'), JSON.stringify(file, null, 2));
        return new Vault(dir, key, aes);
    }

    static open(dir: string, passphrase: string): Vault {
        const file = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')) as KeyFile;
        const aes = derive(passphrase, Buffer.from(file.kdf.salt, 'hex'), file.kdf);
        let priv: Buffer;
        try {
            priv = unseal(aes, file.key);
        } catch {
            throw new WrongPassphrase('wrong passphrase');
        }
        const key = keyFromPrivate(priv.toString('hex'));
        if (key.address !== file.address) throw new Error('key file is corrupt: address does not match the key');
        return new Vault(dir, key, aes);
    }

    /** The address in a profile, without the passphrase. */
    static address(dir: string): string {
        return (JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')) as KeyFile).address;
    }

    // ---- roll secrets

    saveSecret(rollId: string, charId: string, secret: Uint8Array): void {
        const all = this.readPending();
        all[rollId] = { charId, sealedAt: Date.now(), ...seal(this.aes, Buffer.from(secret)) };
        writePrivate(join(this.dir, 'pending.json'), JSON.stringify(all, null, 2));
    }

    secret(rollId: string): Uint8Array | null {
        const s = this.readPending()[rollId];
        return s ? new Uint8Array(unseal(this.aes, s)) : null;
    }

    dropSecret(rollId: string): void {
        const all = this.readPending();
        if (!(rollId in all)) return;
        delete all[rollId];
        writePrivate(join(this.dir, 'pending.json'), JSON.stringify(all, null, 2));
    }

    pending(): PendingSecret[] {
        return Object.entries(this.readPending()).map(([rollId, s]) => ({ rollId, charId: s.charId, sealedAt: s.sealedAt, secret: new Uint8Array(unseal(this.aes, s)) }));
    }

    private readPending(): Record<string, Sealed & { charId: string; sealedAt: number }> {
        const p = join(this.dir, 'pending.json');
        return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    }

    // ---- non-secret client state (visited rooms, feed position)

    readState<T>(name: string, fallback: T): T {
        const p = join(this.dir, `${name}.json`);
        return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fallback;
    }

    writeState(name: string, value: unknown): void {
        writePrivate(join(this.dir, `${name}.json`), JSON.stringify(value));
    }
}

function derive(passphrase: string, salt: Buffer, kdf: { N: number; r: number; p: number } = SCRYPT): Buffer {
    return scryptSync(passphrase.normalize('NFKC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT.maxmem });
}

function seal(aes: Buffer, plain: Buffer): Sealed {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', aes, iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex') };
}

function unseal(aes: Buffer, s: Sealed): Buffer {
    const d = createDecipheriv('aes-256-gcm', aes, Buffer.from(s.iv, 'hex'));
    d.setAuthTag(Buffer.from(s.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(s.ct, 'hex')), d.final()]);
}

/** Write atomically with owner-only permissions. */
function writePrivate(path: string, data: string): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
}
