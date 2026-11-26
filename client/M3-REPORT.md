# M3 Report: The Client

**Date:** 2026-11-05 · **Core:** canopy `83af2a0` · **Plugin:** `plugin/` as of M2 · **Client:** `client/` (`@abbey/client` 0.1.0)

## Verdict

**The M3 exit criterion is met: there's a playable end-to-end text UI, with auto-reveal and roll verification.** It's a terminal app, as agreed. The game logic lives in a library (`src/lib`) so a web front end can reuse it.

| Checks | Result |
|---|---|
| Unit tests (`npm test`) | 11/11, no chain needed (plus an opt-in real-Keychain test, passing) |
| End-to-end smoke test (`npm run smoke`) | 11/11 on the localnet |
| Scripted TUI sessions | Two players, played through the real UI |

## What it does

- **Profile and wallet, with no prompts.** A fresh BLS key is encrypted (scrypt and AES-256-GCM, owner-only files) under a random passphrase. The passphrase is remembered in the macOS Keychain, or the Linux keyring, or a file, so the game unlocks itself. `--export-key`, `--import-key` and `--forget` cover backup and restore. Every move is signed in the background. The client claims the free faucet when the wallet is empty, and keeps the wallet (native GOLD) and carried gold separate.
- **Characters.** The stat roll is sealed on chain, then revealed. The client suggests an assignment for the class, and the player can reorder it.
- **Camp.** Enter the abbey, shop, sell, move items between pack and stash, view the character sheet, switch characters.
- **Dungeon.** Room text from the text pack, monster HP bars, who else is here (and how many are lying low), and numbered options with exact odds from `/abbey/options`. Dice actions are marked 🎲. Extraction is offered at the Lychgate.
- **Roll theatre.** "🔒 sealed at block X → revealing (must land by X+10)". Each die animates and lands on its real value, then the exchange is narrated.
- **Verification.** `v` checks three things against the chain:
  - the revealed secret matches the commitment sealed at block X;
  - the beacon used is the chain's beacon for block X;
  - every die follows from the seed.

  Forfeits are checked against the forfeit rule.
- **Auto-reveal, even across a crash.** A secret is written to the encrypted vault *before* its commit is sent. Killed mid-roll, the client reveals on the next start, while the roll is still open. Ctrl-C warns about sealed rolls and how long is left.
- **Shared world.** A feed of other players' actions on your level since your last look, with hits, misses, downs, Ferryman rescues, the bell and floods. The ASCII map shows visited rooms and the doors seen from them; the secret door appears only once both sides are known.
- **Load-safe sending.** Every action is confirmed from committed plugin state, never tx-by-hash (M2 finding 8). "Block is full" is resubmitted after a jittered 4–10s back-off (finding 9), and other refusals are shown as the plugin worded them.

## Verified on the localnet (fresh chain at 6s blocks)

