# @abbey/client

The Drowned Abbey client: a chain library, with a terminal UI and a browser UI built on it.

## Play

Start the localnet first ("Re-run" in [plugin/M2-REPORT.md](../plugin/M2-REPORT.md)), then:

```bash
cd client && npm install && npm run play
```

There are no prompts to get started. The first run creates a profile in `~/.abbey/default` holding a fresh BLS key. The key is encrypted under a strong random passphrase, which is remembered in the macOS Keychain (or the Linux keyring, or an owner-only file where there's no keyring). It unlocks automatically after that. The client claims from the free faucet if your wallet is empty. Every move is signed in the background, with no approvals.

| Flag | What it does |
|---|---|
| `npm run play -- --export-key` | Prints the private key, for backup. The Keychain holds the only copy of a generated passphrase, so this is how you keep the account |
| `npm run play -- --import-key` | Creates a profile from a backed-up key |
| `npm run play -- --forget` | Stops remembering the passphrase (asks first) |

A profile made with your own passphrase (for example via `ABBEY_PASSPHRASE`) asks for it once, then offers to remember it.

From there:
- Create a character. The stat roll is sealed on chain before the dice exist.
- Enter the abbey and pick numbered options. Each shows its odds, and 🎲 marks the ones that roll dice.
- `m` shows the map, `c` the character sheet, `v` verifies the last roll, `x` switches character.
- Back at the Lychgate, extract to bank your carried gold.

| Env | Default | Meaning |
|---|---|---|
| `ABBEY_PROFILE` | `default` | Profile name: one key and its sealed rolls |
| `ABBEY_HOME` | `~/.abbey` | Where profiles live |
| `ABBEY_PASSPHRASE` | (remembered) | Sets or supplies the passphrase directly; for scripts |
| `ABBEY_KEYCHAIN` | best available | `mac`, `secret-service` or `file`: where the passphrase is remembered |
| `ABBEY_RPC`, `ABBEY_PLUGIN_RPC`, `ABBEY_CHAIN_ID` | `127.0.0.1:30002`, `127.0.0.1:50010`, `2` | Which node and chain |
| `NO_COLOR`, `ABBEY_NO_ANIM` | | Plain output; no dice animation |

Piped stdin works too: each line answers one prompt.

## Play in a browser

With the localnet running:

```bash
cd client && npm install && npm run web
```

Then open http://localhost:5173. It looks and plays like a terminal:
- **A status bar pinned at the top:** your character, HP, AC, carried gold, room, wallet, block, and the account button.
- **One scrolling transcript below it.** Each turn appends: the room when you arrive, the numbered options, your choice, the sealed roll, the dice landing, and the narration. Other players' actions print inline as they happen (`» Bram: attack skeleton #2 (hit)`). Scroll up to read back; the history is kept on this device across reloads.
- **A prompt at the bottom.** Type a number, or click an option in the newest menu (older menus go grey). Commands print into the transcript: `look`, `sheet`, `map`, `feed`, `verify`, `faucet` (claim free gold, within the chain's faucet limits), `math on|off` (show or hide the dice and arithmetic), `switch`, `account`, `export`, `signout`, `clear`, and `help`.
- **Each round reads as a beat of the fight** (patterns from MUDs and roguelikes): one progress line that becomes the roll's record and verify link; the dice on one line; then the story ("You swing your longsword at the Skeleton and maul it (8). The Skeleton's rusted blade swings at you and misses."), with damage verbs scaled to the blow; the round's arithmetic on one quiet `∑` line; and a status strip (`⚔ round 2 · Skeleton #3 badly wounded 5/13 · you 26/26`) instead of reprinting the room. The room is described in full on arrival, "Also here" only when it changes, and a fight ends with a summary.
- **The story stands out; the math stays legible.** Story lines are typed out in a warm colour. Rolls (the dice and the arithmetic) appear at once, small and grey, with only the outcome word coloured: green when it's good for you, red when it's bad. Effects (damage, healing, gold) are coloured the same way.
- **A centered column,** 100 characters wide by default. `width 80` (60–200, or `width full`) and `align left` / `align center` adjust it, and the device remembers your choice.

To sign in, choose **Create an account with a passkey** or **Sign in with a passkey**: your account key is derived from the passkey, so Face ID or Touch ID signs you in on any device your passkeys sync to. **Play on this device only** skips the passkey, for browsers without PRF support. The device remembers you until `signout`. Every move is signed in the page with no prompts.

Point the page at another node with `?rpc=…&plugin=…&chain=…`. `npm run build:web` builds a static copy into `dist-web/`.

| Web module (`src/web`) | What it does |
|---|---|
| `passkey.ts` | Passkey create and sign-in with the PRF extension; `keyFromPrf` derives the BLS key with HKDF (pinned by a test) |
| `device.ts` | IndexedDB storage for the remembered account and the roll secrets, encrypted with a non-extractable WebCrypto key |
| `terminal.ts` | The terminal: a transcript kept across reloads, numbered menus that go grey once answered, the prompt and its commands, typed narration and dice |
| `main.ts` | The game in that terminal: sign-in, characters, camp, rooms, rolls and verification, the live feed, and the status bar |

## Library (`src/lib`)

| Module | What it does |
|---|---|
| `net.ts` | Core and plugin RPC, BLS signing (proto3 defaults omitted so signatures match the core), event decoding |
| `vault.ts` | Key file and per-roll secrets, encrypted with scrypt and AES-256-GCM, files owner-only. A secret is written **before** its commit is sent |
| `keychain.ts` | Where the vault's passphrase is remembered: the macOS Keychain, the Secret Service, or a file |
| `session.ts` | Every message as one call that returns once its effect is in **committed plugin state** (checked every `pollMs`: 1s by default, 300ms in the browser for 500ms blocks). Dice actions commit, then reveal automatically. "Block is full" is resubmitted with a jittered back-off. `resumePending()` reveals rolls sealed by a session that crashed |
| `verify.ts` | Recomputes a roll: commitment, beacon, and every die from the seed. Forfeits are checked against the forfeit rule |
| `narrate.ts` | Engine events to text, from the level's text pack |
| `feed.ts`, `map.ts`, `stats.ts` | The feed's lines, the map model, and stat assignment, shared by both front ends |
| `proto.js` | The plugin's messages as an ES module (`npm run build:proto`), so Node and browsers encode identically |

Two rules the M2 load tests taught (findings 8–9):
- Never confirm from tx-by-hash, because it reports mempool txs as committed. Confirm from state.
- Back off rather than resubmitting into a full block.

## Tests

```bash
npm run check
```

That's the typecheck plus 13 unit tests: vault, verification and its failure modes, encoding, event decoding, narration, map, the passphrase file store, passkey key derivation, and `send` treating an already-landed attempt as done. No chain is needed. `ABBEY_TEST_KEYCHAIN=1` adds a real macOS Keychain round-trip, which writes one item and removes it.

```bash
npm run smoke
```

That's the end-to-end run against a localnet: two players, creation, a move, combat, crash recovery, verification of every roll, the feed and extraction.
