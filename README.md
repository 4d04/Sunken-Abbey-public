# The Drowned Abbey

A text-based, D&D-style dungeon crawl that runs on a Canopy nested chain. One shared dungeon level, dice from chain randomness (commit-reveal plus a block beacon), items, and gold as the chain's native token.

The design is in [SPEC.md](SPEC.md). Milestones are in §10: M0 (spike), M1 (rules engine), M2 (plugin) and M3 (client) are done; M4 is multiplayer and seasons.

| Path | What it is |
|---|---|
| [`rules/`](rules) | `@abbey/rules`: the pure TypeScript rules engine, level 1 content, linter and balance simulator. See [M1-REPORT.md](rules/M1-REPORT.md) |
| [`plugin/`](plugin) | The Canopy state-machine plugin: transactions, commit-reveal, treasury, EndBlock sweeps, read-only RPC. See [README.md](plugin/README.md) and [M2-REPORT.md](plugin/M2-REPORT.md) |
| [`client/`](client) | `@abbey/client`: the chain library (keys, signing, commit-reveal, verification), the browser client (passkey sign-in) and the terminal UI. See [README.md](client/README.md) and [M3-REPORT.md](client/M3-REPORT.md) |
| [`spike/`](spike) | Localnet scripts, the test and load clients, and the M0 spike. See [M0-REPORT.md](spike/M0-REPORT.md) |

## Quick start

Tests (Node 26):

```bash
cd rules && npm install && npm run check
```

```bash
cd plugin && npm install && npm test
```

Play (with the localnet running), in a browser at http://localhost:5173:

```bash
cd client && npm install && npm run web
```

Or in a terminal:

```bash
cd client && npm run play
```

Localnet: build the Canopy core at the pinned commit (needs Go), then follow "Re-run" in [plugin/M2-REPORT.md](plugin/M2-REPORT.md).
- **One chain.** The game chain (id 2, `spike/data-nested`) is its own root, so there's no root chain to run. `spike/data-root` is no longer used, and the two-chain state is parked in `data-nested/canopy.two-chain`.
- **500ms blocks**, from an unmerged Canopy PR; see [spike/FAST-BLOCKS-REPORT.md](spike/FAST-BLOCKS-REPORT.md).
- **One local core patch.** `setup.sh` applies `spike/plugin-socket-dir.patch`, which moves the plugin socket under the node's data dir, so another project's plugin chain can run on the same machine.

```bash
spike/setup.sh
```
