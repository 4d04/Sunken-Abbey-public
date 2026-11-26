# Fast blocks: canopy-network/canopy#648 on our nested localnet

**Date:** 2026-11-05 · **Core:** canopy `4313b031`, the head of [canopy-network/canopy#648](https://github.com/canopy-network/canopy/pull/648) ("Add fast deterministic BFT mode"), built with Go 1.26.0. The PR is open, unmerged and unreviewed. · **Plugin and client:** unchanged, apart from the client's polling interval.

## Verdict

**The development localnet now runs the PR's fast mode by default: the nested game chain makes a block every 500ms** (the root chain stays at 6s).
- Everything works: rules 67/67, plugin 39/39, client 13/13, the client smoke test 11/11, the M2 end-to-end script 20/20.
- **A dice move takes about 2 seconds** from click to result, against about 12 on 6s blocks.
- **Under saturating load:**
  - about 70–80 game transactions per second on one Mac;
  - no failed consensus rounds;
  - blocks stretch from 0.5s to 1–2s instead of wedging.

**Not done yet:**
- ~~Every game timer still counts blocks.~~ **Re-tuned:** the timers are written in seconds and keep their intended lengths, and the balance is unchanged (see "Timers" below).
- **Predictable proposers make it easier for a player and a validator to collude on rolls.** Only the core can fix that (see "The dice beacon" below). It doesn't matter on a single-validator localnet.
- **This is unreleased core code.** Production would mean running a fork until the PR is merged and released, and every validator opting in.

## What the PR changes (that matters to us)

1. **Proposals are built from a block-sized, fee-ordered slice of the mempool.** Failed txs are evicted, the slice is refilled, and a build can be cancelled to give consensus priority. Before, every build applied the whole mempool. That's what wedged our chain under overload (M2 finding 9, and issue 1 in `plugin/UPSTREAM-NOTES.md`). As far as the diff shows, this applies in every mode.
2. **An opt-in `stakeWeightedRoundRobin` mode with 500ms pacing.** The proposer of each height comes from a fixed schedule (a hash of network id, chain id and view), not a VRF draw, and the VDF is off.
3. **Root-block round resets** (issue 2) still happen, but a fast round lasts about 500ms, so a 6s root block rarely interrupts one.

## Setup

- **`spike/setup.sh`** builds `4313b031` by default (it fetches `pull/648/head` when needed). `CANOPY_COMMIT=83af2a0c spike/setup.sh` builds the core that M0–M3 were measured on.
- **Go version:** the build is pinned to Go 1.26.0 (`GOTOOLCHAIN=go1.26.0`), because a newer Go breaks a dependency (`cockroachdb/swiss`). That already affected the old pin on this machine's default Go 1.27.3.
- **`localnet.sh configure fast`** writes the PR's settings: `proposerMode: stakeWeightedRoundRobin`, 500ms pacing, and its timeouts. `configure 6s` writes the classic VRF mode. The committed configs are the root chain at `6s` and the nested chain at `fast`.
- **`localnet.sh`** takes `BIN` and `CANOPY_DIR` to run another core build.
- **The chain from before this change** is parked in `data-*/canopy.baseline`, so the project owner's earlier characters aren't lost.

## Measurements

**Idle:** 10 blocks per 5 seconds, steady.

**Dice-move latency, one player:** median **2.07s**, range 1.8–2.1s. It's the same whether the client checks every 1s or every 250ms. The time goes into block cadence: the commit lands, the client sees it, the reveal lands, the client sees it. About one reveal in four landed two blocks after its commit instead of one. On 6s blocks the same move took about 12–14s.

**Capacity.** Earlier generators were measuring themselves, not the chain:
- A BLS signature takes **19ms** in JavaScript (@noble/curves), so one generator process signs at most about 50 transactions a second. Every single-process run topped out there.
- Polling plugin state for each player (600 players × every 300ms) overloaded the plugin's read endpoint (connection resets). That's the read-replica lesson from the spec: player reads must stay off the process that executes transactions.
- A block's events are indexed a moment after the height moves past it, so an event watcher has to trail the tip by a couple of blocks.

`spike/client/src/m2-load-events.ts` fixes these. One watcher per process reads each block's events once and wakes the waiting players; a tx unseen within 6 blocks is resubmitted (duplicates fail harmlessly); and 8 processes run in parallel. Results with 600 players (8 processes × 75), all on one 10-core Mac alongside both nodes and the plugin:

| Cap (`maxTxPerBlock`) | Included tx/s | Txs per block (mean / p95) | Block time (p50 / p95 / max) | Failed rounds | Proposal build (p50 / p90 / p99) |
|---|---|---|---|---|---|
| 150 | **70–80** | 67 / 150 | 0.5 / 2.0 / 3.5s | 0 | 0.02 / 0.24 / 0.73s |
| 60 | ~50 | 40 / 60 | 1.0 / 1.0 / 1.5s | 0 | |

- **Saturated, the chain slows rather than stalls.** A slow build makes that block late; the round doesn't fail, and nothing wedges.
- **A smaller cap doesn't keep blocks at 500ms.** Blocks still slowed to about 1s and throughput fell, because more "block is full" rejections mean more resubmissions, and the plugin checks each one. The limit on this machine is the plugin process's total work: admission checks (CheckTx), execution, and reads, all in one single-threaded Node process.
- **So the cap stays at 150 for now.** For comparison, the 6s chain's most at cap 150 is 25 tx/s. Fast mode at least triples throughput.
- **These numbers are a floor.** Generators, nodes and plugin share one machine; a validator on its own hardware would do better.

**Also seen:** under load the node evicted ~1,700–2,100 reveals per run as "roll already resolved". A single client produces none, and the duplicates trace to the load generator resubmitting after its own deadline, so they're a test artifact. The clients confirm from state, so these evictions cost only wasted checks.

## Timers: what fast blocks change in the game

Every game timer counts blocks, so at 500ms each runs 12× faster in real time:

| Timer | Blocks | On 6s blocks | On 500ms blocks |
|---|---|---|---|
| Reveal window (R) | 10 | ~1 min | **5 s.** Stat rolls in the first load runs were forfeited when setup took longer than that |
| Downed, before the Ferryman | 20 | 2 min | 10 s |
| Lying low (§3.3) | 20 | 2 min | 10 s |
| Ferryman toll: "recently active" | 100 | 10 min | 50 s |
| Bell before the flood | 100 | 10 min | 50 s |
| Abbot recovers if unfought | 20 | 2 min | 10 s |
| Beacons and resolved rolls kept | 1,000 | ~1.7 h | ~8 min |
| Faucet cooldown (a param) | per params | | 12× shorter |

**Re-tuned (same day):**
- The timers are now written in seconds in `rules/src/timing.ts`, the level content (`season`: `capSeconds`, `resetAfterBossSeconds`, `bellWarningSeconds`) and the Abbot's `recovers.afterSeconds`. One constant, `BLOCK_MS = 500`, converts them to blocks, so the real-time windows are back to their intended lengths: reveal 60s (120 blocks), downed 2 min, lying low 2 min, Ferryman "active" 10 min, bell 10 min, season 30 min after the boss or ~3.5 days, history 100 min.
- The Abbot's recovery depends on the players' pace, not the chain's: on 500ms blocks the time between a player's moves is mostly thinking. The balance sim now takes a round length (`SIM_ROUND_SECONDS`, default 12, the M1 pace).
  - At 2 minutes, solo boss kills rose from 26.5% to 38–40% at 4–6s per round: a solo player could retreat and return before he healed.
  - At **60 seconds**, every pace from 4 to 12s per round reproduces M1 exactly: solo 26.5%, party of 3 67.5%, 141g.
- The golden replay is unchanged except for the level's content hash.
- Both clients show the Ferryman's countdown in seconds and take lying low from the rules.
- Tests: rules 67/67, plugin 39/39, client 13/13, smoke 11/11, and end-to-end 20/20 (a roll forfeited exactly at its 120-block expiry) on a fresh fast chain. The previous fast chain is parked as `data-*/canopy.fast-trial`.

## The dice beacon under predictable proposers

A roll's seed is `sha256(secret ‖ beacon_h ‖ rollId)`. The player seals `secret` before block *h* exists, and `beacon_h` folds in the hashes of block *h*'s game txs.
- **On their own, neither side can steer a roll.** The player can't pick a secret against a beacon that doesn't exist yet, and the proposer of *h* never sees the secret.
- **The one attack is collusion.** The player hands the secret to the proposer, who tries candidate tx sets until the beacon gives a good roll.
- **The schedule matters.** SPEC §7.3 assumed proposers are elected unpredictably (VRF), so a cheat would have to bribe whoever wins. In this mode the proposer of every height is known in advance, so a cheat can time a commit for a friendly validator's block.

**Seeding from a later block doesn't help** (this report's first draft suggested it). The proposer of block *h+1* can tune `beacon_{h+1}` exactly as the proposer of *h* tunes `beacon_h`, so the cheat just befriends that proposer instead. Any beacon a single proposer influences through its choice of txs has this problem.

