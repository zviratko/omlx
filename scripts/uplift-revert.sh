#!/bin/bash
# Remove the Uplift deployment from the ACTIVE Homebrew oMLX. This is the
# exact inverse of scripts/uplift-deploy.sh (Phase 6 pipeline): remove the
# autopatch .pth, uninstall the package from the keg python, restart omlx.
# omlx itself is never modified by uplift (zero divergence), so there is
# nothing else to restore; the classic /admin/ dashboard never depended on
# anything uplift wrote.
#
# Round-trip verified 2026-09-21: deploy -> revert -> uplift 404 + classic
# alive -> deploy again -> both dashboards answer.
set -uo pipefail

BREW="$(command -v brew || echo /opt/homebrew/bin/brew)"
KEG_PY="$("$BREW" --prefix omlx 2>/dev/null)/libexec/bin/python"

if [ ! -x "$KEG_PY" ]; then
    echo "ERROR: keg python not found (brew install omlx first)" >&2
    exit 1
fi

"$KEG_PY" -m omlx_uplift.cli uninstall --python "$KEG_PY" 2>/dev/null \
    || echo "nothing to remove (.pth already gone)"
"$KEG_PY" -m pip uninstall -y omlx-uplift 2>&1 | tail -1
launchctl kickstart -k "gui/$(id -u)/sh.brew.omlx" \
    && echo "oMLX service restarted (kickstart)" \
    || echo "WARNING: could not kickstart sh.brew.omlx — restart omlx yourself"

# Legacy pre-Phase-6 leftovers (static copy + helper server), if any:
KEG_STATIC="$("$BREW" --prefix omlx 2>/dev/null)/libexec/lib/python3.11/site-packages/omlx/admin/static"
[ -d "$KEG_STATIC/uplift" ] && rm -rf "$KEG_STATIC/uplift" && echo "Removed $KEG_STATIC/uplift"
pkill -f "http.server 11436" 2>/dev/null && echo "Legacy helper server stopped"
