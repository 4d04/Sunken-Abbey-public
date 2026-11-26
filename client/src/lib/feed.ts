/* The shared-world feed (SPEC §8): other players' events, told as one line each, with a tone for colouring. */

import type { GameEvent, Intent, RoomState } from '@abbey/rules';
import { describeIntent, roomTitle } from './narrate.ts';
import { progressMade } from './progress.ts';
import { content } from './session.ts';

const LEVEL1 = content.levels.get(1)!.def;
import type { ChainEvent } from './net.ts';
import type { Session } from './session.ts';

export type Tone = 'plain' | 'quiet' | 'good' | 'warn' | 'bad';

export interface FeedLine {
    height: number;
    text: string; // the main clause
    tag: string; // a short trailing note ("(hit)", "and slew the Drowned Abbot!")
    tone: Tone; // of the whole line
    tagTone: Tone;
}

/** Tells chain events as feed lines, caching character names and room monsters (templates never change). */
export class FeedTeller {
    private readonly s: Session;
    private readonly names = new Map<string, string>();
    private readonly rooms = new Map<string, RoomState>();

    constructor(s: Session) {
        this.s = s;
    }

    /** Lines for the blocks after `after` up to the tip (at most the last `window` blocks), skipping my own events. */
    async since(after: number, window = 20): Promise<{ lines: FeedLine[]; tip: number }> {
        const tip = (await this.s.net.height()) - 1;
        const lines: FeedLine[] = [];
        // every block's events at once (one round trip, not one per block), then told in block order
        const heights = Array.from({ length: Math.max(0, tip - Math.max(after + 1, tip - window) + 1) }, (_, i) => Math.max(after + 1, tip - window) + i);
        const blocks = await Promise.all(heights.map((h) => this.s.net.events(h)));
        for (const events of blocks) {
            for (const e of events) {
                if (e.address === this.s.address) continue;
                const line = await this.tell(e);
                if (line) lines.push(line);
            }
        }
        return { lines, tip };
    }

    async tell(e: ChainEvent): Promise<FeedLine | null> {
        const d = e.data;
        const line = (text: string, tone: Tone = 'plain', tag = '', tagTone: Tone = 'quiet'): FeedLine => ({ height: e.height, text, tag, tone, tagTone });
        switch (e.kind) {
            case 'ActionResolved': {
                const who = await this.name(String(d.charId));
                const evs = (d.events as { t: string; attacker?: string; hit?: boolean }[]) ?? [];
                const intent = d.intent as Intent;
                const roomId = Number(d.roomId);
                const cast = { me: "", names: new Map<string, string>(), rooms: new Map([[roomId, await this.room(Number(d.levelId), roomId)]]), actorRoom: roomId, ours: new Set<string>() };
                const what = intent.kind === 'move' ? `went to the ${roomTitle(typeof intent.to === 'number' ? intent.to : 0)}` : `${describeIntent(intent, cast).toLowerCase()} in the ${roomTitle(roomId)}`;
                const hit = evs.find((x) => x.t === 'attack' && x.attacker === d.charId);
                const ambushed = evs.some((x) => x.t === 'initiative' && (x as { reason?: string; first?: string }).reason === 'ambush' && (x as { first?: string }).first === 'them');
                if (evs.some((x) => x.t === 'bossDefeated')) return line(`${who}: ${what}`, 'plain', ' and slew the Drowned Abbot!', 'good');
                if (evs.some((x) => x.t === 'downed')) return line(`${who}: ${what}`, 'plain', ' and someone went down', 'bad');
                if (ambushed) return line(`${who}: ${what}`, 'plain', ' and walked into an ambush', 'bad');
                if (hit) return line(`${who}: ${what}`, 'plain', hit.hit ? ' (hit)' : ' (miss)');
                // a party moving together: one tx, several arrivals
                const along = evs.filter((x) => x.t === 'move' && (x as { char?: string }).char !== d.charId).length;
                if (intent.kind === 'move' && along) return line(`${who}: ${what}`, 'plain', ` with ${along} other${along > 1 ? 's' : ''} of their party`);
                // shared work moved on (the rubble): say how far, or that the way is open now
                const job = progressMade(LEVEL1, evs as GameEvent[])[0];
                if (job) return line(`${who}: ${what}`, 'plain', job.value >= job.goal ? ` and finished it${job.opens !== undefined ? `: the way to the ${roomTitle(job.opens)} is open` : ''}` : ` (${job.value}/${job.goal} done)`, 'good');
                return line(`${who}: ${what}`, 'plain', d.success === false ? ' (failed)' : '');
            }
            case 'ActionForfeited':
                return line(`${await this.name(String(d.charId))} let a roll lapse`, 'quiet');
            case 'CharacterFerried':
                return line(`The Ferryman carried ${await this.name(String(d.charId))} back to the Lychgate`, 'warn');
            case 'EnteredDungeon':
                return line(`${await this.name(String(d.charId))} entered the abbey`);
            case 'PartyJoined':
                return d.party === d.charId
                    ? line(`${await this.name(String(d.charId))} leads a party now`, 'quiet')
                    : line(`${await this.name(String(d.charId))} joined ${await this.name(String(d.party))}'s party`, 'quiet');
            case 'PartyLeft':
                return line(`${await this.name(String(d.charId))} left ${await this.name(String(d.party))}'s party`, 'quiet');
            case 'GoldExtracted':
                return line(`${await this.name(String(d.charId))} left with ${d.gold}g`);
            case 'BellTolled':
                return line(`The bell tolls: the abbey floods at block ${d.endsAt}`, 'warn');
            case 'FloodBegan':
                return line('The flood is rising: the abbey is closed until the new season', 'bad');
            case 'SeasonStarted':
                return line(`A new season begins (season ${d.season})`, 'good');
            default:
                return null;
        }
    }

    private async name(id: string): Promise<string> {
        if (!this.names.has(id)) this.names.set(id, (await this.s.character(id))?.char.name ?? 'someone');
        return this.names.get(id)!;
    }

    private async room(levelId: number, roomId: number): Promise<RoomState> {
        const k = `${levelId}/${roomId}`;
        if (!this.rooms.has(k)) this.rooms.set(k, (await this.s.room(levelId, roomId)).room);
        return this.rooms.get(k)!;
    }
}
