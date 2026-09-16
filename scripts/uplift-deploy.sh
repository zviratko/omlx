#!/bin/bash
# Deploy the Uplift dashboard to the ACTIVE Homebrew omlx keg (R12: no
# helper servers, everything runs against real oMLX itself).
# Static files land immediately (read per request). The additive python
# surface (omlx/admin/routes.py + templates/login.html) is synced too and
# needs a restart — done automatically here.
# Re-run after any `brew upgrade omlx`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/omlx/admin/static/uplift"
# brew is not on PATH in non-login shells (e.g. ssh without -l)
BREW="$(command -v brew || echo /opt/homebrew/bin/brew)"
PKG="$("$BREW" --prefix omlx 2>/dev/null)/libexec/lib/python3.11/site-packages/omlx"
KEG="$PKG/admin/static"

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
echo "Deployed static to: $DEST (cache stamp $BUILD)"
# Note: DEST is the keg's admin/static/uplift dir itself, so the native
# /admin/uplift/ route serves the exact bytes deployed here — no second copy.

# Additive python surface: uplift routes + settings-index/prune endpoints +
# login ?next= pass-through (R12-5) + live request tracker (R12-3).
# Classic does not use any of it.
# Pre-swap original routes.py backup (2026-09-16): ~/hermes/TMP/keg-routes-backup-2026-09-16.py
RESTART_NEEDED=0
for f in admin/routes.py admin/templates/login.html request_log.py; do
    if ! cmp -s "$ROOT/omlx/$f" "$PKG/$f"; then
        cp "$ROOT/omlx/$f" "$PKG/$f"
        echo "Synced $f into keg"
        RESTART_NEEDED=1
    fi
done

# R12-1: never hardcode the server port — read it from oMLX's own settings.
OMLX_BASE="${OMLX_BASE_PATH:-$HOME/.omlx}"
export OMLX_BASE
PORT="$(python3 -c "
import json, os
print(json.load(open(os.environ['OMLX_BASE']+'/settings.json'))['server']['port'])
" 2>/dev/null || echo "")"

if [ "$RESTART_NEEDED" = "1" ]; then
    launchctl kickstart -k "gui/$(id -u)/sh.brew.omlx"
    echo "oMLX restarted (python surface changed)"
fi

if [ -n "$PORT" ]; then
    echo "Uplift dashboard:  http://127.0.0.1:${PORT}/admin/uplift/"
    echo "Classic dashboard: http://127.0.0.1:${PORT}/admin/dashboard (untouched)"
else
    echo "Uplift dashboard:  http://<host>:<omlx-port>/admin/uplift/ (could not read $OMLX_BASE/settings.json)"
fi

# R12: the mock gateway (:11437) and standalone static server (:11436) are
# retired from the default path. For shadow-sandbox QA only, start them by
# hand: python3 scripts/uplift-mock.py --help / uplift-server.py --help.
