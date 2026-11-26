/*
 * Where a profile's passphrase is remembered, so players aren't asked for it (the "remember me" of SPEC §8):
 * the macOS Keychain, the Linux Secret Service (secret-tool), or an owner-only file in the profile.
 * The vault stays encrypted at rest either way; this only decides who supplies the passphrase.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SERVICE = 'drowned-abbey';

export interface SecretStore {
    readonly name: string; // shown to the player: where their passphrase lives
    get(account: string): string | null;
    set(account: string, secret: string): void;
    delete(account: string): void;
}

const run = (cmd: string, args: string[], input?: string): string =>
    execFileSync(cmd, args, { input, stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8' }).trimEnd();

const has = (cmd: string): boolean => {
    try {
        execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

/** The macOS login keychain, via /usr/bin/security (a generic password: service drowned-abbey, account = profile). */
export class MacKeychain implements SecretStore {
    readonly name = 'the macOS Keychain';
    get(account: string): string | null {
        try {
            return run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
        } catch {
            return null;
        }
    }
    set(account: string, secret: string): void {
        // -U updates an existing item; the value is briefly visible to `ps` as an argument, which is acceptable here
        run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-l', `Drowned Abbey (${account})`, '-w', secret]);
    }
    delete(account: string): void {
        try {
            run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
        } catch {
            // not there
        }
    }
}

/** The freedesktop Secret Service (GNOME Keyring, KWallet), via secret-tool. */
export class SecretService implements SecretStore {
    readonly name = 'the system keyring';
    get(account: string): string | null {
        try {
            return run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]) || null;
        } catch {
            return null;
        }
    }
    set(account: string, secret: string): void {
        run('secret-tool', ['store', '--label', `Drowned Abbey (${account})`, 'service', SERVICE, 'account', account], secret);
    }
    delete(account: string): void {
        try {
            run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
        } catch {
            // not there
        }
    }
}

/** A plain file, owner-only, in the profile directory: for machines without a keyring. */
export class FileStore implements SecretStore {
    readonly name = 'a file in your profile';
    private readonly dir: string;
    constructor(dir: string) {
        this.dir = dir;
    }
    private path(): string {
        return join(this.dir, 'passphrase');
    }
    get(_account: string): string | null {
        return existsSync(this.path()) ? readFileSync(this.path(), 'utf8') : null;
    }
    set(_account: string, secret: string): void {
        writeFileSync(this.path(), secret, { mode: 0o600 });
    }
    delete(_account: string): void {
        rmSync(this.path(), { force: true });
    }
}

/** The best store on this machine; ABBEY_KEYCHAIN=file|mac|secret-service forces one. */
export function secretStore(profileDir: string, choice = process.env.ABBEY_KEYCHAIN): SecretStore {
    if (choice === 'file') return new FileStore(profileDir);
    if (choice === 'mac' || (!choice && process.platform === 'darwin' && has('security'))) return new MacKeychain();
    if (choice === 'secret-service' || (!choice && has('secret-tool'))) return new SecretService();
    return new FileStore(profileDir);
}
