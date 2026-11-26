#!/usr/bin/env python3
"""
Configure the game chain to run nested under Canopy testnet's root chain, on our own core (canopy#648's fast mode rebased
onto upstream, plus spike/*.patch: build it with spike/setup-hybrid.sh). This is spike/hybrid-chains.py's game chain,
pointed at a remote root instead of a local one. See deploy/README.md, "Testnet".

- 200ms round-robin blocks, no VDF, rootChainID 1 (Canopy's root)
- a VALIDATOR-LESS genesis: the committee comes from the root, where this node's validator must be staked for <chain id>
- the game's treasury (400M GOLD) and faucet (50M GOLD) funded in genesis, as on main (prod tokenomics are still open)
- every port on 127.0.0.1, RPC on <port block>02 (30002 by default, what the Caddyfile proxies), plugin RPC 50010.
  --p2p-host binds P2P publicly on 9000 + chain id, for when other validators join

Usage: testnet-chain.py <data dir> --root-url URL --chain-id N [--network-id N] [--port-block 300] [--p2p-host HOST]
  <data dir> must come from a first boot of the node there (config.json, genesis.json, keys), and the chain must start
  fresh afterwards: no <data dir>/canopy yet.
"""

import argparse
import hashlib
import json
import os

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("data")
ap.add_argument("--root-url", required=True, help="testnet root chain's RPC, e.g. https://<host>:50002")
ap.add_argument("--chain-id", type=int, required=True, help="the game's chain id (its committee id on the root)")
ap.add_argument("--network-id", type=int, default=1, help="testnet's network id (default 1)")
ap.add_argument("--port-block", default="300", help="node ports <block>00..03 (default 300: RPC 30002)")
ap.add_argument("--p2p-host", help="public host or IP to listen and advertise P2P on (default: loopback only)")
a = ap.parse_args()
assert a.chain_id > 1, "chain id 1 is the root"


def derive(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()[:40]


cfg_path, gen_path = os.path.join(a.data, "config.json"), os.path.join(a.data, "genesis.json")
assert not os.path.exists(os.path.join(a.data, "canopy")), f"{a.data}/canopy exists: move it aside, the chain starts fresh"
c, g = json.load(open(cfg_path)), json.load(open(gen_path))
assert g["validators"], "genesis.json has no validator to read this node's key from (is this a first-boot data dir?)"
v = g["validators"][0]
port, p2p = a.port_block, 9000 + a.chain_id

c.update({
    "chainId": a.chain_id,
    "networkID": a.network_id,
    "rootChain": [{"chainId": 1, "url": a.root_url}],
    "plugin": "abbey",
    "runVDF": False,
    "minimumPeersToStart": 0,
    "autoUpdate": False,
    "pluginAutoUpdate": {**c.get("pluginAutoUpdate", {}), "enabled": False},
    "dataDirPath": a.data, "backupDirectory": a.data + "/backup",
    "walletPort": f"{port}00", "explorerPort": f"{port}01", "rpcPort": f"{port}02", "adminPort": f"{port}03",
    "rpcURL": f"http://127.0.0.1:{port}02", "adminRPCUrl": f"http://127.0.0.1:{port}03",
    "listenAddress": f"{'0.0.0.0' if a.p2p_host else '127.0.0.1'}:{p2p}",
    "externalAddress": f"tcp://{a.p2p_host}:{p2p}" if a.p2p_host else "",
    "prometheusAddress": f"127.0.0.1:{p2p + 89}", "profilingPort": f"{p2p - 2940}",
    "metricsEnabled": False, "headless": True,
    # canopy-network/canopy#648 fast mode, as the 200ms chain runs it (rules BLOCK_MS = 200)
    "proposerMode": "stakeWeightedRoundRobin", "roundRobinBlockIntervalMS": 200,
    "blockConsensusLeadTimeMS": 50, "maximumFutureBlockTimeMS": 1000,
    "newHeightTimeoutMS": 500, "electionTimeoutMS": 100, "electionVoteTimeoutMS": 500, "proposeTimeoutMS": 500,
    "proposeVoteTimeoutMS": 500, "precommitTimeoutMS": 500, "precommitVoteTimeoutMS": 500, "commitTimeoutMS": 500,
    "roundInterruptTimeoutMS": 250,
})

g["validators"] = []  # validator-less: the committee is read from the root
g["params"]["consensus"]["rootChainID"] = 1
g["accounts"] = [
    {"address": v["address"], "amount": 1_000_000},
    {"address": derive("abbey.treasury.v1"), "amount": 400_000_000_000_000},  # 400M GOLD (testnet; prod is still open)
    {"address": derive("abbey.faucet.v1"), "amount": 50_000_000_000_000},  # 50M GOLD
]

for path, obj in ((cfg_path, c), (gen_path, g)):
    with open(path, "w") as f:
        json.dump(obj, f, indent=2)

net = f"tcp://{a.p2p_host}:{p2p}" if a.p2p_host else f"tcp://127.0.0.1:{p2p}"
print(f"""game chain {a.chain_id} on network {a.network_id}, nested under {a.root_url}: 200ms blocks, validator-less genesis.
Before starting it, stake this node's validator on the root for committee {a.chain_id}:
  address     {v['address']}
  public key  {v['publicKey']}
  net address {net}
  committees  [{a.chain_id}]
Until the root has that stake, the node logs "not subscribed" (Code 34) and makes no blocks.""")
