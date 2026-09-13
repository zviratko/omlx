#!/bin/bash
# Deploy the Uplift dashboard to the ACTIVE Homebrew omlx keg (static files only).
# No omlx code is modified, no restart needed (static files are read per request).
# Safe across normal use; re-run after any `brew upgrade omlx`.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/omlx/admin/static/uplift"
KEG="$(brew --prefix omlx 2>/dev/null)/libexec/lib/python3.11/site-packages/omlx/admin/static"

if [ ! -d "$KEG" ]; then
    echo "ERROR: keg static dir not found at $KEG" >&2; exit 1
fi

DEST="$KEG/uplift"
mkdir -p "$DEST/vendor"
cp "$SRC/index.html" "$SRC/uplift.js" "$SRC/uplift.css" "$SRC/core.js" "$SRC/modelspec.js" "$DEST/"
cp "$SRC/vendor/"* "$DEST/vendor/"
# Cache busting: stamp asset versions so browsers never serve stale CSS/JS.
BUILD="$(date +%s)"
sed -i '' "s/BUILD/$BUILD/g" "$DEST/index.html"
echo "Deployed to: $DEST (cache stamp $BUILD)"

# Helper static server (serves index.html; the keg's own /admin/static route
# has no .html media type, and we must not patch routes.py without a restart).
# Uses uplift-server.py: index.html is served with no-store so deploys land
# immediately (python -m http.server lets browsers keep a stale index fresh).
PORT=11436
if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT/index.html"; then
    nohup python3 "$(cd "$(dirname "$0")" && pwd)/uplift-server.py" --port "$PORT" "$DEST" \
        >> "$HOME/hermes/TMP/uplift-server.log" 2>&1 &
    sleep 1
elif ! curl -sI "http://127.0.0.1:$PORT/index.html" | grep -qi "cache-control: no-store"; then
    # Old python -m http.server instance: replace with the no-cache server.
    kill "$(lsof -tnP -iTCP:$PORT -sTCP:LISTEN)" 2>/dev/null || true
    sleep 0.5
    nohup python3 "$(cd "$(dirname "$0")" && pwd)/uplift-server.py" --port "$PORT" "$DEST" \
        >> "$HOME/hermes/TMP/uplift-server.log" 2>&1 &
    sleep 1
    echo "Helper server upgraded to no-cache uplift-server.py"
fi
echo "Uplift dashboard: http://127.0.0.1:$PORT/index.html"
echo "Classic dashboard stays at http://127.0.0.1:11435/admin/dashboard (untouched)"

# Mock gateway (API for the UI: proxies oMLX + shadow writes + lifecycle sim).
# Override upstream with UPLIFT_UPSTREAM (e.g. http://127.0.0.1:8000) and auth
# with UPLIFT_UPSTREAM_API_KEY (env only, never logged).
GPORT=11437
if ! curl -sf -o /dev/null "http://127.0.0.1:$GPORT/admin/api/mock/info"; then
    UPLIFT_UPSTREAM_API_KEY="${UPLIFT_UPSTREAM_API_KEY:-}" \
    nohup python3 "$(cd "$(dirname "$0")" && pwd)/uplift-mock.py" --sim 0.5 --seed \
        --upstream "${UPLIFT_UPSTREAM:-http://127.0.0.1:11435}" \
        >> "$HOME/hermes/TMP/uplift-mock.log" 2>&1 &
    sleep 1
    echo "Mock gateway started: http://127.0.0.1:$GPORT"
else
    echo "Mock gateway already running: http://127.0.0.1:$GPORT"
fi
