#!/usr/bin/env python3
"""
The hybrid rehearsal: the game as a nested chain under a Canopy-style root, on our core (canopy#648's fast mode rebased
onto upstream main, plus spike/*.patch). It stands in for running the game under Canopy's own root chain.

- root chain 1: no plugin, Canopy's default 20s VRF blocks with the VDF on (as Canopy's root runs), one validator
  staked for committees [1, <game id>]
- game chain <game id>: the abbey plugin, 200ms round-robin blocks, a VALIDATOR-LESS genesis (its committee is read
  from the root, as Canopy's graduation pipeline does it), rootChainID 1, P2P on 9000 + id

Usage: hybrid-chains.py <root data dir> <game data dir> <game chain id>
  (expects the root dir from a first boot: `localnet.sh init 20s`; both chains must start fresh afterwards)
"""

import hashlib
import json
import os
import shutil
import sys

root, game, gid = sys.argv[1], sys.argv[2], int(sys.argv[3])
ROOT_PORT, GAME_PORT, GAME_P2P = "400", "410", 9000 + gid


def derive(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()[:40]


def ports(c: dict, data_dir: str, port: str, p2p: int) -> None:
    c.update({
        "dataDirPath": data_dir, "backupDirectory": data_dir + "/backup",
        "listenAddress": f"127.0.0.1:{p2p}", "prometheusAddress": f"127.0.0.1:{p2p + 89}",
        "walletPort": f"{port}00", "explorerPort": f"{port}01", "rpcPort": f"{port}02", "adminPort": f"{port}03",
        "rpcURL": f"http://127.0.0.1:{port}02", "adminRPCUrl": f"http://127.0.0.1:{port}03",
        "profilingPort": f"{p2p - 2940}", "autoUpdate": False, "metricsEnabled": False, "headless": True,
        "pluginAutoUpdate": {**c.get("pluginAutoUpdate", {}), "enabled": False},
        "minimumPeersToStart": 0,
    })


root_url = f"http://127.0.0.1:{ROOT_PORT}02"
rc = json.load(open(os.path.join(root, "config.json")))
ports(rc, root, ROOT_PORT, 9001)
rc.update({"chainId": 1, "rootChain": [{"chainId": 1, "url": root_url}], "plugin": "", "proposerMode": "vrf", "runVDF": True})

gc = json.loads(json.dumps(rc))
ports(gc, game, GAME_PORT, GAME_P2P)
gc.update({
    "chainId": gid,
    "rootChain": [{"chainId": 1, "url": root_url}],
    "plugin": "abbey",
    "runVDF": False,
    # canopy-network/canopy#648 fast mode, as the 200ms localnet runs it
    "proposerMode": "stakeWeightedRoundRobin", "roundRobinBlockIntervalMS": 200,
    "blockConsensusLeadTimeMS": 50, "maximumFutureBlockTimeMS": 1000,
    "newHeightTimeoutMS": 500, "electionTimeoutMS": 100, "electionVoteTimeoutMS": 500, "proposeTimeoutMS": 500,
    "proposeVoteTimeoutMS": 500, "precommitTimeoutMS": 500, "precommitVoteTimeoutMS": 500, "commitTimeoutMS": 500,
    "roundInterruptTimeoutMS": 250,
})

rg = json.load(open(os.path.join(root, "genesis.json")))
assert len(rg["validators"]) == 1, "expected one genesis validator"
rg["params"]["consensus"]["rootChainID"] = 1
rg["validators"][0]["committees"] = [1, gid]
validator = rg["validators"][0]["address"]

gg = json.loads(json.dumps(rg))
gg["validators"] = []  # validator-less: the committee comes from the root
gg["params"]["consensus"]["rootChainID"] = 1
gg["accounts"] = [
    {"address": validator, "amount": 1_000_000},
    {"address": derive("abbey.treasury.v1"), "amount": 400_000_000_000_000},  # 400M GOLD (local stand-in for launch funding)
    {"address": derive("abbey.faucet.v1"), "amount": 50_000_000_000_000},  # 50M GOLD
]

os.makedirs(game, exist_ok=True)
for name in ("validator_key.json", "keystore.json"):
    shutil.copy2(os.path.join(root, name), os.path.join(game, name))
for path, obj in ((os.path.join(root, "config.json"), rc), (os.path.join(game, "config.json"), gc),
                  (os.path.join(root, "genesis.json"), rg), (os.path.join(game, "genesis.json"), gg)):
    with open(path, "w") as f:
        json.dump(obj, f, indent=2)
print(f"root chain 1 (20s VRF, validator {validator[:8]}… staked for [1, {gid}]) and game chain {gid} "
      f"(200ms, validator-less genesis, P2P {GAME_P2P})")
