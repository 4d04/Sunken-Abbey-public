# M0 Spike Report — The Drowned Abbey

**Date:** 2026-11-04 · **Core:** `canopy-network/canopy` @ `83af2a0` (built with Go 1.26.0) · **Plugin:** TypeScript template, copied to `abbey-plugin/` · **Host:** macOS arm64, all nodes on loopback

## Verdict

**Every M0 exit criterion in SPEC §10 was met on a local nested-chain setup.** There's one caveat: this was a single-validator committee on one machine, so it says nothing about network latency between validators.

| Exit criterion | Result |
|---|---|
| Nested-chain localnet with the TS plugin | ✅ Root chain 1 (no plugin) + nested chain 2 (abbey plugin). The root chain receives a `certificateResults` tx from the committee-2 validator every block |
| Async EndBlock with state I/O | ✅ The core already supports it. The template needed a 3-line change (`await ContractAsync.EndBlock`). Beacon reads/writes, expiry range-reads, and pruning run in every EndBlock |
| 6s blocks sustained under synthetic load | ✅ 5.97–6.01s mean, ≤6.74s max, at up to 200 tx/block (table below) |
| Treasury account transfers from the plugin | ✅ The keyless treasury account (`sha256("abbey.treasury.v1")[:20]`) pays out; the balances match exactly |
| Plugin-side fee collection, incl. zero-fee `faucet_claim` | ✅ A brand-new account with 0 balance claimed 100 GOLD with fee 0. Paid messages charge exactly the fee, and messages below the floor are rejected in CheckTx |
| `send` removed from plugin, core `send` still works | ✅ |

Functional suite (`client/src/m0.ts`): **11/11 passing on both the single-node chain and the nested chain.**

## Measurements

| Scenario | Tx/block (max) | Block interval mean / p50 / p95 / max | Rolls | Failures | Click → result p50 / p95 |
|---|---|---|---|---|---|
| Single node, stock plugin, idle | 0 | 6.0s | — | — | — |
| Single node, 50 players, 5 min | 50 | 6.01 / 6.01 / 6.10 / 6.10s | 1,250 | 0 | 12.0 / 12.4s |
| Single node, 200 players, 3 min | 200 | 5.98 / 6.05 / 6.33 / 6.74s | 1,816 | 0 | 22.4 / 25.6s ⚠ |
| Nested chain, 100 players, 3 min | 100 | 5.97 / 6.01 / 6.24 / 6.33s | 1,271 | 0 | 12.3 / 24.0s ⚠ |
| Root chain during the nested load | — | 6.01 / — / 6.02 / 6.02s | — | — | — |
| Nested chain (6s config) under a **20s root** | 0 | 6.67 / 6.01 / — / 8.09s | — | — | — |

⚠ The chain kept 6s blocks in these runs. The extra latency came from the test harness, which caps itself at 32 in-flight HTTP requests and polls each tx once per second, so reveals often slipped one block. A real client should subscribe to events rather than poll (see finding 8).

**Action latency at light load is ~10–12s from click to result**: the commit lands in block *h*, the reveal in *h+1*, and the d20 matches the client's own recomputation every time. This matches the spec's 6–12s estimate.

## Findings that change the spec or the build

