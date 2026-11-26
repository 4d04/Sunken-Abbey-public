/*
 * A player's session: game reads, and every message as one call that returns only once its effect is in committed
 * plugin state. tx-by-hash can report a tx that missed its block as committed (M2 report, finding 8), so nothing here
 * trusts it. Dice actions commit, then reveal automatically as soon as the commit is in state (SPEC §7.3, §8).
 */

import { type Character, type DieRoll, type GameEvent, type Intent, type Item, type RoomState, LEVELS, LIVE_VARIANTS, REGISTRY, commitment, loadContent, rollId as computeRollId, u64be } from '@abbey/rules';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { type ChainEvent, type Key, type MsgFields, Net, sleep } from './net.ts';

type MaybePromise<T> = T | Promise<T>;

/**
 * What a session needs from wherever the player's key lives: the key, and a store for per-roll secrets that survives
 * a crash or a page reload. The Node vault (vault.ts) and the browser's IndexedDB store both fit.
 */
export interface Signer {
    readonly key: Key;
    saveSecret(rollId: string, charId: string, secret: Uint8Array): MaybePromise<void>;
    secret(rollId: string): MaybePromise<Uint8Array | null>;
    dropSecret(rollId: string): MaybePromise<void>;
    pending(): MaybePromise<{ rollId: string; charId: string; sealedAt: number; secret: Uint8Array }[]>;
}

export const content = loadContent(LEVELS, REGISTRY, LIVE_VARIANTS);

// ---- plugin record shapes (plugin/src/abbey/config.ts)

export interface CharRecord {
    char: Character;
    rolled: number[] | null;
    actionNonce: number;
    pending: string | null;
}

export interface RollRecord {
    id: string;
    kind: 'stats' | 'act';
    owner: string;
    charId: string;
    intent: Intent | null;
    commit: string;
    committedAt: number;
    expiresAt: number;
    resolved: null | {
        height: number;
        outcome: 'resolved' | 'fizzled' | 'forfeited';
        secret: string | null;
        beacon: string | null;
        dice: DieRoll[];
        success: boolean | null;
        fizzled?: string;
        events?: GameEvent[];
    };
}

export interface Account {
    stash: Item[];
    chars: string[];
    nextChar: number;
    characters: Character[];
    balance: string; // µGOLD
}

export interface OptionEntry {
    intent: Intent;
    needsRoll: boolean;
    odds: null | { kind: 'check' | 'attack'; bp: number; mod: number; target: number; advantage: boolean; disadvantage: boolean };
}

/** What an action came to: the resolved roll for dice actions, the event for dice-free ones. */
export interface Outcome {
    rollId: string;
    roll: RollRecord | null; // dice actions: the resolved roll (verifiable)
    outcome: 'resolved' | 'fizzled' | 'forfeited';
    events: GameEvent[];
    success: boolean | null;
    fizzled?: string;
    height: number;
}

export type Phase =
    | { phase: 'submitted'; type: string }
    | { phase: 'resubmit'; type: string; reason: string }
    | { phase: 'sealed'; rollId: string; committedAt: number; expiresAt: number }
    | { phase: 'revealing'; rollId: string };

export type OnProgress = (p: Phase) => void;

/** A refusal the player should see (the plugin's message, without its "abbey: " prefix). */
export class GameError extends Error {}

