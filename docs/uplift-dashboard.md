# Uplift Dashboard — project state & handoff

Status file for continuing this project in a fresh session on any machine.
Read this first, then the code. Last update: 2026-09-13 (kocour migration +
dedicated `uplift` Hermes profile on the devbox).

## What this is

A standalone, modernized dashboard for oMLX ("Uplift") that replicates the
classic admin UI's features with a NASA 1970s (worm-era) aesthetic: flat
solid colors, square corners, no gradients/shadows, blue/gold accents, no
purple. It runs **alongside** the classic dashboard with zero interference:
static files only, no oMLX code modified, oMLX is never restarted.

- Branch: `feat/uplift-dashboard` (fork `zviratko/omlx`), worktree
  `worktrees/uplift` in any machine's `~/git/omlx` checkout.
- Design system: NASA Graphics Standards Manual NHB 1430.2 (see the
  `nasa-70s-ux` Hermes skill for the distilled rules).

## Machines (as of 2026-09-13)

| | kocour (PRIMARY dev machine) | old local Mac (retired, read-only) |
|---|---|---|
| Host | `zviratko@10.20.31.250`, macOS arm64 | this laptop network position |
| Hermes agent | dedicated `uplift` profile runs REMOTELY here (terminal backend = ssh into kocour; the agent cannot see the local Mac's profile dir from here — hostname check `kocour.local` confirms isolation) | original dev sessions (history) |
| Repo | `~/git/omlx` (ssh remote via agent forwarding; `jundot` = upstream) | `~/git/omlx` — do not modify |
| Real oMLX | brew formula, port **8000**, launchd; admin API protected: POST `/admin/api/login` `{"api_key":<auth.api_key from ~/.omlx/settings.json>}` -> `omlx_admin_session` cookie | port 11435, no auth |
| venv | `~/venvs/omlx-dev` (brew python@3.11, `pip install -e ".[dev]"`) | – |
| node | brew (v26) | v26 |
| gh CLI | logged in as zviratko | logged in |
| Uplift UI | http://10.20.31.250:11436 (binds 0.0.0.0, trusted LAN) | :11436 still running |
| Mock gateway | :11437 -> upstream :8000 (cookie auth + shadow writes) | :11437 -> :11435 |
| Sandbox data | `~/hermes/TMP/omlx-uplift-data/*.json` (never touches ~/.omlx) | same path on that Mac |
| Cheat sheet | `~/hermes/TMP/DEVBOX-ENV.md` | – |

Do NOT delete or modify anything on the old local Mac; it is history only.

## Redeploy / restart commands (kocour)

```bash
KEY=$(/Users/zviratko/venvs/omlx-dev/bin/python -c \
  'import json;print(json.load(open("/Users/zviratko/.omlx/settings.json"))["auth"]["api_key"])')
UPLIFT_BIND_HOST=0.0.0.0 UPLIFT_UPSTREAM=http://127.0.0.1:8000 \
UPLIFT_UPSTREAM_API_KEY=$KEY \
  bash ~/git/omlx/worktrees/uplift/scripts/uplift-deploy.sh
# restart the mock (script edits need it; deploy only starts if missing):
kill $(lsof -tnP -iTCP:11437 -sTCP:LISTEN)  # then re-run deploy
```

`brew` is NOT on the non-login ssh PATH — use `/opt/homebrew/bin/brew` or
`bash -lc`. The deploy script handles this itself now.

## Architecture

- `omlx/admin/static/uplift/` — the UI (index.html, uplift.js controller,
  core.js pure logic (Node-testable), modelspec.js client twin of the
  server settings schema, uplift.css, vendored uPlot etc.).
- `scripts/uplift-deploy.sh` — copies static files into the active brew
  keg (`brew --prefix omlx`), stamps `?v=<ts>` cache busters, ensures the
  two helper servers. Re-run after any `brew upgrade omlx`.
- `scripts/uplift-server.py` — no-store static server (port 11436).
  Plain http.server caused stale-index headaches; never use it.
- `scripts/uplift-mock.py` — **gateway** (port 11437): proxies GETs to
  real oMLX (with login-cookie auth), intercepts ALL writes into shadow
  state (`--api-key`/env, re-login on 401), simulates request lifecycles,
  SSE stream, cancel for sim rows only, percentiles computed client-side,
  task simulation for downloader/quantizer/uploader, shadow settings store.
  **`--live-writes` mode** (env `UPLIFT_LIVE_WRITES=1` in the deploy
  script): forwards model-settings PUT, global-settings POST, load/unload/
  pin (pin -> `PUT settings {is_pinned}`; no upstream route), profiles,
  templates, and task writes to the REAL server; real validation responses
  pass through verbatim; masked `api_key "••••"` is never resent. Stays
  local: mock control routes, sim cancel, upload/validate-token (UI token
  never forwarded). In live mode the sandbox store is inactive; real server
  is the settings source of truth (snapshot refreshed right after writes).
  UI gateway chip shows `gw↑LIVE` and save banners say "live — written to
  real oMLX". Caveat: real oMLX does NOT range-validate temperature
  (accepts 99); the mock does. PUT to an unknown model creates a settings
  record upstream (verified with MiniCPM5-2B; reset to defaults after).
- `scripts/omlx_settings_store.py` — faithful replica of
  ModelSettingsManager; writes real-format JSON to the sandbox dir only.
- UI default API base is page-host-relative (`//hostname:11437`), so LAN
  clients work without `?api=`.

The sandbox POST for global settings accepts the classic flat
`GlobalSettingsRequest` payload + `integrations_*` keys, shadows them, and
overlays them on GET (`GS_FLAT_MAP` in the mock). Real oMLX config files
are never written.

## Feature state (all committed, verified in browser)

- Status tab: stat tiles, uPlot throughput/memory charts (dual axis),
  per-model hot-cache series, cursor-following value tooltip (under-chart
  readout bars were explicitly REJECTED by the user — do not re-add),
  usage heatmap, milestones/confetti (idempotent per session).
- Models dropdown (user-chosen order): Model Settings, Helper Models,
  Manager, Downloader, Uploader, oQ(e) Quantization. Dropdowns open on
  hover too (250 ms grace close).
- Model manager: sorting (comparators ASC x direction flag), name/type
  filters, favorite/hide/default chips, fixed-width state pills,
  in-place expanding settings editor (accordion; auto-refresh suppressed
  while open, filters exempted).
- Model Settings store: full 84-field settings schema mirroring
  `omlx/model_profiles.py` + `model_settings.py`, profiles/templates,
  server-identical validation errors, prune dialog (checkboxes, real
  orphan computation). Status pills: MISSING = caution-amber pill,
  PRESENT = normal, EXTERNAL = dim (user's label choice).
- Helper Models page: MarkItDown box + Web Search box (all fields,
  labels, conditionals from the classic Integrations tab, saves via flat
  `integrations_*` POST like `saveIntegrationSettings()`) + drafters &
  assistants list with load/unload. Standalone Integrations page deleted.
- Server Settings (plain nav link, no dropdown): EDITABLE form mirroring
  the classic page — 11 sections in template order (Global, Language,
  Auth, Server, Model, Resource Management, Cache, Generation Defaults,
  MCP, Usage & Network, Advanced), same fields/hints/RESTART badges,
  conditional rows (custom guard ceiling, GDN sidecar + int8 warning),
  sliders, model-dir add/remove. Full flat payload saved per change.
- Server Settings page layout (2026-09-13): segmented into 11 bordered
  section boxes flowing in a capped multi-column layout (#gs-body.gs-wrap:
  columns 320px x 3, max-width 1200px centered). RESTART badge width fixed
  (was fixed 84px .spill narrower than its text, overlapping the label;
  now auto-width + padding, wraps below label text).
- Logs tab with level filtering; hotkeys 1-5; drag-drop layout order
  (`omlx-uplift-layout-v1` in localStorage); prefs
  (`omlx-uplift-prefs-v1`).

## Verification protocol (do not skip)

1. `cd worktrees/uplift && node --test tests/uplift.test.cjs tests/modelspec.test.cjs`
   — 43/43 must pass (UI-free logic).
2. Python admin/settings tests still green on kocour: 
   `~/venvs/omlx-dev/bin/python -m pytest tests/test_admin_model_settings.py tests/test_admin_profiles_api.py -q`
   — 90 passed (2026-09-13).
3. Verify SERVED bytes (`curl` the `?v=` URL) before debugging "no
   change"; stale cache masquerades as failed deploy.
4. Browser-verify via CDP; headless tabs report `document.hidden=true`
   (polling pauses!) — override it before judging live values.
5. User tests in Safari/Firefox; their reproduced symptom = open bug
   regardless of my headless pass.

## Caveats & specialties (learned the hard way)

- Splice rewrites of uplift.js silently swallowed neighbouring functions
  TWICE — after any region rewrite, grep for every function that must
  survive (`renderStoredSettings openPruneDialog initDownloader
  renderQuantizer renderUploader postJson renderTasks` …).
- Classes setting `display` defeat `[hidden]` — every such class needs an
  explicit `[hidden]{display:none}` companion rule. (Bit twice.)
- uPlot vendored build lacks cursor hooks; bind hover on the `.u-over`
  overlay. Flat data looks like broken hover — check series variance
  first. Timestamp-pin hover across `setData` window shifts.
- Module-scope chart `let`s used during boot => TDZ kills the whole IIFE
  silently; declare chart handles at top.
- Mock route parsing: leading `/` puts `''` at index 0 (off-by-one =>
  silent empty lists).
- Sort comparators ascending-only x direction flag.
- Error text from gateway must go through textContent helpers, never
  innerHTML (XSS).
- API key: never echoed to chat/logs/argv; env-only (`UPLIFT_UPSTREAM_API_KEY`).
- `modelspec.js` + store + tests must move together with any server
  settings-schema change.

## TODO / possible next steps (nothing promised)

### Real oMLX backend gaps (verified 2026-09-13 against :8000)
Features that exist ONLY in the gateway, candidates for upstream PRs:
1. Request lifecycle log + `GET /admin/api/requests` (404 on real) and
   `POST /admin/api/requests/{id}/cancel` — real /stats shows only live
   rows; gateway polls at 1s so fast requests are missed. Cancel needs a
   scheduler route (gateway returns 501 for real-origin requests).
2. SSE stream for request events (real SSE is benchmark-only); UI
   currently falls back to 2s polling against the real server.
3. Server-side percentiles (`request_stats`): token sizes, TTFT, total-ms,
   p50-p99. Could be computed from usage-history SQLite upstream.
4. Prune orphaned model settings (`POST /admin/api/prune-model-settings`,
   `GET /admin/api/model-settings-index`) — no upstream equivalent at all.
5. `GET /admin/api/models/{id}/settings` — 405 upstream (PUT only), but
   data rides inside `GET /api/models` (`asdict(settings)`), so the mock
   route is convenience only; not a real gap.
Not gaps (deliberate shadow layer only): global settings GET/POST,
model load/unload, downloader/quantizer/uploader task routes all exist on
the real server — use `--live-writes` to talk to them for real.

### Branch sync (working, keep doing it)
Fork `origin`=zviratko/omlx, upstream remote `jundot`. Routine: `git fetch
jundot main && git merge jundot/main` in the worktree (merge, not rebase,
day-to-day — our files are additive so conflicts are ~never); rebase onto
jundot/main once right before an upstream PR. First sync 2026-09-13:
5d961abe merged 9 upstream commits, zero conflicts. Watch: a native
/uplift route would touch routes.py = first real overlap.

- [ ] PR to upstream `jundot/omlx` when the user says the dashboard is
      ready (attribution: keep zviratko primary, Hermes line as wrap-up).
- [ ] Optional: native static route for `/uplift` (needs routes.py +
      .html media type => requires user's oMLX restart; not granted).
- [ ] Optional: per-model percentile views beyond session window once a
      server-side source exists (currently honest client-side only).
- [ ] Sandbox refresh option: mock `--seed` copies real ~/.omlx JSONs
      once (copy-once; delete sandbox files to re-sync).
- [ ] Watch: `brew upgrade omlx` moves keg paths — deploy script resolves
      via `brew --prefix`, but the helper server may need a restart.

## History (condensed)

Built 2026-09-12/13 on the local Mac across ~25 commits (initial UI,
gateway mock, settings parity with 84 fields, hover tooltip iteration,
i18n label audit `bb7b973b`, dropdown nav + prune + sorting `6e9633f8`,
quantizer/uploader server parity `40be3aa1`, nav reorg `b9d757ca`,
integration settings parity + menu order `cf4d647d`, editable server
settings `49feee12`), then migrated to kocour (`a1064159`..`85aa8bf0`:
brew-in-non-login-shell fix, cookie auth passthrough for :8000, LAN
bind + page-relative API default). Earlier dashboard patch work lives in
skill `omlx-dashboard-development` and `~/hermes/TMP/omlx-dashboard-layout-v2*`
on the old Mac.

Made under human guidelines by Qwen3.8-Flash-Next with free tokens from local oMLX inference server
