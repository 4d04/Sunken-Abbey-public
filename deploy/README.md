# Deploying the playtest server

> **Status 2026-11-24: the Abbey is not running on this server.** It was stopped and its chain data (and the 500ms rollback
> copies) deleted on 2026-11-19 to make room for other projects. Still there: `/opt/abbey`
> (keys, code), `/srv/abbey`, the `abbey-game` / `abbey-root` units (disabled) and the `abbey.skylabs.ventures` block in the
> Caddyfile, so the page loads but its RPC routes answer 502. To bring it back, start a fresh chain (below) on this server or
> another one. The daily `panic: pebble: closed` crashes the 200ms node had on 2026-11-15..18 were a race in the core,
> now patched (`spike/max-block-size-lock.patch`, see `spike/FAST-BLOCKS-REPORT.md`): build the server's node with it,
> e.g. `git apply` both `spike/*.patch` files in `/opt/abbey/canopy` before `go build`.

The public playtest ran at **https://abbey.skylabs.ventures**, on one Ubuntu 26.04 server (`ssh root@<server>`).
From 2026-11-12 it ran one chain: game chain 2 as its own root, with the abbey plugin, one validator and **200ms blocks** (`BLOCK_MS = 200` in `rules/src/timing.ts`; the node's `roundRobinBlockIntervalMS` 200 and `blockConsensusLeadTimeMS` 50). The old two-chain, 500ms state is kept on the server for rollback (below).

## What runs where

| Piece | Where | Notes |
|---|---|---|
| Canopy node | `/opt/abbey/bin/canopy`, built on the server from `/opt/abbey/canopy` @ `4313b031` (canopy#648, fast blocks) | It needs cgo (blst), so build it on the server, not cross-compiled |
| Game chain 2 and plugin | `abbey-game.service`, data in `/opt/abbey/data/nested` | Its own root, 200ms blocks, RPC 127.0.0.1:30002, plugin RPC 127.0.0.1:50010 |
| Old root chain 1 | `abbey-root.service` (disabled), data in `/opt/abbey/data/root` | Only needed to roll back to the 500ms chain |
| Game code | `/opt/abbey/app/{rules,plugin,spike/client}` | `canopy/plugin/abbey` is a symlink to `app/plugin` |
| Web client | `/srv/abbey` (the `client/dist-web` build) | |
| Caddy | `/etc/caddy/Caddyfile` (a copy of `deploy/Caddyfile`) | The only public listener: HTTPS, plus an allowlist of six core RPC routes and `GET /abbey/*` |
| Secrets | `/opt/abbey/.password` (keystore), `/opt/abbey/app/spike/client/.m2-authority.json` (set_params key), `/opt/abbey/abbey.env` (its address) | All were made on the server and never leave it |

Every node port binds to 127.0.0.1. The ufw firewall allows only 22, 80 and 443, SSH accepts keys only, and fail2ban is on.

## Ship a client change

```bash
cd client && npm run build:web
rsync -a --delete client/dist-web/ root@<server>:/srv/abbey/
```

## Ship a rules or plugin change

Every validator must run the same rules. On a one-validator playtest, that means restarting the game chain.

```bash
(cd rules && npm run build) && (cd plugin && npm run build)
rsync -a --delete rules/package.json rules/package-lock.json rules/dist root@<server>:/opt/abbey/app/rules/
rsync -a --delete --exclude node_modules --exclude test --exclude bench plugin/ root@<server>:/opt/abbey/app/plugin/
ssh root@<server> 'chown -R abbey:abbey /opt/abbey/app && cd /opt/abbey/app/plugin && sudo -u abbey -H env PATH=/opt/node/bin:/usr/bin:/bin npm ci --omit=dev --loglevel=error && systemctl restart abbey-game'
```

A change that alters past state transitions needs a fresh chain, or an activation height (SPEC §6.8).

## Change params (the faucet, fees, caps)

```bash
ssh root@<server> 'cd /opt/abbey/app/spike/client && sudo -u abbey -H env PATH=/opt/node/bin:/usr/bin:/bin PORT=300 CHAIN_ID=2 npx tsx src/set-params.ts "{\"faucetMaxPerBlock\":10}"'
```

The faucet is currently set to 100 GOLD per claim, a 1-hour cooldown (18,000 blocks at 200ms), at most 1,000 GOLD per account, and 4 claims per block (about 20 a second). Block-counted params must be converted when the block time changes. A fresh chain starts with the defaults, so re-apply these after any reset.

## Look at it

```bash
ssh root@<server> 'systemctl status abbey-game caddy --no-pager | grep -E "●|Active"'
ssh root@<server> 'grep -ciE "round [0-9]+ (failed|deadline)" /opt/abbey/data/nested/logs/log'  # missed 200ms slots
ssh root@<server> 'tail -n 50 /opt/abbey/data/nested/logs/log'
```

## Start over on a fresh chain

Starting over wipes every character. Passkeys survive, because they belong to the domain, not the chain.

```bash
ssh root@<server> 'systemctl stop abbey-game && rm -rf /opt/abbey/data/nested/canopy /opt/abbey/data/nested/logs && systemctl start abbey-game'
```

Then re-apply the faucet params (above). `make-chains.py` rebuilds the configs and genesis from a first-boot root data dir, and `single-chain.py` (copied to `/opt/abbey/deploy/`) makes chain 2 its own root; they're only needed again for new keys.

## Disk

The node keeps every block and Canopy has no pruning setting. At 200ms expect roughly 2 GB a day with players (about 0.9 GB a day at 500ms on two chains), against about 29 GB free on 2026-11-12. Watch `du -sh /opt/abbey/data/nested/canopy` and either grow the disk or reset the chain (each season, say) before it fills.

## Testnet: nested under Canopy's root

The plan for testnet (`spike/HYBRID-REPORT.md`): the game chain runs **nested under Canopy testnet's root chain, on our own
core** (canopy#648's fast mode rebased onto upstream, plus our two patches), so we deploy it ourselves rather than through
Canopy's graduation pipeline, which runs stock Canopy. GOLD is funded as on the playtest: 400M treasury and 50M faucet in
the game chain's genesis. Prod tokenomics and liquidity are still open.

**Needed first, from the Canopy devs:** testnet root's RPC URL, its network id, the game's chain id, and the root's
`certificateResultsFee` (at 200ms the game sends the root 5 results transactions a second). And testnet CNPY to stake.

On the server (the same layout as above, with `/opt/abbey/data/testnet` beside the playtest's data):

```bash
# 1. the core: upstream 1c37b13e + spike/fast-mode-on-upstream.patch + both local patches (spike/setup-hybrid.sh does this)
rsync -a spike/setup-hybrid.sh spike/*.patch root@<server>:/opt/abbey/app/spike/
ssh root@<server> 'cd /opt/abbey/app/spike && ln -sfn /opt/abbey/canopy canopy && ./setup-hybrid.sh \
  && install -o abbey -g abbey bin/canopy-hybrid /opt/abbey/bin/canopy-hybrid && ln -sfn /opt/abbey/app/spike/canopy-hybrid /opt/abbey/canopy-hybrid'
# 2. a first boot makes the node's keys, config and genesis; stop it, drop its state, then configure for testnet
ssh root@<server> 'D=/opt/abbey/data/testnet; sudo -u abbey mkdir -p $D && cd /opt/abbey/canopy-hybrid \
  && sudo -u abbey timeout 20 /opt/abbey/bin/canopy-hybrid --data-dir $D --password "$(cat /opt/abbey/.password)" start; \
  rm -rf $D/canopy $D/logs'
scp deploy/testnet-chain.py root@<server>:/opt/abbey/deploy/
ssh root@<server> 'sudo -u abbey python3 /opt/abbey/deploy/testnet-chain.py /opt/abbey/data/testnet \
  --root-url <testnet root RPC> --chain-id <id> --network-id <id>'
```

It prints the validator's address, public key and net address. **Stake that validator on the testnet root for committee
`<id>`** (with testnet CNPY: that's a real transaction, so it waits for whoever holds the funds). Then:

```bash
# 3. the service: set ABBEY_CHAIN_ID to the chain id, and stop the playtest chain (both plugins need port 50010)
sed 's/CHAIN_ID_HERE/<id>/' deploy/abbey-testnet.service | ssh root@<server> 'cat > /etc/systemd/system/abbey-testnet.service'
ssh root@<server> 'systemctl disable --now abbey-game; systemctl daemon-reload && systemctl enable --now abbey-testnet'
# 4. the web client for that chain (the proxy and RPC port 30002 are unchanged)
(cd client && ABBEY_CHAIN_ID=<id> ABBEY_NETWORK_ID=<id> npm run build:web) && rsync -a --delete client/dist-web/ root@<server>:/srv/abbey/
```

Check it: `curl -s -X POST https://abbey.skylabs.ventures/v1/query/height` advancing. "not subscribed" (Code 34) in the
log means the root doesn't have the stake yet. The params tool needs the chain's ids too: `PORT=300 CHAIN_ID=<id> NETWORK_ID=<id>`.

Rehearsed locally on 2026-11-25 against a stand-in root (`testnet-chain.py` gave the same config and genesis as the
rehearsal's game chain, apart from paths; 200ms blocks, smoke 13/13). Not rehearsed: a root over the internet.

## The move to one chain at 200ms (done 2026-11-12)

What changed: `single-chain.py /opt/abbey/data/nested 2 300`, the interval and lead time above, rules and plugin with `BLOCK_MS = 200`, `abbey-game.service` without the root chain, `abbey-root` disabled, faucet params converted, a fresh chain. Measured after: 5.0 blocks/s, the game node at about 49% of one core (the old root chain alone used 61–72% for its VDF), no missed slots in the first 939 blocks, and a roll resolving 1.3s after the click in the browser (about 2.5s before).

**Roll back** to the 500ms two-chain state (characters as they were before the move):

```bash
ssh root@<server> 'set -e; B=500ms-2026-11-12; N=/opt/abbey/data/nested
systemctl stop abbey-game
mv $N/canopy $N/canopy.200ms-$(date +%s); mv $N/logs $N/logs.200ms-$(date +%s)
mv $N/canopy.$B $N/canopy; mv $N/logs.$B $N/logs
cp -a $N/config.json.$B $N/config.json; cp -a $N/genesis.json.$B $N/genesis.json
rsync -a --delete /opt/abbey/app.$B/ /opt/abbey/app/; rsync -a --delete /srv/abbey.$B/ /srv/abbey/
cp -a /opt/abbey/deploy/abbey-game.service.$B /etc/systemd/system/abbey-game.service
systemctl daemon-reload; systemctl enable --now abbey-root; sleep 10; systemctl start abbey-game'
```

The client in the repo is built for 200ms; a rollback also needs `BLOCK_MS = 500` and a rebuild before the next deploy. Once the 200ms chain has proven itself, the `*.500ms-2026-11-12` copies and `/opt/abbey/data/root` can be deleted.
