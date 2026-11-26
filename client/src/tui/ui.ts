/* Terminal plumbing: prompts, hidden input, colour and animation only when attached to a TTY (piped input stays plain). */

import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';

const TTY = !!process.stdout.isTTY && process.env.NO_COLOR === undefined;
const wrap = (code: string) => (s: string) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('34'),
    cyan: wrap('36'),
    gray: wrap('90')
};
export const animated = TTY && process.env.ABBEY_NO_ANIM === undefined;

export class Ui {
    private muted = false;
    private readonly rl: Interface;
    private readonly lines: string[] = [];
    private readonly waiting: ((line: string | null) => void)[] = [];
    private closed = false;

    constructor() {
        // output goes through a gate so hidden prompts (the passphrase) don't echo
        const out = new Writable({
            write: (chunk, _enc, cb) => {
                if (!this.muted) process.stdout.write(chunk);
                cb();
            }
        });
        this.rl = createInterface({ input: process.stdin, output: out, terminal: !!process.stdin.isTTY });
        this.rl.on('line', (l) => {
            const w = this.waiting.shift();
            if (w) w(l);
            else this.lines.push(l);
        });
        // Ctrl-C in a TTY arrives on the readline interface; hand it to the process handler
        this.rl.on('SIGINT', () => process.emit('SIGINT'));
        this.rl.on('close', () => {
            this.closed = true;
            for (const w of this.waiting.splice(0)) w(null);
        });
    }

    print(s = ''): void {
        process.stdout.write(`${s}\n`);
    }

    /** Ask for a line; null when input has ended (piped input ran out, or Ctrl-D). */
    async ask(prompt: string): Promise<string | null> {
        process.stdout.write(prompt);
        const queued = this.lines.shift();
        if (queued !== undefined) {
            if (!process.stdin.isTTY) process.stdout.write(`${queued}\n`); // echo scripted input
            return queued.trim();
        }
        if (this.closed) return null;
        const line = await new Promise<string | null>((r) => this.waiting.push(r));
        if (line !== null && !process.stdin.isTTY) process.stdout.write(`${line}\n`);
        return line === null ? null : line.trim();
    }

    async askHidden(prompt: string): Promise<string | null> {
        process.stdout.write(prompt);
        this.muted = !!process.stdin.isTTY;
        try {
            const queued = this.lines.shift();
            if (queued !== undefined) return queued;
            if (this.closed) return null;
            return await new Promise<string | null>((r) => this.waiting.push(r));
        } finally {
            if (this.muted) process.stdout.write('\n');
            this.muted = false;
        }
    }

    /** A numbered choice; returns the index, or null on input end. Extra keys (like "q") come back as strings. */
    async choose(prompt: string, items: string[], keys: string[] = []): Promise<number | string | null> {
        for (;;) {
            const a = await this.ask(prompt);
            if (a === null) return null;
            if (keys.includes(a.toLowerCase())) return a.toLowerCase();
            const n = Number(a);
            if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
            this.print(c.dim(`  pick 1-${items.length}${keys.length ? ` or ${keys.join('/')}` : ''}`));
        }
    }

    /** A status line that rewrites itself in place on a TTY. */
    status(s: string): void {
        if (TTY) process.stdout.write(`\r\x1b[2K${s}`);
        else this.print(s);
    }

    endStatus(): void {
        if (TTY) process.stdout.write('\n');
    }

    close(): void {
        this.rl.close();
    }
}

/** A die tumbling and landing on the real value: the outcome is already fixed on chain, this only shows it. */
export async function rollAnimation(ui: Ui, label: string, sides: number, value: number, paint: (s: string) => string = c.bold): Promise<void> {
    if (!animated) {
        ui.print(`  ${label}: ${paint(String(value))}`);
        return;
    }
    for (let i = 0; i < 9; i++) {
        ui.status(`  ${label}: ${c.dim(String(1 + Math.floor(Math.random() * sides)))}`);
        await new Promise((r) => setTimeout(r, 40 + i * 12));
    }
    ui.status(`  ${label}: ${paint(String(value))}`);
    ui.endStatus();
}

export function bar(value: number, max: number, width = 10): string {
    const n = max > 0 ? Math.max(0, Math.min(width, Math.round((value / max) * width))) : 0;
    const filled = '█'.repeat(n);
    const empty = '░'.repeat(width - n);
    return value / max > 0.5 ? c.green(filled) + c.gray(empty) : value / max > 0.25 ? c.yellow(filled) + c.gray(empty) : c.red(filled) + c.gray(empty);
}
