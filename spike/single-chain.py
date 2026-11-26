#!/usr/bin/env python3
"""
Make a node's chain its own root: no root chain to run, no committee staking elsewhere. The core treats a chain as
its own root when its config chainId equals the genesis rootChainID (fsm/gov.go LoadIsOwnRoot).

Rewrites <data dir>/config.json (chainId, rootChain -> itself) and genesis.json (rootChainID, the validators'
committees). Existing state was built from the old genesis, so the chain must start fresh: move <data dir>/canopy aside.

Usage: single-chain.py <data dir> <chain id> <port block>   e.g. single-chain.py spike/data-nested 2 300
"""

import json
import os
import sys

data, chain_id, port = sys.argv[1], int(sys.argv[2]), sys.argv[3]
cfg_path, gen_path = os.path.join(data, "config.json"), os.path.join(data, "genesis.json")
c, g = json.load(open(cfg_path)), json.load(open(gen_path))
c["chainId"] = chain_id
c["rootChain"] = [{"chainId": chain_id, "url": f"http://127.0.0.1:{port}02"}]
g["params"]["consensus"]["rootChainID"] = chain_id
for v in g["validators"]:
    v["committees"] = [chain_id]
for path, obj in ((cfg_path, c), (gen_path, g)):
    with open(path, "w") as f:
        json.dump(obj, f, indent=2)
print(f"{data}: chain {chain_id} is its own root ({len(g['validators'])} validator(s), {len(g['accounts'])} genesis accounts)")