1. **Zero-value protobuf fields break signatures.** protobufjs encodes explicitly-set zeros (`fee: 0`, `nonce: 0`), but Go omits them, so the signed bytes differ and the core rejects the tx with `invalid signature`. Clients must drop proto3 defaults before encoding (done in `client/src/chain.ts` `omitDefaults`). Check that `canopy-ts` does this before relying on it.
2. **`tx-by-hash` returns pending txs too**, stamped with the next height, and `/v1/query/height` also reports the next height. A tx only counts as committed once `tx.height < /query/height`. Without that check, the harness reported uncommitted txs as done.
3. **Fees on plugin messages are entirely the plugin's job.** The core neither checks nor deducts them. A `faucet_claim` sent with a 10,000 fee was accepted and the fee simply wasn't collected. The plugin must either reject a non-zero fee on free messages or charge it.
4. **Fees land in `pools[chainId]`, the committee reward pool**, which the core pays out to the committee in every EndBlock. So the pool always reads 0 between blocks, and that's expected.
5. **The template hard-codes `ChainId: 1`**, so its fee-pool key is wrong on a nested chain. The spike reads `ABBEY_CHAIN_ID` from the environment. The real plugin should take the chain ID from the node's config.
6. **One TS plugin per host, and a node doesn't survive its plugin.** `pluginctl.sh` uses host-global paths (`/tmp/plugin/plugin.sock`, `/tmp/plugin/typescript-plugin.pid`). Stopping one node's plugin killed the other node's plugin, and that node **exited** (`a plugin read failed with error: EOF`). It came back cleanly from its saved state on restart. Production nodes need a supervisor (systemd/k8s restart policy) and one plugin per machine or container.
7. **The default node config is unsafe for anything beyond a laptop.** `listenAddress` 0.0.0.0 also binds the RPC and **admin RPC** to all interfaces. Wallet and explorer bind all interfaces unless `headless`. `autoUpdate` is on (it downloads releases from GitHub), metrics bind 0.0.0.0, the template's plugin RPC binds 0.0.0.0:50010, and the keystore password can only be passed as a `--password` argument, which shows up in `ps`. `localnet.sh` locks all of this down, and the deployment runbook must do the same.
8. **A single node's RPC drops connections under bursts** (ECONNRESET at roughly 1k req/s from 200 polling clients), and the admin keystore endpoint gets slower as the keystore grows. The game client should batch requests and use a push channel (WebSocket or plugin event stream) instead of per-tx polling. Read traffic should go to non-validator RPC nodes.
9. **Root block time doesn't cap the nested chain.** With the root at 20s, the nested chain still made 6s blocks at the median, with occasional ~8s blocks (likely when it picks up a new root height). The spec's open question §12.1 is answered for one validator. Multi-validator behavior is still untested.
10. **Build gotcha:** Go 1.27 can't build the core (`cockroachdb/swiss` links runtime internals). Build with `GOTOOLCHAIN=go1.26.0`, which matches `go.mod` and the Dockerfile.
11. **The core docker localnet's nested node is stale.** `node-3` is commented out in `.docker/compose.yaml`, and its validator key doesn't match its own genesis. The working topology is the one in `localnet.sh` usage below: the root validator stakes for committees `[1, 2]`, and the nested node runs with the same validator key, `chainId: 2`, and `rootChain` URLs for both chains.

## Not covered by M0

- A multi-validator committee (consensus timing over a real network, non-signing at 6s).
- Determinism across two plugin processes replaying the same blocks (SPEC §9.5).
- Plugin events (`Event` protos) and the plugin's historical-height queries.
- The real Canopy root chain (mainnet or testnet) and real committee staking flows.
- Graduation (`rootChainID` switch), which SPEC §6.5 still needs to rehearse.

## What's in `spike/`

| Path | What it is |
|---|---|
| `localnet.sh` | Starts/stops one node: `DATA_DIR`, `PLUGIN`, `PORT` (500 = root, 300 = nested), `P2P_PORT`, `ABBEY_CHAIN_ID`; `init`, `configure 6s\|20s`, `start`, `stop`, `logs` |
| `abbey-plugin/` | Spike plugin: beacon (async EndBlock), commit/reveal d20, forfeit sweep, zero-fee faucet, treasury payout, read-only RPC on 127.0.0.1:50010 |
| `client/` | `src/m0.ts` functional suite, `src/load.ts` load test, `src/chain.ts` signing/submission client; `*.log` are this run's results |
| `canopy/` | Core checkout @ `83af2a0` (placeholder web assets; `plugin/abbey` symlinks to `abbey-plugin/`) |
| `bin/canopy` | Built core binary |
| `data-root/`, `data-nested/`, `data-single-node/` | Localnet state from this run (throwaway keys; `.localnet-password` is local-only) |

**Re-run the nested setup:**

```bash
cd spike
DATA_DIR=$PWD/data-root PLUGIN= ./localnet.sh configure 6s
DATA_DIR=$PWD/data-root PLUGIN= ./localnet.sh start
ABBEY_CHAIN_ID=2 DATA_DIR=$PWD/data-nested PLUGIN=abbey PORT=300 P2P_PORT=9002 ./localnet.sh start
cd client && PORT=300 CHAIN_ID=2 npx tsx src/m0.ts
PORT=300 CHAIN_ID=2 PLAYERS=100 DURATION_S=180 npx tsx src/load.ts
```

**The spike is not production code.** `spike_payout` lets anyone withdraw from the treasury. It exists only to prove the plugin can move native balances. Real payouts come only from game rules (SPEC §6.3).
