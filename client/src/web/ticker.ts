/*
 * Video mode: the status bar's block number ticks up with every block (500ms on the game chain), each change flashing,
 * so a recording shows the chain moving. Off unless the page is opened with ?ticker (e.g. /?ticker).
 *
 * Self-contained so it can be ripped out: delete this file and the two lines in main.ts that mention `ticker`. The only
 * other trace is the `blk` class on the status bar's block number, which is harmless without it.
 */

import type { Net } from '../lib/net.ts';

const POLL_MS = 150; // several polls per 500ms block, so no block is skipped on screen

export function startTicker(net: Net): void {
    if (!new URLSearchParams(location.search).has('ticker')) return;
    const style = document.createElement('style');
    style.textContent = `
        #status .blk { font-variant-numeric: tabular-nums; transition: color 0.4s ease-out; }
        #status .blk.tick { color: var(--accent); transition: none; }`;
    document.head.appendChild(style);

    let shown = 0;
    let inFlight = false;
    const paint = (el: Element) => {
        el.textContent = `block ${shown}`;
        el.classList.add('tick');
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('tick'))); // flash, then fade back
    };
    setInterval(async () => {
        if (inFlight || document.visibilityState !== 'visible') return;
        inFlight = true;
        try {
            const committed = (await net.height()) - 1; // the node reports the height it is building next
            const el = document.querySelector('#status .blk');
            if (committed > shown) {
                shown = committed;
                if (el) paint(el);
            } else if (el && el.textContent !== `block ${shown}`) el.textContent = `block ${shown}`; // a status redraw wrote an older number
        } catch {
            // a missed poll is fine: the next one catches up
        } finally {
            inFlight = false;
        }
    }, POLL_MS);
}