const MICRO = 1_000_000n;
export const gold = (micro: string | bigint): string => {
    const v = BigInt(micro);
    const whole = v / MICRO;
    const frac = v % MICRO;
    return frac === 0n ? `${whole}` : `${whole}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
};

export class Session<V extends Signer = Signer> {
    readonly net: Net;
    readonly vault: V;
    private sendFee: bigint | null = null;
    private params: { fees: Record<string, string>; at: number } | null = null; // fee overrides, re-read every 30s

    /** How often to check state while waiting for a tx to land: about half a block suits (default 1s, for 6s blocks). */
    pollMs: number;

    constructor(net: Net, vault: V, opts: { pollMs?: number } = {}) {
        this.net = net;
        this.vault = vault;
        this.pollMs = opts.pollMs ?? 1000;
    }

    get address(): string {
        return this.vault.key.address;
    }

    // ---------------------------------------------------------------- reads

    account(): Promise<Account> {
        return this.net.abbey<Account>(`/abbey/account?address=${this.address}`) as Promise<Account>;
    }

    async character(id: string): Promise<CharRecord | null> {
        return this.net.abbey<CharRecord>(`/abbey/character?id=${id}`);
    }

    async options(charId: string): Promise<{ status: string; pending?: string | null; options: OptionEntry[] }> {
        return (await this.net.abbey(`/abbey/options?char=${charId}`))!;
    }

    async room(levelId: number, roomId: number): Promise<{ room: RoomState; characters: Character[] }> {
        return (await this.net.abbey(`/abbey/room?level=${levelId}&room=${roomId}`))!;
    }

    roll(id: string): Promise<RollRecord | null> {
        return this.net.abbey<RollRecord>(`/abbey/roll?id=${id}`);
    }

    beacon(height: number): Promise<{ height: number; value: string; proposer: string; txCount: number } | null> {
        return this.net.abbey(`/abbey/beacon?at=${height}`);
    }

    async level(levelId = 1): Promise<{ id: number; season: number; bossKilledAt: number; flood?: unknown } | null> {
        const levels = (await this.net.abbey<{ id: number; season: number; bossKilledAt: number }[]>('/abbey/levels')) ?? [];
        return levels.find((l) => l.id === levelId) ?? null;
    }

    async balance(): Promise<bigint> {
        return this.net.balance(this.address);
    }

    /** The minimum fee for a message: its params override, else the core send fee; the faucet is always free. */
    async fee(type: string): Promise<bigint> {
        if (type === 'faucet_claim') return 0n;
        if (!this.params || Date.now() - this.params.at > 30_000) {
            const p = await this.net.abbey<{ params: { fees: Record<string, string> } }>('/abbey/params');
            this.params = { fees: p?.params.fees ?? {}, at: Date.now() };
        }
        const override = this.params.fees[type];
        if (override) return BigInt(override);
        this.sendFee ??= await this.net.sendFee();
        return this.sendFee;
    }

    // ---------------------------------------------------------------- the send loop

    /**
     * Submit until `done()` sees the effect in plugin state. A tx dropped by the per-block cap ("block is full") is
     * resubmitted after a jittered back-off; one dropped silently from a full mempool is resubmitted after a timeout.
     * Any other failure is thrown as a GameError. Returns the hash of the attempt that landed (best known).
     */
    async send(type: string, fields: MsgFields, done: () => Promise<boolean>, onProgress?: OnProgress, created?: number): Promise<string> {
        const fee = await this.fee(type);
        for (let attempt = 1; attempt <= 6; attempt++) {
            let hash: string;
            try {
                hash = await this.net.submit(this.vault.key, type, { address: hexToBytes(this.address), ...fields }, fee, attempt === 1 ? created : undefined);
            } catch (e) {
                // refused at submission: fine if an earlier attempt (say, from before a crash or reload) already landed
                if (await done()) return '';
                throw new GameError(cleanError(String((e as Error).message)));
            }
            onProgress?.({ phase: 'submitted', type });
            let retry = '';
            const polls = Math.ceil(60_000 / this.pollMs);
            const failureEvery = Math.max(1, Math.round(4000 / this.pollMs)); // the failed-tx list is checked about every 4s
            for (let poll = 1; poll <= polls && !retry; poll++) {
                await sleep(this.pollMs);
                if (await done()) return hash;
                if (poll % failureEvery === 0) {
                    const err = await this.net.failure(this.address, hash);
                    if (err && /block is full/.test(err)) retry = 'the block was full';
                    else if (err) {
                        if (await done()) return hash; // an earlier attempt landed after all
                        throw new GameError(cleanError(err));
                    }
                }
            }
            retry ||= 'not seen in 60s';
            onProgress?.({ phase: 'resubmit', type, reason: retry });
            await sleep(4000 + Math.random() * 6000);
            if (await done()) return hash;
        }
        throw new GameError(`${type} did not land after 6 attempts`);
    }

    // ---------------------------------------------------------------- camp

    async claimFaucet(): Promise<void> {
        const rec = async () => (await this.net.abbey<{ record: { count: number } | null }>(`/abbey/faucet?address=${this.address}`))?.record?.count ?? 0;
        const before = await rec();
        await this.send('faucet_claim', {}, async () => (await rec()) > before);
    }

    /** Create a character: commit to the stat roll, reveal it, and return the id and the six rolled scores. */
    async createCharacter(name: string, classId: string, onProgress?: OnProgress): Promise<{ charId: string; rolled: number[] }> {
        const acct = await this.account();
        const charId = bytesToHex(sha256(concatBytes(hexToBytes(this.address), u64be(acct.nextChar))).subarray(0, 16));
        const rid = bytesToHex(computeRollId(hexToBytes(charId), 0));
        const secret = await this.freshSecret(rid, charId);
        await this.send('create_character', { name, classId, commit: commitment(secret, hexToBytes(rid)) }, async () => !!(await this.roll(rid)), onProgress);
        const roll = await this.revealRoll(rid, onProgress);
        if (!roll.resolved || roll.resolved.outcome === 'fizzled') throw new GameError('the stat roll did not resolve');
        return { charId, rolled: (await this.character(charId))!.rolled ?? [] };
    }

    /** permutation[i] = which rolled score goes to ability i (STR DEX CON INT WIS CHA). */
    async assignStats(charId: string, permutation: number[]): Promise<void> {
        await this.send('assign_stats', { charId: hexToBytes(charId), permutation }, async () => (await this.character(charId))?.char.status !== 'rolling');
    }

    async enter(charId: string): Promise<void> {
        await this.send('enter_dungeon', { charId: hexToBytes(charId) }, async () => (await this.character(charId))?.char.status === 'delving');
    }

    async extract(charId: string): Promise<void> {
        await this.send('extract', { charId: hexToBytes(charId) }, async () => (await this.character(charId))?.char.status === 'camp');
    }

    async shopBuy(charId: string, template: string, qty = 1): Promise<void> {
        const count = async () => (await this.character(charId))!.char.inventory.filter((i) => i.template === template).length;
        const before = await count();
        await this.send('shop_buy', { charId: hexToBytes(charId), template, qty }, async () => (await count()) >= before + qty);
    }

    async shopSell(charId: string, itemId: string): Promise<void> {
        await this.send('shop_sell', { charId: hexToBytes(charId), itemId }, async () => !(await this.character(charId))!.char.inventory.some((i) => i.id === itemId));
    }

    async stashMove(charId: string, itemId: string, toStash: boolean): Promise<void> {
        const carried = async () => (await this.character(charId))!.char.inventory.some((i) => i.id === itemId);
        await this.send('stash_move', { charId: hexToBytes(charId), itemId, toStash }, async () => (await carried()) !== toStash);
    }

    /**
     * Join `withId`'s party (your own id: lead your own), or leave with null (SPEC §3.6). While in a party, any member's
     * move within the level takes the members standing with them along.
     */
    async partySet(charId: string, withId: string | null): Promise<void> {
        const want = withId === null ? undefined : withId === charId ? charId : ((await this.character(withId))?.char.party ?? withId);
        await this.send('party_set', { charId: hexToBytes(charId), with: withId === null ? new Uint8Array() : hexToBytes(withId) }, async () => (await this.character(charId))?.char.party === want);
    }

    async give(charId: string, toCharId: string, gift: { itemId: string } | { gold: number }): Promise<void> {
        const me = async () => (await this.character(charId))!.char;
        const before = await me();
        const fields: MsgFields = { charId: hexToBytes(charId), toCharId: hexToBytes(toCharId) };
        if ('itemId' in gift) fields.itemId = gift.itemId;
        else fields.gold = gift.gold;
        await this.send('give', fields, async () => {
            const now = await me();
            return 'itemId' in gift ? !now.inventory.some((i) => i.id === gift.itemId) : now.carriedGold < before.carriedGold;
        });
    }

    // ---------------------------------------------------------------- the dungeon

    /** One exchange. Dice actions commit and reveal automatically; the result comes back once it's in state. */
    async act(charId: string, intent: Intent, needsRoll: boolean, onProgress?: OnProgress): Promise<Outcome> {
        // the character, the fee and a fresh height in one round trip instead of three
        const [found] = await Promise.all([this.character(charId), this.fee('act'), this.fee('reveal'), this.net.recentHeight(2000)]);
        const rec = found ?? fail(`no character ${charId}`);
        if (rec.pending) throw new GameError('a roll is still pending for this character');
        const nonce = rec.actionNonce;
        const rid = bytesToHex(computeRollId(hexToBytes(charId), nonce));
        const fields = { charId: hexToBytes(charId), ...intentFields(intent) };
        if (needsRoll) {
            const secret = await this.freshSecret(rid, charId);
            let sealed: RollRecord | null = null;
            await this.send('act', { ...fields, commit: commitment(secret, hexToBytes(rid)) }, async () => !!(sealed = await this.roll(rid)), onProgress);
            const roll = await this.revealRoll(rid, onProgress, sealed ?? undefined);
            const r = roll.resolved!;
            return { rollId: rid, roll, outcome: r.outcome, events: r.events ?? [], success: r.success, fizzled: r.fizzled, height: r.height };
        }
        const from = await this.net.height();
        await this.send('act', fields, async () => ((await this.character(charId))?.actionNonce ?? 0) > nonce, onProgress);
        const ev = await this.findEvent(from, (e) => (e.kind === 'ActionResolved' || e.kind === 'ActionFizzled') && e.data.rollId === rid);
        return {
            rollId: rid,
            roll: null,
            outcome: ev?.kind === 'ActionFizzled' ? 'fizzled' : 'resolved',
            events: (ev?.data.events as GameEvent[]) ?? [],
            success: (ev?.data.success as boolean | null) ?? null,
            height: ev?.height ?? 0
        };
    }

    /** Reveal a committed roll as soon as its commit is in state, and wait for the resolution. */
    async revealRoll(rid: string, onProgress?: OnProgress, sealed?: RollRecord): Promise<RollRecord> {
        // `sealed` is the roll as just seen landing: no need to read it again before revealing
        const roll = sealed ?? (await this.roll(rid)) ?? fail(`no roll ${rid}`);
        let done: RollRecord | null = roll.resolved ? roll : null;
        if (!roll.resolved) {
            onProgress?.({ phase: 'sealed', rollId: rid, committedAt: roll.committedAt, expiresAt: roll.expiresAt });
            const secret = (await this.vault.secret(rid)) ?? fail('the secret for this roll is not in this profile');
            // the reveal must land after the commit block, which it does: the roll is already in committed state. Its
            // created height is the commit's, known already, so the reveal goes out with no round trip first.
            onProgress?.({ phase: 'revealing', rollId: rid });
            await this.send('reveal', { rollId: hexToBytes(rid), secret }, async () => !!(done = await this.roll(rid))?.resolved, onProgress, roll.committedAt);
        }
        await this.vault.dropSecret(rid);
        return done?.resolved ? done : (await this.roll(rid))!;
    }

    /**
     * After a restart: reveal every roll this profile sealed that is still open. Rolls that resolved (or were
     * forfeited) meanwhile, or whose commit never landed, are cleared. Returns what was found.
     */
    async resumePending(onProgress?: OnProgress): Promise<{ revealed: RollRecord[]; cleared: string[] }> {
        const out = { revealed: [] as RollRecord[], cleared: [] as string[] };
        const h = await this.net.height();
        for (const p of await this.vault.pending()) {
            const roll = await this.roll(p.rollId);
            if (roll && !roll.resolved && h <= roll.expiresAt) {
                out.revealed.push(await this.revealRoll(p.rollId, onProgress));
            } else if (roll || Date.now() - p.sealedAt > 10 * 60_000) {
                await this.vault.dropSecret(p.rollId);
                out.cleared.push(p.rollId);
            }
        }
        return out;
    }

    /** Scan blocks from `from` to the chain tip for an event (dice-free outcomes are only in events). */
    private async findEvent(from: number, match: (e: ChainEvent) => boolean): Promise<ChainEvent | null> {
        const to = await this.net.height();
        for (let h = from; h < to; h++) {
            const hit = (await this.net.events(h)).find(match);
            if (hit) return hit;
        }
        return null;
    }

    private async freshSecret(rid: string, charId: string): Promise<Uint8Array> {
        const secret = crypto.getRandomValues(new Uint8Array(32));
        await this.vault.saveSecret(rid, charId, secret); // before the commit is sent: a crash can still reveal
        return secret;
    }
}

/** An engine intent as MessageAct fields (the plugin's intentFrom is the inverse). */
export function intentFields(intent: Intent): MsgFields {
    switch (intent.kind) {
        case 'action':
            return { kind: 'action', actionId: intent.actionId };
        case 'attack':
            return { kind: 'attack', target: String(intent.target), itemId: intent.weapon };
        case 'ability':
            return { kind: 'ability', ability: intent.ability, target: intent.target === undefined ? undefined : String(intent.target) };
        case 'useItem':
            return { kind: 'useItem', itemId: intent.itemId, target: intent.target };
        case 'move':
            return typeof intent.to === 'number' ? { kind: 'move', toRoom: intent.to } : { kind: 'move', toLevel: intent.to.level, toRoom: intent.to.room };
        case 'rest':
            return { kind: 'rest' };
        case 'take':
            return { kind: 'take', lootRef: intent.lootRef };
        case 'stabilize':
            return { kind: 'stabilize', target: intent.target };
    }
}

export function cleanError(msg: string): string {
    const m = /"msg"\s*:\s*"([^"]+)"/.exec(msg);
    return (m ? m[1] : msg).replace(/^abbey: /, '');
}

function fail(msg: string): never {
    throw new GameError(msg);
}
