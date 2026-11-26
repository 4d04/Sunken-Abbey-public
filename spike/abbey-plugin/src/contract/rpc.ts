/* Abbey spike read-only RPC routes, each backed by the detached queryState() path */

import * as http from 'http';
import Long from 'long';

import { types } from '../proto/types.js';
import { Plugin, PLUGIN_BUILD } from './plugin.js';
import { KeyForBeacon, KeyForBeaconLatest, KeyForRoll, KeyForFaucetRecord, KeyForRoller } from './contract.js';

// StartRPCServer() launches the plugin's own HTTP server for abbey queries
export function StartRPCServer(plugin: Plugin): void {
    const addr = plugin.config.rpcAddress;
    if (!addr) {
        console.log('plugin RPC server disabled (no rpcAddress configured)');
        return;
    }

    const server = http.createServer((req, res) => {
        handle(plugin, req, res).catch((e) => writeJSON(res, 500, { error: String(e) }));
    });

    const idx = addr.lastIndexOf(':');
    const host = idx >= 0 ? addr.slice(0, idx) : '127.0.0.1';
    const port = idx >= 0 ? Number(addr.slice(idx + 1)) : Number(addr);
    server.listen(port, host, () => {
        console.log(`plugin RPC server (${PLUGIN_BUILD}) listening on ${addr}`);
    });
    server.on('error', (err) => {
        console.log(`plugin RPC server error: ${err.message}`);
    });
}

async function handle(plugin: Plugin, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const height = Number(url.searchParams.get('height') || 0);
    const address = url.searchParams.get('address');
    switch (url.pathname) {
        case '/abbey/beacon': {
            const h = url.searchParams.get('at');
            const key = h ? KeyForBeacon(BigInt(h)) : KeyForBeaconLatest();
            return writeRecord(res, await getOne(plugin, height, key), types.BeaconRecord);
        }
        case '/abbey/roll': {
            if (!address) return writeJSON(res, 400, { error: 'address required' });
            const nonce = BigInt(url.searchParams.get('nonce') || '0');
            return writeRecord(res, await getOne(plugin, height, KeyForRoll(hex(address), nonce)), types.RollRecord);
        }
        case '/abbey/roller': {
            if (!address) return writeJSON(res, 400, { error: 'address required' });
            return writeRecord(res, await getOne(plugin, height, KeyForRoller(hex(address))), types.RollerRecord);
        }
        case '/abbey/faucet': {
            if (!address) return writeJSON(res, 400, { error: 'address required' });
            return writeRecord(res, await getOne(plugin, height, KeyForFaucetRecord(hex(address))), types.FaucetRecord);
        }
    }
    writeJSON(res, 404, { error: 'not found' });
}

async function getOne(plugin: Plugin, height: number, key: Uint8Array): Promise<Uint8Array | null> {
    const [resp, err] = await plugin.queryState(height, { keys: [{ queryId: Long.fromNumber(1), key }] });
    if (err) {
        throw new Error(err.msg);
    }
    const value = resp?.results?.[0]?.entries?.[0]?.value;
    return value && value.length ? value : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeRecord(res: http.ServerResponse, bz: Uint8Array | null, MessageType: any): void {
    if (!bz) {
        return writeJSON(res, 404, { error: 'not found' });
    }
    const obj = MessageType.toObject(MessageType.decode(bz), { longs: String, bytes: String, defaults: true });
    // render bytes as hex rather than base64 (static protobuf classes carry no field reflection)
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && BYTES_FIELDS.has(k)) {
            obj[k] = Buffer.from(v, 'base64').toString('hex');
        }
    }
    writeJSON(res, 200, obj);
}

const BYTES_FIELDS = new Set(['address', 'value', 'proposer', 'commit', 'secret', 'beacon']);

function hex(s: string): Uint8Array {
    return Buffer.from(s.replace(/^0x/, ''), 'hex');
}

function writeJSON(res: http.ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
}
