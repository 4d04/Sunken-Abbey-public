#!/bin/bash
# localnet.sh - Canopy localnet node (env: DATA_DIR, PLUGIN, PORT, P2P_PORT, ABBEY_CHAIN_ID, BIN, CANOPY_DIR, CANOPY_PLUGIN_SOCKET_DIR)
# The game chain (data-nested) is its own root (single-chain.py); data-root is the old root chain, no longer used.
# Usage: ./localnet.sh {init|start|stop|status|logs|reset|configure} [blocktime: 6s, 10s, 20s, or fast]
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${DATA_DIR:-$SPIKE_DIR/data}"
# BIN and CANOPY_DIR pick another core build, e.g. BIN=$PWD/bin/canopy-pr648 CANOPY_DIR=$PWD/canopy-pr648
BIN="${BIN:-$SPIKE_DIR/bin/canopy}"
CANOPY_DIR="${CANOPY_DIR:-$SPIKE_DIR/canopy}"
PW_FILE="$SPIKE_DIR/.localnet-password"
LOG_FILE="$DATA_DIR/node.log"
# the plugin socket lives under this node's data dir (needs plugin-socket-dir.patch, applied by setup.sh), so it can't
# collide with another plugin chain on this machine; the plugin and pluginctl.sh read the same variable
export CANOPY_PLUGIN_SOCKET_DIR="${CANOPY_PLUGIN_SOCKET_DIR:-$DATA_DIR/plugin}"
PID_FILE="$DATA_DIR/node.pid"
PLUGIN="${PLUGIN-typescript}"
# port block per node: rpc=${PORT}02, admin=${PORT}03 (root 500xx, nested 300xx like the core docker localnet)
PORT="${PORT:-500}"
P2P_PORT="${P2P_PORT:-9001}"

# localnet-only throwaway keystore password, never committed
ensure_password() {
    if [ ! -f "$PW_FILE" ]; then
        openssl rand -hex 16 > "$PW_FILE"
        chmod 600 "$PW_FILE"
    fi
}

# patch config.json: loopback only, no auto-update, plugin on, chosen block time ("fast" = the 500ms round-robin mode)
configure() {
    local blocktime="${1:-6s}"
    python3 - "$DATA_DIR/config.json" "$DATA_DIR" "$PLUGIN" "$blocktime" "$PORT" "$P2P_PORT" <<'EOF'
import json, sys
path, data_dir, plugin, blocktime, port, p2p = sys.argv[1:7]
c = json.load(open(path))
c.update({
    "plugin": plugin,
    "autoUpdate": False,
    "pluginAutoUpdate": {**c.get("pluginAutoUpdate", {}), "enabled": False},
    "dataDirPath": data_dir,
    "backupDirectory": data_dir + "/backup",
    "listenAddress": f"127.0.0.1:{p2p}",
    "metricsEnabled": False,
    "prometheusAddress": f"127.0.0.1:{int(p2p) + 89}",
    "walletPort": f"{port}00", "explorerPort": f"{port}01", "rpcPort": f"{port}02", "adminPort": f"{port}03",
    "rpcURL": f"http://localhost:{port}02", "adminRPCUrl": f"http://localhost:{port}03",
    "profilingPort": f"{int(p2p) - 2940}",
    "runVDF": True,
    # wallet/explorer static servers bind all interfaces; RPC/admin follow listenAddress's host
    "headless": True,
})
if blocktime == "fast":
    # canopy-network/canopy#648: stake-weighted round-robin proposers, 500ms pacing; every validator must match
    c.update({
        "proposerMode": "stakeWeightedRoundRobin", "roundRobinBlockIntervalMS": 500,
        "blockConsensusLeadTimeMS": 175, "maximumFutureBlockTimeMS": 1000, "runVDF": False,
        "newHeightTimeoutMS": 500, "electionTimeoutMS": 100, "electionVoteTimeoutMS": 500, "proposeTimeoutMS": 500,
        "proposeVoteTimeoutMS": 500, "precommitTimeoutMS": 500, "precommitVoteTimeoutMS": 500, "commitTimeoutMS": 500,
        "roundInterruptTimeoutMS": 250,
    })
    json.dump(c, open(path, "w"), indent=2)
    print(f"configured plugin={plugin} fast mode (500ms round-robin)")
    sys.exit(0)
c["proposerMode"] = "vrf"
# 20s = core defaults; any other "<N>s" scales every phase by N/20 (6s = 0.3x, 10s = 0.5x)
defaults = {
    "newHeightTimeoutMS": 4500, "electionTimeoutMS": 1500, "electionVoteTimeoutMS": 1500,
    "proposeTimeoutMS": 2500, "proposeVoteTimeoutMS": 4000, "precommitTimeoutMS": 2000,
    "precommitVoteTimeoutMS": 2000, "commitTimeoutMS": 2000,
}
scale = float(blocktime.rstrip("s")) / 20.0
for k, v in defaults.items():
    c[k] = int(v * scale)
json.dump(c, open(path, "w"), indent=2)
print(f"configured plugin={plugin} blocktime={blocktime} total={sum(c[k] for k in defaults)}ms")
EOF
}

run_node() {
    mkdir -p "$CANOPY_PLUGIN_SOCKET_DIR"
    # canopy resolves plugin/<name>/pluginctl.sh relative to cwd, so run from the core checkout
    (cd "$CANOPY_DIR" && CANOPY_DATA_DIR="$DATA_DIR" nohup "$BIN" --data-dir "$DATA_DIR" \
        --password "$(cat "$PW_FILE")" --nickname localnet start >> "$LOG_FILE" 2>&1 & echo $! > "$PID_FILE")
}

node_pids() { pgrep -f "$BIN --data-dir $DATA_DIR" || true; }

stop_node() {
    local pids
    pids="$(node_pids)"
    if [ -n "$pids" ]; then
        kill $pids 2>/dev/null || true
        for _ in $(seq 1 30); do [ -z "$(node_pids)" ] && break; sleep 0.5; done
        pids="$(node_pids)"
        [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    # pluginctl.sh tracks the plugin with a host-global pid file, so only stop the plugin this node runs
    local node_plugin
    node_plugin="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('plugin') or '')" "$DATA_DIR/config.json" 2>/dev/null || true)"
    if [ -n "$node_plugin" ]; then
        (cd "$CANOPY_DIR/plugin/$node_plugin" && CANOPY_DATA_DIR="$DATA_DIR" ./pluginctl.sh stop >/dev/null 2>&1) || true
    fi
}

case "${1:-}" in
    init)
        ensure_password
        mkdir -p "$DATA_DIR"
        # first boot writes config, keystore and genesis; stop once the node is up
        run_node
        for _ in $(seq 1 60); do [ -f "$DATA_DIR/config.json" ] && grep -q "keystore" "$LOG_FILE" 2>/dev/null && break; sleep 1; done
        sleep 3
        stop_node
        configure "${2:-6s}"
        ;;
    start) ensure_password; run_node; echo "started pid $(cat "$PID_FILE")" ;;
    stop) stop_node; echo "stopped" ;;
    status) p="$(node_pids)"; [ -n "$p" ] && echo "running pid $p" || echo "not running" ;;
    logs) sed 's/\x1b\[[0-9;]*m//g' "$LOG_FILE" | tail -n "${2:-40}" ;;
    configure) configure "${2:-6s}" ;;
    reset) stop_node; rm -rf "$DATA_DIR" ;;
    *) echo "usage: $0 {init|start|stop|status|logs|configure|reset} [<N>s, e.g. 6s 10s 20s]"; exit 1 ;;
esac