- **TUI, player 1 (Aria, a cleric):**
  - created a profile and claimed the faucet;
  - rolled her stats (sealed at block 77, resolved at 78) and entered the abbey;
  - searched the silt (sealed at 87, resolved at 88) and verified it ✓✓✓;
  - moved to the Ossuary (dice-free, its outcome read from the block's events);
  - fought a skeleton: a miss, a counterattack, 3 damage, verified ✓✓✓;
  - killed the client right after a commit was sealed; the restart revealed it, and the pending file emptied.
- **TUI, player 2 (Bram, a rogue):** created a character and saw Aria's four actions in the feed. In the Ossuary he saw her in the room and skeleton #1 at 6/13 from her hit, then fought the same group.
- **Smoke test, 11/11:**
  - two players created and entered concurrently;
  - a dice-free move;
  - an attack (commit, reveal, resolve);
  - a commit with the client "crashed", revealed by a fresh session on the same vault;
  - all 4 rolls verified against the chain's beacons;
  - the attack found in its block's events, attributed to its owner;
  - wading out and extracting.

## Findings

1. **How the core JSON carries plugin events.** At canopy `83af2a0`, `events-by-height` and `events-by-address` put a plugin event's whole custom `Any`, protobuf-encoded and hex, under `msg.orderId`, a field the core's event message reuses. `reference` holds the emitting tx's hash. `decodeEvent` handles this, and a unit test pins it with a captured sample.
2. **Dice-free outcomes exist only in events.** The plugin writes a roll record only for dice actions. So for a dice-free action, the client confirms by the character's `actionNonce` and then finds the `ActionResolved` event for its `rollId` in the blocks since submission. A plugin route for recent outcomes by roll id would make this one read. It's worth adding before the web client.
3. **Verification can't check the beacon chain itself.** Each beacon folds in that block's tx accumulator, which the plugin doesn't store. The client checks the commitment, the beacon value at the commit height, and the dice. Storing `txAcc` on the beacon record would let clients check the chain links too.
4. **Rolls are pruned after 1,000 blocks** (M2 finding 11). Verifying an older roll needs the copy the client kept. The TUI verifies its most recent roll, so this doesn't come up in play.

## Not in M3

- **A browser client.** That needs a canopy-ts keystore, session storage for secrets, and a push channel instead of polling. The library is kept free of terminal code so it can sit underneath one.
- **Live updates.** The room, the HP bars and the feed refresh when you act or press `r`, not live. The spec asks for a push channel; polling is fine at localnet scale.
- **Typed-out narration and chalk marks.** Chalk marks need plugin support and belong to M4's shared world.
- **A real-TTY check of the dice animation.** Every run here was scripted, through pipes. New profiles no longer prompt for a passphrase at all.

## M3b: the browser client (2026-11-05)

**The full game runs in a browser,** on the same library, with passkey sign-in (SPEC §11, decision 11). It's served by `npm run web` at http://localhost:5173.
- **Sign-in:**
  - "Create account" makes a passkey and derives the BLS key from its PRF output with HKDF. "Sign in" does the same with an existing passkey.
  - "Play on this device only" is the fallback for browsers without PRF.
  - The device remembers the account until "Sign out". The account menu shows the address and can export the key.
- **Play:** every move is signed in the page with no prompts. Roll secrets go into IndexedDB before the commit is sent, encrypted under a non-extractable WebCrypto key, so a reload still reveals.
- **Screens:**
  - camp (trader, pack and stash) and the dungeon (monster HP bars, who's here and how many are lying low, numbered options with odds and 🎲, keys 1–9);
  - a character sheet, the map and the feed;
  - typed-out narration, dice that tumble and land on their real values, and a "verify ▸" link on every roll.

  Screens redraw every block from chain state, but only when something changed, so a redraw never eats a click. They work at phone width.

**Library changes:**
- `net.ts` uses an ES-module copy of the plugin's protobuf types (`src/lib/proto.js`, generated by `npm run build:proto`) and plain byte arrays.
- Sessions take any `Signer` (the Node vault, or the browser's device store) and get their randomness from Web Crypto.
- The feed, the map model and stat assignment moved into the library, so both front ends share them.
- The production bundle is 70 KB gzipped.

**Plugin:** the read endpoint sends `Access-Control-Allow-Origin: *` and answers preflight requests. It's read-only, so consensus is untouched. The core RPC already allowed any origin.

**Verified in a browser** (the desktop app's built-in Chromium, against the localnet), on the device-only path:
- created an account, which also claimed the faucet;
- created Wren the wizard: the stat roll sealed at block 1665, then the score swap and confirm;
- bought a potion and entered the abbey;
- searched the silt (sealed at 1688, resolved at 1689) and verified it in the dialog: commitment, beacon and dice all ✓;
- walked to the Ossuary and attacked; the skeleton dropped to 2/13;
- reloaded mid-roll, and the page recovered;
- reloaded again: the device remembered the account;
- checked phone width (375px): no sideways scroll.

**Finding:** after that mid-roll reload, the page's second reveal was refused at submission ("roll already resolved"), because the first had already landed. `send()` threw without checking whether its goal was already met, which hung startup.
- Fixed: a refusal now counts as success when the effect is already in state.
- Startup errors now show a retry instead of hanging.
- A unit test pins the fix.

**Tests:** 13/13 unit tests (new: passkey key derivation pinned to fixed values; `send` treating an already-landed attempt as done). The smoke test passes 11/11; it now attacks whichever skeleton still stands.

**Passkey sign-in confirmed on a real device** (2026-11-05): the project owner created an account with a passkey on their Mac at http://localhost:5173 and signed in to it from the passkey, with Touch ID. The built-in browser used for the other checks has no platform authenticator.

### The browser as a terminal (2026-11-05)

At the project owner's request, the browser client was reworked to look and play like a terminal:
- **A status bar pinned at the top:** character, HP and AC, carried gold, room, wallet, block, account.
- **One scrolling transcript below it,** saved on the device across reloads (the last 2,500 entries per account). Each turn appends rather than redraws: the room in full when you arrive, then only what changed (monster HP, who's here, other players' actions inline), and the numbered menu. Answered or outdated menus go grey and stop responding.
- **A prompt at the bottom,** for numbers and commands: `look`, `sheet`, `map`, `feed`, `verify`, `switch`, `account`, `export`, `signout`, `clear`, `help`. Clicking an option in the newest menu works too.
- **Live updates:** every block, others' actions print inline and the status bar updates. If your choices change (a monster dies, someone arrives), the room reprints with a fresh menu.

The status bar, transcript and prompt share one column, centered and 100 characters wide by default. `width <60–200|full>` and `align left|center` adjust it, remembered per device. At 1600px wide: an 888px column centered; `width 80` gives 707px.

The character sheet, map and feed moved from side panels into commands. Library, sign-in, signing and verification are unchanged.

**Checked in the built-in browser:**
- the scrollback survived reloads, and its menus came back grey;
- picked Wren and ran `map`, which printed inline;
- attacked skeleton #2: sealed at block 2008, resolved at 2009, a hit for 6 that killed it, and the next menu dropped that skeleton's options;
- the inline `verify ▸` link and `help` both print into the transcript;
- the status bar stays on one line at desktop width and wraps to three short lines on a phone;
- no sideways scroll at 375px.

Client checks pass 13/13, and the production bundle is 70 KB gzipped.