**The fix needs the core:** per-block randomness the proposer can't vary. The standard construction is a chain of BLS signatures (as in drand and DFINITY): each block's randomness is the proposer's BLS signature over the previous randomness. A BLS signature is unique for a key and message, so the proposer's only move is to withhold the block, which costs its slot and is visible. Canopy validators already sign with BLS keys, but plugins receive neither signatures nor VRF output. This is item 4 in `plugin/UPSTREAM-NOTES.md`.

**Until then:** nothing changes in the code. On a single-validator localnet with worthless gold the attack doesn't exist. Before others run validators with real value, either the core provides this randomness, or the risk is accepted with monitoring: flag players and proposers whose rolls are statistically too lucky.

## A consensus race: `panic: pebble: closed` (found 2026-11-24, patched locally)

**Symptom.** The public playtest node at 200ms blocks crashed about once a day (2026-11-15, 16, 17 and 18), always with
the same trace: the consensus loop checks a proposal (`bft.CheckProposerMessage`), reads the max block size from FSM
state (`Controller.LoadMaxBlockSize` → `GetParamsCons`), and the store's pebble snapshot is already closed. systemd
restarted it each time.

**Cause.** `bft/msg.go` reads `LoadMaxBlockSize()` without the controller lock, while every other FSM read around it
takes it. Meanwhile `Store.Reset()` (`store/store.go`), run under that lock on a block commit and on every round reset
(`RoundInterrupt` → `ResetFSM`), swaps the store's snapshot and closes the old one. If the two overlap, the read lands on
the closed snapshot. Shorter blocks mean more commits and more round resets (every missed 200ms slot is one), so the
window comes up more often: rarely at 500ms, daily at 200ms with players.

**Proof.** A `go build -race` node on the localnet at 200ms, under the client smoke test: 29 of 39 race reports were this
exact pair (`LoadMaxBlockSize` read vs `Store.Reset` write). With the patch, under the same load and 241 round resets:
none. The remaining reports are a gossip-mode flag in p2p (benign) and an RPC query reading state mid-swap (an HTTP
handler: a failed query at worst, not a node crash).

**Fix.** `spike/max-block-size-lock.patch`: take the controller lock around that one read, as the `LoadCommittee` call
two lines above already does. The other caller (`handlePeerBlock`) already runs under the lock, so this can't deadlock;
`go test ./bft/` passes. `spike/setup.sh` applies it. It belongs upstream in canopy-network/canopy#648.

## Re-run

```bash
spike/setup.sh
```

Then start the localnet as in `plugin/M2-REPORT.md` ("Re-run"). The committed configs already select fast mode for the nested chain. Load test:

```bash
cd spike/client && for i in 1 2 3 4 5 6 7 8; do PORT=300 CHAIN_ID=2 PLAYERS=75 DURATION_S=60 npx tsx src/m2-load-events.ts & done; wait
```
