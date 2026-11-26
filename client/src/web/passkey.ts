/*
 * Passkey accounts (SPEC §11, decision 11). A passkey can't sign Canopy transactions (it isn't BLS), but its PRF
 * extension returns the same 32 bytes for a fixed salt on every device the passkey syncs to. The player's BLS key is
 * derived from those bytes, so one Face ID or Touch ID tap signs in anywhere, with no password, seed phrase or server.
 *
 * A passkey belongs to the domain it was made on (its rpId): the same passkey on another domain is a different account.
 */

import { bls12_381 } from '@noble/curves/bls12-381.js';
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { type Key, keyFromPrivate } from '../lib/net.ts';

/** The PRF input: fixed forever, or every account changes. */
export const PRF_SALT = sha256(utf8ToBytes('abbey.passkey.prf.v1'));

/** The account key from a passkey's PRF output: HKDF-SHA256 to 48 bytes, reduced mod r (bias below 2^-128). */
export function keyFromPrf(prf: Uint8Array): Key {
    const okm = hkdf(sha256, prf, utf8ToBytes('abbey.bls.v1'), utf8ToBytes('drowned-abbey'), 48);
    const sk = bytesToNumberBE(okm) % bls12_381.fields.Fr.ORDER;
    if (sk === 0n) throw new Error('degenerate key');
    return keyFromPrivate(bytesToHex(numberToBytesBE(sk, 32)));
}

/** Whether this browser says it can do passkeys with PRF: true, false, or null when it won't say (try it). */
export async function prfSupport(): Promise<boolean | null> {
    if (!window.PublicKeyCredential || !navigator.credentials) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = await (PublicKeyCredential as any).getClientCapabilities?.().catch(() => null);
    if (caps && 'extension:prf' in caps) return !!caps['extension:prf'];
    return null;
}

const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function prfFrom(cred: Credential | null): Uint8Array | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = (cred as any)?.getClientExtensionResults?.()?.prf?.results?.first as ArrayBuffer | undefined;
    return first ? new Uint8Array(first) : null;
}

export class PasskeyError extends Error {}

/**
 * Create a passkey for this site and return its PRF output. Some authenticators only report PRF on use, not on
 * creation, so a second tap may be needed; null means this passkey has no PRF (fall back to a device key).
 */
export async function createPasskey(handle: string): Promise<Uint8Array | null> {
    let cred: Credential | null;
    try {
        cred = await navigator.credentials.create({
            publicKey: {
                rp: { name: 'The Drowned Abbey', id: location.hostname },
                user: { id: rnd(16), name: handle, displayName: handle },
                challenge: rnd(32), // nothing verifies it: the passkey is only used for its PRF output
                pubKeyCredParams: [
                    { type: 'public-key', alg: -7 },
                    { type: 'public-key', alg: -257 }
                ],
                authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
                extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs
            }
        });
    } catch (e) {
        throw new PasskeyError(friendly(e));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ext = (cred as any)?.getClientExtensionResults?.()?.prf;
    const prf = prfFrom(cred);
    if (prf) return prf;
    if (ext && ext.enabled === false) return null;
    return signIn(); // enabled but not evaluated at creation: one more tap
}

/** Sign in with an existing passkey for this site (the browser offers the account picker). */
export async function signIn(): Promise<Uint8Array | null> {
    let cred: Credential | null;
    try {
        cred = await navigator.credentials.get({
            publicKey: {
                challenge: rnd(32),
                rpId: location.hostname,
                userVerification: 'required',
                extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs
            }
        });
    } catch (e) {
        throw new PasskeyError(friendly(e));
    }
    return prfFrom(cred);
}

function friendly(e: unknown): string {
    const name = (e as DOMException)?.name;
    if (name === 'NotAllowedError') return 'The passkey prompt was dismissed or timed out.';
    if (name === 'InvalidStateError') return 'This device already has a passkey for this account.';
    if (name === 'SecurityError') return 'Passkeys need https, or localhost.';
    return (e as Error)?.message ?? String(e);
}
