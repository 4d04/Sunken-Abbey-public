/*
 * A terminal in a page: one transcript that only grows (scroll up for history, kept across reloads), a pinned status
 * bar, and a prompt line. Menus print into the transcript; only the newest one answers, older ones go grey.
 */

export const esc = (v: unknown): string => String(v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export interface MenuItem {
    label: string; // plain text
    note?: string; // trusted HTML (odds), shown dim on the right
}

/** What a menu returns: an item's index, or a refresh the game asked for while it was open. */
export type Pick = { index: number } | { refresh: true };

type Waiting = { kind: 'text'; resolve: (s: string) => void } | { kind: 'menu'; size: number; el: HTMLElement; resolve: (p: Pick) => void };

const MAX_LINES = 2500;

export class Terminal {
    private readonly log: HTMLElement;
    private readonly input: HTMLInputElement;
    private readonly label: HTMLElement;
    private readonly more: HTMLElement;
    private waiting: Waiting | null = null;
    private storeKey = '';
    private saveTimer = 0;
    /** Commands typed at a menu prompt ("map", "look"…): run, then the menu keeps waiting. */
    commands: Record<string, { help: string; run: (arg: string) => Promise<void> | void }> = {};

    constructor(log: HTMLElement, input: HTMLInputElement, label: HTMLElement, more: HTMLElement) {
        this.log = log;
        this.input = input;
        this.label = label;
        this.more = more;
        input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            const v = input.value;
            input.value = '';
            void this.submit(v);
        });
        log.addEventListener('scroll', () => {
            if (this.atBottom()) this.more.hidden = true;
        });
        more.addEventListener('click', () => this.scrollDown(true));
        // a click anywhere that isn't a link or a button puts the cursor back on the prompt (but leaves text selections alone)
        log.addEventListener('mouseup', (e) => {
            if (!(e.target as HTMLElement).closest('a, button') && !window.getSelection()?.toString()) input.focus({ preventScroll: true });
        });
    }

    // ---------------------------------------------------------------- history

    /** Load the saved transcript for this account; old menus come back grey. */
    restore(key: string): void {
        this.storeKey = `abbey.transcript.${key}`;
        let saved: string[] = [];
        try {
            saved = JSON.parse(localStorage.getItem(this.storeKey) ?? '[]');
        } catch {
            saved = [];
        }
        this.log.innerHTML = saved.join('');
        this.log.querySelectorAll('.menu').forEach((m) => this.stale(m as HTMLElement));
        this.scrollDown(true);
    }

    private save(): void {
        if (!this.storeKey) return;
        clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild!.remove();
            try {
                localStorage.setItem(this.storeKey, JSON.stringify([...this.log.children].map((c) => c.outerHTML)));
            } catch {
                // storage full or blocked: history just won't survive a reload
            }
        }, 300);
    }

    clearHistory(): void {
        this.log.innerHTML = '';
        this.save();
    }

    // ---------------------------------------------------------------- output

    private atBottom(): boolean {
        return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    }

    private scrollDown(force = false): void {
        if (force || this.atBottom()) {
            this.log.scrollTop = this.log.scrollHeight;
            this.more.hidden = true;
        } else this.more.hidden = false; // the player is reading history: offer a jump instead of yanking them down
    }

    /** Append a line of trusted HTML (callers escape anything from the chain). */
    html(h: string, cls = ''): HTMLElement {
        const follow = this.atBottom();
        const el = document.createElement('div');
        el.className = `ln ${cls}`.trim();
        el.innerHTML = h || '&nbsp;';
        this.log.appendChild(el);
        this.scrollDown(follow);
        this.save();
        return el;
    }

    /** Append plain text (escaped). */
    say(s: string, cls = ''): HTMLElement {
        return this.html(esc(s), cls);
    }

    blank(): void {
        this.html('');
    }

    rule(title = ''): void {
        this.html(title ? `── ${esc(title)} ${'─'.repeat(Math.max(3, 46 - title.length))}` : '─'.repeat(50), 'rule');
    }

    /** Narration typed out; Enter or a click finishes it at once. */
    async type(s: string, cls = ''): Promise<void> {
        const follow = this.atBottom();
        const el = this.html('', cls);
        let skip = false;
        const stop = () => (skip = true);
        this.log.addEventListener('click', stop, { once: true });
        this.input.addEventListener('keydown', stop, { once: true });
        for (let i = 1; i <= s.length && !skip; i++) {
            el.textContent = s.slice(0, i);
            if (follow) this.log.scrollTop = this.log.scrollHeight;
            await new Promise((r) => setTimeout(r, 8));
        }
        el.textContent = s;
        this.log.removeEventListener('click', stop);
        this.input.removeEventListener('keydown', stop);
        this.save();
    }

    /**
     * A round's dice on one line, tumbling together and landing on their real values (fixed on chain already). A pair
     * rolled with advantage or disadvantage reads "DIS: Wren's sneak 2d20 [18, 1]", the die that doesn't count struck through.
     * Every die says who rolled it and what for ("Wren's attack d20 8 · Wren's damage d8 4").
     * A d20 that won (a hit, a check or save made, initiative taken) is green, whoever rolled it.
     */
    async diceLine(groups: { who: string; what: string; sides: number; values: number[]; kept: number; edge?: 'advantage' | 'disadvantage'; won?: boolean }[]): Promise<void> {
        if (!groups.length) return;
        const flat: { sides: number; value: number; drop: boolean; won: boolean }[] = [];
        const face = (sides: number, value: number, drop: boolean, won = false) => {
            flat.push({ sides, value, drop, won });
            return `<b class="die rolling" data-i="${flat.length - 1}">?</b>`;
        };
        const parts = groups.map((g) => {
            if (g.values.length < 2) return `${g.who}'s ${g.what} d${g.sides} ${face(g.sides, g.values[0], false, !!g.won)}`;
            const tag = g.edge === 'advantage' ? 'ADV' : g.edge === 'disadvantage' ? 'DIS' : '';
            const faces = g.values.map((v, j) => face(g.sides, v, j !== g.kept && g.values[0] !== g.values[1], j === g.kept && !!g.won));
            return `${tag ? `<span class="edge">${tag}:</span> ` : ''}${g.who}'s ${g.what} 2d${g.sides} [${faces.join(', ')}]`;
        });
        const el = this.html(`🎲 ${parts.join(' · ')}`, 'roll');
        const faces = [...el.querySelectorAll<HTMLElement>('.die')];
        for (let k = 0; k < 10; k++) {
            faces.forEach((f, i) => (f.textContent = String(1 + Math.floor(Math.random() * flat[i].sides))));
            await new Promise((r) => setTimeout(r, 35 + k * 10));
        }
        faces.forEach((f, i) => {
            f.textContent = String(flat[i].value);
            f.classList.remove('rolling');
            if (flat[i].drop) f.classList.add('dropped');
            if (flat[i].won) f.classList.add('won');
        });
        this.save();
    }

    /** A die tumbling and landing on its real value (the outcome is already fixed on chain; this only shows it). */
    async die(who: string, sides: number, value: number): Promise<void> {
        const el = this.html(`${who} d${sides}: <b class="die rolling">?</b>`, 'roll');
        const d = el.querySelector('.die')!;
        for (let i = 0; i < 10; i++) {
            d.textContent = String(1 + Math.floor(Math.random() * sides));
            await new Promise((r) => setTimeout(r, 35 + i * 10));
        }
        d.textContent = String(value);
        d.classList.remove('rolling');
        this.save();
    }

    // ---------------------------------------------------------------- input

    private setPrompt(text: string): void {
        this.label.textContent = text;
        this.input.focus({ preventScroll: true });
    }

    /** Ask for a line of text at the prompt. */
    ask(question: string, prompt = '>'): Promise<string> {
        this.html(esc(question), 'q');
        this.setPrompt(prompt);
        return new Promise((resolve) => (this.waiting = { kind: 'text', resolve }));
    }

    /** Print a numbered menu and wait: a number (typed or clicked) picks; other words run commands. */
    menu(items: MenuItem[], prompt = '>'): Promise<Pick> {
        const el = document.createElement('div');
        el.className = 'menu';
        el.innerHTML = items
            .map((it, i) => `<button data-i="${i}"><span class="n">${String(i + 1).padStart(2)})</span> <span class="l">${esc(it.label)}</span>${it.note ? ` <span class="note">${it.note}</span>` : ''}</button>`)
            .join('');
        this.log.appendChild(el);
        this.scrollDown(true); // a new menu is always the thing to look at
        this.save();
        el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => void this.submit(String(Number(b.dataset.i) + 1))));
        this.setPrompt(prompt);
        return new Promise((resolve) => (this.waiting = { kind: 'menu', size: items.length, el, resolve }));
    }

    /** Close the open menu with a refresh (the room changed under it). */
    interrupt(): void {
        const w = this.waiting;
        if (w?.kind !== 'menu') return;
        this.waiting = null;
        this.stale(w.el);
        w.resolve({ refresh: true });
    }

    get atMenu(): boolean {
        return this.waiting?.kind === 'menu';
    }

    private stale(el: HTMLElement): void {
        el.classList.add('stale');
        el.querySelectorAll('button').forEach((b) => (b.disabled = true));
    }

    private async submit(raw: string): Promise<void> {
        const v = raw.trim();
        const w = this.waiting;
        if (!w) return;
        if (w.kind === 'text') {
            this.waiting = null;
            this.html(`<span class="echo">${esc(this.label.textContent)} ${esc(v)}</span>`);
            this.setPrompt('');
            w.resolve(v);
            return;
        }
        const n = Number(v);
        if (/^\d+$/.test(v) && n >= 1 && n <= w.size) {
            this.waiting = null;
            const label = w.el.querySelector(`[data-i="${n - 1}"] .l`)?.textContent ?? '';
            w.el.querySelector(`[data-i="${n - 1}"]`)?.classList.add('picked');
            this.stale(w.el);
            this.html(`<span class="echo">&gt; ${n}  ${esc(label)}</span>`);
            this.setPrompt('');
            w.resolve({ index: n - 1 });
            return;
        }
        if (!v) return;
        const [word, ...rest] = v.split(/\s+/);
        const cmd = this.commands[word.toLowerCase()];
        this.html(`<span class="echo">&gt; ${esc(v)}</span>`);
        if (!cmd) {
            this.say(`Pick 1–${w.size}, or type help.`, 'dim');
            return;
        }
        await cmd.run(rest.join(' '));
        this.input.focus({ preventScroll: true });
    }
}
