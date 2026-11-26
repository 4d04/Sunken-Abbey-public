#!/bin/bash
# setup-hybrid.sh - build the hybrid core: upstream canopy main + canopy-network/canopy#648's fast mode rebased onto it
# (fast-mode-on-upstream.patch) + our two local patches. Output: bin/canopy-hybrid. See HYBRID-REPORT.md.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# the upstream commit the fast-mode patch was rebased onto (2026-11-25)
UPSTREAM_COMMIT="${UPSTREAM_COMMIT:-1c37b13e}"
SRC="$SPIKE_DIR/canopy-hybrid"

if [ ! -d "$SPIKE_DIR/canopy/.git" ]; then
    git clone https://github.com/canopy-network/canopy.git "$SPIKE_DIR/canopy"
fi
git -C "$SPIKE_DIR/canopy" cat-file -e "$UPSTREAM_COMMIT^{commit}" 2>/dev/null || git -C "$SPIKE_DIR/canopy" fetch --quiet origin main
if [ ! -e "$SRC/.git" ]; then
    git -C "$SPIKE_DIR/canopy" worktree add --quiet --detach "$SRC" "$UPSTREAM_COMMIT"
fi
git -C "$SRC" checkout --quiet -- .
git -C "$SRC" checkout --quiet --detach "$UPSTREAM_COMMIT"
git -C "$SRC" apply "$SPIKE_DIR/fast-mode-on-upstream.patch"
git -C "$SRC" apply "$SPIKE_DIR/plugin-socket-dir.patch"
git -C "$SRC" apply "$SPIKE_DIR/max-block-size-lock.patch"

for d in cmd/rpc/web/explorer/dist cmd/rpc/web/wallet/out; do
    mkdir -p "$SRC/$d"
    [ -f "$SRC/$d/index.html" ] || echo placeholder > "$SRC/$d/index.html"
done
ln -sfn ../../../plugin "$SRC/plugin/abbey"

mkdir -p "$SPIKE_DIR/bin"
(cd "$SRC" && GOTOOLCHAIN=go1.26.0 go build -o ../bin/canopy-hybrid ./cmd/main/)
echo "built $SPIKE_DIR/bin/canopy-hybrid: canopy@$UPSTREAM_COMMIT + fast mode + local patches"
