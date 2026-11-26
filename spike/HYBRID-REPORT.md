# The hybrid rehearsal: our fast core, nested under a Canopy root (2026-11-25)

**The game runs as a nested chain under a Canopy-style root, at 200ms blocks, on our own core.** It's built from current upstream
Canopy with the fast mode (canopy-network/canopy#648) rebased onto it, plus our two local patches. This rehearsed the
hybrid plan locally: keep our core changes, but adopt Canopy as the root chain. Smoke test 13/13, 40 players for 3 minutes
with no failures, and blocks held at 200ms. The cost to watch is on the root: **5 certificate-results transactions a
second**, about 100 in every root block.

## The setup

| | Root chain 1 (stands in for Canopy's) | Game chain 7 |
|---|---|---|
| Core | `bin/canopy-hybrid` | `bin/canopy-hybrid` |
| Blocks | Canopy's defaults: 20s, VRF proposers, VDF on | 200ms, fast mode (stake-weighted round robin) |
| Genesis | one validator, staked for committees `[1, 7]` | **no validators**: the committee is read from the root, as Canopy's graduation pipeline does it; `rootChainID` 1 |
| Ports | RPC 40002, P2P 9001 | RPC 41002, P2P 9007 (9000 + chain id, the pipeline's convention), plugin RPC 50010 |

- `spike/setup-hybrid.sh` builds the core: upstream `1c37b13e`, then `fast-mode-on-upstream.patch`, then
  `plugin-socket-dir.patch` and `max-block-size-lock.patch`. I checked that the three patches on a clean upstream give
  exactly the tree that was built and measured.
- `spike/hybrid-chains.py <root dir> <game dir> 7` writes both chains' configs and genesis from a first-boot root data dir
  (`localnet.sh init 20s`).
- The plugin runs with `ABBEY_CHAIN_ID=7`. Clients take `ABBEY_RPC=http://127.0.0.1:41002 ABBEY_CHAIN_ID=7`, or
  `PORT=410 CHAIN_ID=7` for `spike/client`.

## The rebase

Fast mode was two commits on an upstream commit 23 behind today's `main`. It rebased with one conflict: three expected
hashes in a test fixture (`fsm/state_test.go`, `TestApplyBlock`), updated to the new values. `go test` passes for
`./fsm ./bft ./controller ./lib`, and `./bft` passes again with our patches. Upstream's protocol change in those 23
commits is one governance message (`MessageChangeByzantineOutput`), which doesn't touch how a nested chain talks to its root.

## Measured

| | Result |
|---|---|
| Game chain from a validator-less genesis | **Works.** "Received root chain info with 1 validators … Self IS a validator", block 1 in under a second |
| Smoke test (`client`, `npm run smoke`) | **13/13 passed**: characters, moves, initiative, attacks, a crash-recovered reveal, 5 rolls verified |
| Load: 40 players, back-to-back rolls, 180s (`m2-load.ts`) | 899 blocks, **mean 0.20s, p95 0.20s, max 0.40s**; 4,187 rolls, 46 tx/s, **0 failures, 0 resubmits** |
| One player's roll, commit to resolved | **about 0.8s** (51 rolls in 40s, polling every 50ms) |
| Round resets on the game chain | about one per root block (20 in about 7 minutes); each costs one 200ms slot, since a fast round is short |
| Certificate results to the root | **1,753 sent, 0 failed. Every root block carried 98–101 transactions**, and the root's mempool stayed empty |
| Root block time under that load | 20.0s every block |
| CPU | game node about 20% of a core under load; the root about 120%, which is its VDF (Canopy's cost on the real root, not ours) |

## What it means for running under Canopy's root

1. **The certificate results are the real cost.** The validator that leads each game block sends a results transaction to
   the root (`controller/result.go`): 5 a second at 200ms, **about 432,000 a day**. Canopy's default
   `certificateResultsFee` is 0, and the stand-in root's was too. If Canopy's root charges a fee, it's paid on every game
   block. The root also checks each transaction's quorum certificate. The ways to cut this: 500ms blocks (2 a second), or
   send results every N blocks, which is one more core change in `result.go`.
2. **We deploy it ourselves.** Canopy's graduation pipeline runs stock Canopy, so a forked core means our own validator node,
   staked on Canopy's root for the game's chain id (which needs CNPY). That also skips the pipeline's token launch (the
   bonding curve, DEX pools and subsidy).
3. **The plugin needs nothing new for this.** It ran unchanged as chain 7 once `ABBEY_CHAIN_ID` was set.

## Not covered

- **A real network.** Here both chains ran on one machine, so the root RPC was one hop away. Over the internet, root-chain
  info arrives later, and results transactions travel further.
- **Long running.** About 20 minutes, not a day. The crash fix was proven separately (`FAST-BLOCKS-REPORT.md`).
- **More than one game validator.** The game chain had one validator, as at graduation.
- **The browser.** Roll timing came from the load script, not a click in the web client.
- **GOLD.** The treasury and faucet were funded in the game chain's genesis, as on `main`; how they get funded under
  Canopy's root is still open.
