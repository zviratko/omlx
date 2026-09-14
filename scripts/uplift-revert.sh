#!/bin/bash
# Remove the Uplift dashboard deployment: keg static files + helper server.
# omlx itself is never modified, so there is nothing else to restore.
set -uo pipefail
KEG="$(brew --prefix omlx 2>/dev/null)/libexec/lib/python3.11/site-packages/omlx/admin/static"
rm -rf "$KEG/uplift" && echo "Removed $KEG/uplift"
pkill -f "http.server 11436" 2>/dev/null && echo "Helper server stopped" || echo "Helper server was not running"
