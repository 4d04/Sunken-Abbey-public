#!/usr/bin/env python3
"""
Turn a freshly initialised root data dir into the two-chain setup the game runs on (same topology as spike/localnet.sh):
root chain 1 (no plugin, 6s VRF blocks) and nested chain 2 (abbey plugin, 500ms round-robin blocks, canopy#648), one
validator staked for committees [1, 2]. The nested chain reuses the root validator's key and starts with the game's
treasury and faucet accounts funded.

Usage: make-chains.py /opt/abbey/data   (expects root/ with config.json, genesis.json and keys from a first boot)
"""

import hashlib
import json
import os
import shutil
import sys

data = sys.argv[1]
root, nested = os.path.join(data, "root"), os.path.join(data, "nested")


def derive(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()[:40]


def configure(c: dict, data_dir: str, plugin: str, port: str, p2p: int) -> dict:
    """Loopback-only node, no auto-update, no metrics (as localnet.sh configure)."""
    c = dict(c)
    c.update({
        "plugin": plugin,
        "autoUpdate": False,
        "pluginAutoUpdate": {**c.get("pluginAutoUpdate", {}), "enabled": False},
        "dataDirPath": data_dir,
        "backupDirectory": data_dir + "/backup",
        "listenAddress": f"127.0.0.1:{p2p}",
        "metricsEnabled": False,
        "prometheusAddress": f"127.0.0.1:{p2p + 89}",
        "walletPort": f"{port}00", "explorerPort": f"{port}01", "rpcPort": f"{port}02", "adminPort": f"{port}03",
        "rpcURL": f"http://127.0.0.1:{port}02", "adminRPCUrl": f"http://127.0.0.1:{port}03",
        "profilingPort": f"{p2p - 2940}",
        "headless": True,
    })
    return c


base = json.load(open(os.path.join(root, "config.json")))

# root chain 1: 6s VRF blocks (core defaults scaled by 6/20)
rc = configure(base, root, "", "500", 9001)
rc.update({"chainId": 1, "rootChain": [{"chainId": 1, "url": "http://127.0.0.1:50002"}], "proposerMode": "vrf", "runVDF": True})
for k, v in {"newHeightTimeoutMS": 4500, "electionTimeoutMS": 1500, "electionVoteTimeoutMS": 1500, "proposeTimeoutMS": 2500,
             "proposeVoteTimeoutMS": 4000, "precommitTimeoutMS": 2000, "precommitVoteTimeoutMS": 2000, "commitTimeoutMS": 2000}.items():
    rc[k] = int(v * 0.3)

# nested chain 2: the game, fast mode (500ms round-robin)
nc = configure(base, nested, "abbey", "300", 9002)
nc.update({
    "chainId": 2,
    "rootChain": [{"chainId": 1, "url": "http://127.0.0.1:50002"}, {"chainId": 2, "url": "http://127.0.0.1:30002"}],
    "proposerMode": "stakeWeightedRoundRobin", "roundRobinBlockIntervalMS": 500,
    "blockConsensusLeadTimeMS": 175, "maximumFutureBlockTimeMS": 1000, "runVDF": False,
    "newHeightTimeoutMS": 500, "electionTimeoutMS": 100, "electionVoteTimeoutMS": 500, "proposeTimeoutMS": 500,
    "proposeVoteTimeoutMS": 500, "precommitTimeoutMS": 500, "precommitVoteTimeoutMS": 500, "commitTimeoutMS": 500,
    "roundInterruptTimeoutMS": 250,
})

rg = json.load(open(os.path.join(root, "genesis.json")))
assert len(rg["validators"]) == 1, "expected one genesis validator"
rg["validators"][0]["committees"] = [1, 2]

ng = json.loads(json.dumps(rg))
ng["validators"][0]["committees"] = [2]
validator = ng["validators"][0]["address"]
ng["accounts"] = [
    {"address": validator, "amount": 1_000_000},
    {"address": derive("abbey.treasury.v1"), "amount": 400_000_000_000_000},  # 400M GOLD
    {"address": derive("abbey.faucet.v1"), "amount": 50_000_000_000_000},  # 50M GOLD
]

os.makedirs(nested, exist_ok=True)
for name in ("validator_key.json", "keystore.json"):
    shutil.copy2(os.path.join(root, name), os.path.join(nested, name))
for path, obj in ((os.path.join(root, "config.json"), rc), (os.path.join(nested, "config.json"), nc),
                  (os.path.join(root, "genesis.json"), rg), (os.path.join(nested, "genesis.json"), ng)):
    with open(path, "w") as f:
        json.dump(obj, f, indent=2)
print(f"validator {validator}: root chain 1 committees [1, 2], game chain 2 with treasury and faucet funded")
