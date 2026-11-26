#!/bin/bash
# setup.sh - fetch and build the Canopy core the localnet runs, pinned to one commit
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# canopy-network/canopy#648 ("fast deterministic BFT mode": 500ms blocks, bounded proposal builds), not merged yet.
# M0-M3 were measured on 83af2a0c: CANOPY_COMMIT=83af2a0c spike/setup.sh builds that instead.
CANOPY_COMMIT="${CANOPY_COMMIT:-4313b031}"

if [ ! -d "$SPIKE_DIR/canopy/.git" ]; then
    git clone https://github.com/canopy-network/canopy.git "$SPIKE_DIR/canopy"
fi
if ! git -C "$SPIKE_DIR/canopy" cat-file -e "$CANOPY_COMMIT^{commit}" 2>/dev/null; then
    git -C "$SPIKE_DIR/canopy" fetch --quiet origin pull/648/head development main
fi
git -C "$SPIKE_DIR/canopy" checkout --quiet -- controller/controller.go bft/msg.go
git -C "$SPIKE_DIR/canopy" checkout --quiet --detach "$CANOPY_COMMIT"
# local patch: the plugin socket folder comes from CANOPY_PLUGIN_SOCKET_DIR (default /tmp/plugin), so Abbey's plugin
# socket can't collide with another project's plugin chain on this machine (the plugin reads the same variable)
git -C "$SPIKE_DIR/canopy" apply "$SPIKE_DIR/plugin-socket-dir.patch"
# local patch: the consensus loop reads the max block size under the controller lock. Unlocked, it raced Store.Reset (a
# block commit or round reset) and could land on a closed snapshot: `panic: pebble: closed`, about daily at 200ms blocks.
# Found with `go build -race`; see spike/FAST-BLOCKS-REPORT.md. Worth upstreaming to canopy-network/canopy#648.
git -C "$SPIKE_DIR/canopy" apply "$SPIKE_DIR/max-block-size-lock.patch"

# the embedded wallet and explorer UIs aren't needed for a headless localnet: placeholder pages let the core build
for d in cmd/rpc/web/explorer/dist cmd/rpc/web/wallet/out; do
    mkdir -p "$SPIKE_DIR/canopy/$d"
    [ -f "$SPIKE_DIR/canopy/$d/index.html" ] || echo placeholder > "$SPIKE_DIR/canopy/$d/index.html"
done

# the core runs plugin/<name>/pluginctl.sh relative to its checkout: point "abbey" at this repo's plugin
ln -sfn ../../../plugin "$SPIKE_DIR/canopy/plugin/abbey"

mkdir -p "$SPIKE_DIR/bin"
# Go 1.26.0: newer toolchains break a dependency (cockroachdb/swiss); go downloads this one if it is missing
(cd "$SPIKE_DIR/canopy" && GOTOOLCHAIN=go1.26.0 go build -o ../bin/canopy ./cmd/main/)
echo "built $SPIKE_DIR/bin/canopy at canopy@$CANOPY_COMMIT"
