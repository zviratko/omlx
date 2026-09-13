# Uplift QA Sweep Checklist (loop task 1.2)

Base URL: `http://kocour:11436/index.html` (hosts alias; also
`http://10.20.31.250:11436`). Gateway API: `:11437`. Findings file:
`~/hermes/TMP/uplift-findings.json` (schema: id, found, page, control,
symptom+repro, severity, status open|fixed|needs-user, fix_attempts,
evidence).

## Sweep procedure (FULL sweep = all rows, both themes)
1. Fresh `new_tab` to base URL (never trust an old tab — stale bytes).
2. Theme cycle auto→day→night→enhanced; at least one full sweep per theme.
3. For each page/control row: act, read DOM text/state (js()), screenshot
   only when something looks off. Headless tabs report hidden=true →
   override `document.hidden` before judging live/polling values.
4. A defect = append finding (with REPRO steps) — do not fix mid-sweep.
5. Console errors: `js` hook collects them; zero-tolerance, each one is a
   finding. (Remember: promise rejections need 'unhandledrejection'.)

## Sweep rows
- Status: tiles live; charts render dual-axis, hover tooltip follows
  cursor, values pinned across polls; heatmap cells >0 when data exists;
  gateway chip text matches actual mode (gw↑LIVE vs shadow+counts).
- Models (#models/manager): sort each column asc THEN desc (check first
  click direction!); name+type filters (incl. while editor open);
  fav/hide/default chips persist; state pill correct vs gateway info;
  settings accordion: open, toggle a conditional (speculative/dflash),
  profiles save/apply/delete, validation gate blocks MTP+DFlash conflict,
  save→banner text matches gateway mode; prune dialog lists real orphans.
- Helper Models (#models/helper): MarkItDown box fields + conditional
  expose-as-model; web search provider switch shows/hides exact fields;
  test-search row works; helper load/unload pills live; subtitle labels
  match gateway mode (see F-001).
- Downloader: search returns results; task appears in list, progress
  moves, cancel works; re-enter page → task still there.
- Uploader: validate-token paths (empty→401 msg, junk→401, hf_…→ok);
  modal prefills; start validation messages.
- Quantizer: model select lists real /oq/models; estimate changes with
  level (debounced); preserve_mtp disabled+amber when no MTP; start
  validation (level bounds, model_path).
- Server Settings (#settings): all 11 panels render; scroll each column;
  RESTART badges where expected; conditional rows (guard ceiling, GDN);
  change one harmless field, save, banner correct; reload → value
  persists (shadow file or live oMLX per mode); auth api_key masked.
- Logs: level filter; TRACE/DEBUG colors; feed scrolls; cancel button on
  active sim rows (live rows may 501 — message must be honest).
- Global: hotkeys 1-5; drag-reorder persists (localStorage v1 key);
  column count 1-5 incl. narrow window (resize to 900px); hash deep-link
  per page; no console errors; no layout overflow at 1280 and wide.

## Fix protocol (per plan section "overnight protocol v2")
- Repro first, then fix, node tests (`node --test tests/uplift.test.cjs
  tests/modelspec.test.cjs`), redeploy via scripts/uplift-deploy.sh,
  curl served bytes contain the change, browser re-run EXACT repro,
  append evidence+fixed to finding, commit (attribution line).
- 3 failed attempts → status needs-user + diagnosis comment, move on.
- Queue empty → run another FULL sweep. Only the morning /steer stops.

## Known context
- PRIORITY (2026-09-13): Phase 1A settings parity tasks P1A-1..8 in
  .hermes/plans/2026-09-13_uplift-to-production.md outrank QA findings.
  Missing classic settings: claude_code_* (+mode, opus/sonnet/haiku),
  CLI assistant model selects (copilot/codex/opencode/openclaw+profile/
  hermes/pi), hf_endpoint, ms_endpoint, ssd/hot_cache_max_size,
  gdn_ssd_split_enabled, auto_start_on_launch, server_aliases; gsSave
  must send the FULL 79-key payload (P1A-6). Parity+interop test = P1A-7.
- Gateway mode (live vs shadow) is not safety-critical on kocour; leave
  as started unless the session decides otherwise. Night default: LIVE
  is fine (dogfoods interoperability).
- Splice pitfall: after any uplift.js region rewrite, grep survivors:
  renderStoredSettings openPruneDialog initDownloader renderQuantizer
  renderUploader postJson renderTasks closeEditor pollGatewayInfo.
- [hidden] needs companion display:none rule for any class setting display.
- XSS: error text via textContent helpers only.
- Push fallback when SSH_AUTH_SOCK forwarding is dead (agent empty):
  `git push https://x-access-token:$(gh auth token)@github.com/zviratko/omlx.git
  feat/uplift-dashboard` — one-off URL, do NOT persist token in remote.
