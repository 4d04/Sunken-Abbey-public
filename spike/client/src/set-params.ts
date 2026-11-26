/* Localnet helper: set_params from the throwaway authority key. Usage: PORT=300 CHAIN_ID=2 npx tsx src/set-params.ts '{"maxTxPerBlock":250}' */

import { readFileSync } from 'fs';
import { type Key, submit, waitTx } from './chain.js';

const authority: Key = JSON.parse(readFileSync(new URL('../.m2-authority.json', import.meta.url), 'utf8'));
const paramsJson = process.argv[2] ?? '{}';
// on a fresh chain the authority starts empty: a free faucet claim pays its fee (harmless if it already has gold)
await waitTx(await submit(authority, 'faucet_claim', { address: new Uint8Array(Buffer.from(authority.address, 'hex')) }, 0n), authority.address, 60_000).catch(() => undefined);
const hash = await submit(authority, 'set_params', { address: new Uint8Array(Buffer.from(authority.address, 'hex')), paramsJson }, 10_000n);
await waitTx(hash, authority.address, 60_000);
console.log(`set_params ${paramsJson} in ${hash}`);
