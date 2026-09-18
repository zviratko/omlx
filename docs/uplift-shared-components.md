# Uplift ↔ Classic shared-component register (R11)

Every file/surface the Uplift dashboard touches, with its status. Rule:
anything `needs-change` is a NOT-YET until the user signs it off.

**Phase 6 (2026-09-17): the table collapsed to nearly nothing.** All
Uplift code moved into the standalone package `projects/omlx-uplift/`
(pip name `omlx-uplift`); `omlx/` is byte-identical to jundot/main
(`git diff jundot/main -- omlx/` is empty). The former rows —
`admin/routes.py` additions, `request_log.py`, `static/uplift/*`, the
`login.html ?next=` patch — are ALL reverted/gone; their content lives in
the package (router.py, request_log.py, static/, own login page).

| Component | Status | How |
|---|---|---|
| `omlx/**` (everything) | **untouched — zero divergence** | Uplift mounts at runtime from its own package via the `omlx_uplift.pth` hook (or the `omlx-uplift serve` wrapper). Reads `_server_state` / `_server` module attrs through public imports; writes nothing into omlx's namespace. |
| `omlx_uplift.pth` in the oMLX venv site-packages | install-time addition (not a file edit) | Written/removed by `omlx-uplift install` / `uninstall` (brew post-install does it). Vanilla `brew upgrade omlx` replaces the keg and simply drops it — omlx itself stays pristine; reinstall uplift to remount. |
| `~/.omlx/uplift/metrics.sqlite3` | new, Uplift-owned | Collector (in omlx's loop) writes; never read by classic. Vanilla's `~/.omlx/usage.sqlite3` is opened strictly READ-ONLY (URI `mode=ro`). |
| `/uplift/*`, `/admin/uplift/*` URL space | additive routes | Mounted by the package; classic never uses these paths. Removing the package 404s them and nothing else. |
| `~/.omlx/settings.json` | shared, semantics preserved | Uplift sends the SAME payloads classic does; P1A-7 interop test still proves a Uplift no-op save leaves the file byte-identical. The window `ui_dashboard_layout` (classic's saved block layout) is in GS_PAYLOAD_SKIP — uplift never round-trips it. |
| `omlx/admin/i18n/*`, `static/js/dashboard.js`, templates | untouched | Classic bundle byte-identical (zero diff by construction now). Layout-edit wording was copied at authoring time from classic's `status.layout.*` catalog into additive `uplift.layout.*` keys in the package's own locale overlays (one-time copy, no runtime read, no rewording of classic keys). Bench/Chat reuse is by same-origin IFRAME of the classic routes (`?tab=bench&benchTab=…`, `/admin/chat`) — classic JS untouched, it already supports these params; uplift's `navbar.tab.bench`, `navbar.tab.chat`, `navbar.dropdown.*` keys are READ from classic's catalog at runtime via the merged locale endpoint (additive uplift key: `uplift.layout.open_new`). |
| `vendor/gridstack-all.js` + `gridstack.min.css` (package) | new, Uplift-owned copies | Same gridstack 13.3.0 build classic vendored (byte-copied from `omlx/admin/static/`), but a separate copy inside the package — classic's vendor dir untouched; if upstream bumps gridstack, mirror the copy. |

## Opt-in behaviour

- Classic stays at `/admin/dashboard`; Uplift at canonical `/uplift/`
  (legacy `/admin/uplift/` aliases still served by the package). Both
  live in one process simultaneously; login is Uplift's own page at
  `/uplift/login` minting the SAME `omlx_admin_session` cookie (path `/`)
  — sessions cross both surfaces; classic's login is unmodified.
- Uninstall = `pip uninstall omlx-uplift` + `omlx-uplift uninstall`
  (drops the .pth). Classic fully functional afterwards; no restart
  order tricks needed.

## needs-user (nothing yet blocked)

- None. Future P1B i18n work must not reword classic's keys; new uplift
  keys go into the same locale JSONs additively.
