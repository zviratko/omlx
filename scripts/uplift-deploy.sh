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
cp "$SRC/index.html" "$SRC/uplift.js" "$SRC/uplift.css" "$SRC/core.js" "$DEST/"
cp "$SRC/vendor/"* "$DEST/vendor/"
# Cache busting: stamp asset versions so browsers never serve stale CSS/JS.
BUILD="$(date +%s)"
sed -i '' "s/BUILD/$BUILD/g" "$DEST/index.html"
echo "Deployed to: $DEST (cache stamp $BUILD)"

# Helper static server (serves index.html; the keg's own /admin/static route
# has no .html media type, and we must not patch routes.py without a restart).
PORT=11436
if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT/index.html"; then
    (cd "$DEST" && nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &)
    sleep 1
fi
echo "Uplift dashboard: http://127.0.0.1:$PORT/index.html"
echo "Classic dashboard stays at http://127.0.0.1:11435/admin/dashboard (untouched)"
