#!/bin/bash
# Deploy Uplift to the ACTIVE Homebrew oMLX by pip-installing the
# omlx-uplift package INTO the keg's own python (Phase 6, zero-divergence:
# no files are copied into or edited inside the keg; `pip uninstall` is
# the revert). The autopatch .pth makes bare `omlx serve` (and launchd)
# mount the dashboard; `omlx-uplift serve` works as a wrapper regardless.
# Re-run after any `brew upgrade omlx` (fresh keg = fresh site-packages,
# the old install does not carry over).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$ROOT/projects/omlx-uplift"
# brew is not on PATH in non-login shells (e.g. ssh without -l)
BREW="$(command -v brew || echo /opt/homebrew/bin/brew)"
KEG_PY="$("$BREW" --prefix omlx 2>/dev/null)/libexec/bin/python"

if [ ! -x "$KEG_PY" ]; then
    echo "ERROR: keg python not found at $KEG_PY (brew install/upgrade omlx first)" >&2
    exit 1
fi

"$KEG_PY" -m pip install -q --upgrade "$PKG_DIR" 2>&1 | grep -v "^$" | tail -2 || true
echo "Installed omlx-uplift into keg python ($KEG_PY)"

# Autopatch .pth so plain `omlx serve` mounts Uplift too (wrapper-free).
"$KEG_PY" -m omlx_uplift.cli install --python "$KEG_PY"

# R12-1: never hardcode the server port — read it from oMLX's own settings.
OMLX_BASE="${OMLX_BASE_PATH:-$HOME/.omlx}"
PORT="$("$KEG_PY" -c "
import json, os
print(json.load(open(os.environ['OMLX_BASE']+'/settings.json'))['server']['port'])
" 2>/dev/null || echo "")"

# Restart the service so the freshly installed package mounts (the running
# process imported the old one; static-only dev iteration does NOT need a
# restart, package code does).
launchctl kickstart -k "gui/$(id -u)/sh.brew.omlx"
echo "oMLX service restarted (kickstart)"

# Readiness: wait for /health, then verify BOTH dashboards answer.
for i in $(seq 1 30); do
    sleep 2
    [ -n "$PORT" ] && curl -sf -m 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
done

if [ -n "$PORT" ]; then
    U=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${PORT}/uplift/")
    C=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${PORT}/admin/dashboard")
    echo "Uplift dashboard:  http://127.0.0.1:${PORT}/uplift/   (gate: $U — 200 login page / 302 expected, NOT 404)"
    echo "Classic dashboard: http://127.0.0.1:${PORT}/admin/dashboard (untouched: $C — 302/200 expected)"
    [ "$U" = "404" ] && { echo "ERROR: /uplift/ 404 — package did not mount; check: launchctl print gui/$(id -u)/sh.brew.omlx | tail -30" >&2; exit 1; }
else
    echo "Uplift dashboard:  http://<host>:<omlx-port>/uplift/ (could not read $OMLX_BASE/settings.json)"
fi

# Revert = "$KEG_PY" -m omlx_uplift.cli uninstall --python "$KEG_PY" && "$KEG_PY" -m pip uninstall -y omlx-uplift && launchctl kickstart -k gui/$(id -u)/sh.brew.omlx
# Legacy helpers (scripts/uplift-revert.sh etc.) predate this pipeline.
