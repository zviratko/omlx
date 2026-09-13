# Uplift Dashboard → Production Plan

> **For Hermes:** execute phase by phase; each task is one contained unit.
> Read `docs/uplift-dashboard.md` (handoff) before touching anything.

**Goal:** take the Uplift dashboard from sandbox demo to (a) polished UI,
(b) daily-driver replacement for the classic dashboard on kocour, (c) an
optional upstream PR later.

**Baseline discipline (every phase):** classic dashboard untouched; 43/43
Node tests + admin pytest green; deploy script re-run after UI edits;
verify SERVED bytes before judging any change; commit per task with the
standard attribution line.

---

## Phase 1 — Feature parity first, then polish (user-in-the-loop + overnight loops)

Mode: interactive by day (user tests Safari/Firefox, reports symptoms),
autonomous overnight via standing goal + QA sweep loop.

### Phase 1A — SETTINGS PARITY (do first; user directive 2026-09-13)
Goal: every setting the classic UI exposes is exposed in Uplift, pleasant
UI, full i18n (D1), and payload-compatible with real oMLX (same flat
`GlobalSettingsRequest` schema — 79 keys, interoperable both directions).

Gap audit (verified 2026-09-13 against `GlobalSettingsRequest` +
grep of uplift.js; classic=79 keys, Uplift covers 48):
- [ ] P1A-1 Claude Code box: `claude_code_mode` + opus/sonnet/haiku
      model selects (model pickers like classic; where they live in the
      classic UI = check _settings.html section list first).
- [ ] P1A-2 CLI assistant model selects: copilot, codex, opencode,
      openclaw (+ openclaw_tools_profile), hermes, pi (`integrations_*`).
- [ ] P1A-3 HF/ModelScope endpoints: `hf_endpoint`, `ms_endpoint`
      (Usage & Network section).
- [ ] P1A-4 Cache sizes: `ssd_cache_max_size`, `hot_cache_max_size`;
      advanced: `gdn_ssd_split_enabled` (conditional next to
      gdn_ssd_pending_max_size).
- [ ] P1A-5 Server: `auto_start_on_launch` toggle (RESTART badge),
      `server_aliases` editor.
- [ ] P1A-6 FULL-PAYLOAD fix: gsSave body must send the complete 79-key
      payload (missing keys currently omitted -> LIVE saves never write
      them). Build payload from GET response fields, not a static list.
      Gateway GS_FLAT_MAP + GS_SHADOW paths extended to match.
- [ ] P1A-7 Parity test: script that diffs classic `GlobalSettingsRequest`
      fields vs Uplift GS_MAP + helper-page keys and fails on drift; run
      in CI loop (node test). Interop test: GET real settings -> save
      unchanged via Uplift live mode -> real file semantically identical.
- [ ] P1A-8 Model settings editor parity re-check vs
      `_modal_model_settings.html` after any upstream schema change
      (84-field twin in modelspec.js must move with it).

### Phase 1B — i18n parity (DECIDED: full, before PR)
- [ ] P1B-1 Wire `t()` + locale fetch into uplift.js (classic pattern,
      9 locales), extract every literal (GS_LABELS block, toasts, pills).
- [ ] P1B-2 Translate new keys into all 9 locale files (reuse classic
      wording where keys exist; en.json restart-cache quirk applies).

### Phase 1C — polish loop (was Phase 1)

- **1.1 QA sweep harness** — `tests/uplift-qa.md`: a checklist the agent
  walks with the headless browser: each page (Status/Models×6 sub-pages/
  Server Settings/Logs), every control type (selects, toggles, sliders,
  accordions, dialogs, hotkeys 1-5, drag layout, theme cycle, column
  count), both themes, narrow window. Output: defect entries appended to
  `~/hermes/TMP/uplift-findings.json` (page, control, symptom, severity).
- **1.2 Overnight loop protocol** (run under `/goal`, ~6-8 h budget):
  repeat { run full sweep → pick highest-severity open defect → root-cause
  fix → node tests + relevant pytest → redeploy + verify served bytes →
  re-test the defect → commit } until two CONSECUTIVE full sweeps with zero
  new defects, or time budget, or user stop. Never end the loop just
  because a queue is momentarily empty — always re-sweep.
- **1.3 Known candidates already seen** — real-vs-mock validation parity
  (upstream accepts temperature 99; modelspec client should warn);
  LAN-wide font/theme checks at 2560px; assist/draft load-latency pill
  behaviour in live mode.
- **Exit criterion:** user signs off visually; checklist sweep x2 clean.

## Phase 2 — Cleanup and tests (presentable codebase)

- **2.1** Split `uplift.js` (3.3k lines) into per-page modules
  (ES modules, no build step — plain `<script type="module">`); move
  inline logic out of index.html.
- **2.2** i18n FULL parity (DECIDED 2026-09-13): wire all 9 locale files
  under `omlx/admin/i18n/` with the classic `t()` pattern for every Uplift
  string; audit labels against existing keys where they exist (previous
  label audit `bb7b973b` helps). Remember: en.json is parsed once at
  import — new English keys need a restart to render.
- **2.3** Test uplift: pytest for the gateway (`--live-writes` and shadow
  modes; route parsing; GS_FLAT_MAP overlay; api_key masking) using
  stdlib http test server — no live oMLX dependency.
- **2.4** Dead code, console.log sweep, `uplift-revert.sh` round-trip
  re-verification, README section in the fork.
- **Exit criterion:** fresh clone → deploy script → 100% green tests →
  working UI, documented steps only.

## Phase 3 — Dogfood: Uplift as the daily driver (local M5 Max laptop via tap)

- **3.1** Install shape (DECIDED 2026-09-13): fork the tap
  (jundot/homebrew-omlx → zviratko/homebrew-omlx) and add a differently
  named formula `omlx-uplift` (points at the fork repo) so it installs
  ALONGSIDE vanilla `omlx`. Runs on the LOCAL M5 Max laptop (daily
  inference driver); kocour stays dev/test. Separate `OMLX_BASE_PATH` +
  port while both run side by side; model dirs can be shared read-mostly
  after verifying oMLX doesn't lock/writethrough model caches across
  instances.
- **3.2** On the chosen instance, add the native `/uplift` static route
  (routes.py + .html media type) — first edit of upstream python code;
  requires restart, which is allowed on kocour only. Gateway becomes
  optional (dashboard talks to same-origin API; sim/SSE features detect
  absent gateway and degrade — already implemented).
- **3.3** Sync routine: `git fetch jundot main && git merge jundot/main`
  whenever upstream moves; run verification protocol from handoff doc;
  re-run deploy after merges touching admin static.
- **Exit criterion:** user runs Uplift daily for a week without asking
  for a missing classic feature.

## Phase 4 — Draft PR (parked; only when user says)

- **3.x** pre-PR: rebase `feat/uplift-dashboard` onto `jundot/main`,
  PR body ASD-STE100 style + attribution line, screenshots committed,
  split candidates: (a) dashboard static bundle + route, (b) request_log
  backend (see backend plan), (c) prune endpoint. One concern per PR.
- Draft PR opened as DRAFT, upstream review not expected soon.

## Phase 5 — Feedback loop

- Upstream or personal feedback → new card per change request under
  Phase 1's loop discipline. Backend features (request_log.py, /metrics,
  percentiles) have their own agreed design: separate SQLite file
  `request_log.sqlite3`, opt-in setting, ring buffer + batched writer.

---

## Decision records (2026-09-13, user)

- **D1 i18n:** FULL parity with the 9 locale files required before any PR.
  Phase 2 includes wiring `omlx/admin/i18n/*` (classic pattern; note the
  upstream en.json import-time cache quirk from skill notes).
- **D2 dogfood shape:** Homebrew tap from the fork. Fork the tap repo
  (jundot/homebrew-omlx → zviratko/homebrew-omlx); install ALONGSIDE
  vanilla via a differently-named formula (`omlx-uplift`) — same-named
  formulas from two taps cannot coexist. Target machine: the LOCAL
  M5 Max MacBook (128 GB) — the daily inference driver that travels to
  work. kocour (M1 Max, 32 GB) is dev/test only, reachable from home.
  Pitfall: two live instances share `~/.omlx` config dir — separate
  `OMLX_BASE_PATH` (or config dir env) while they run side by side.
- **D3 overnight mode:** fire before sleep, `/steer` wrap-up in the
  morning. One agent, long loop, NO subagent fan-out (local inference
  serializes anyway). Keep going as long as possible; stop only on the
  morning steer or a hard problem needing the user.

## Revised overnight protocol (v2 — fixes the three observed failures)

### Pre-flight snapshot (MANDATORY before each overnight fire)
Rollback anchor, done once at the start of the loop (first loop turn):
1. `git -C ~/git/omlx/worktrees/uplift status` must be clean; if dirty,
   commit WIP first (`wip(uplift): pre-overnight` ).
2. Tag + push the anchor: `git tag uplift-night-YYYYMMDD && git push
   origin uplift-night-YYYYMMDD` (anchor = last human-approved state).
3. Copy UI files + sandbox state to the rollback bundle:
   `~/hermes/TMP/uplift-rollback-YYYYMMDD/` = static/uplift/*,
   scripts/uplift-*.{py,sh}, findings JSON, and the mock's current mode
   (live/shadow). Restoring = copy back + re-run deploy script + restart
   gateway in the recorded mode.
4. Record the anchor SHA + bundle path at the TOP of the findings file
   (`"rollback": {...}` entry) so the morning wrap-up summary cites it.

Morning full rollback (user decides, ~2 min): `git reset --hard
uplift-night-YYYYMMDD` in the worktree + restore bundle + redeploy.
Per-commit undo also possible (anchor..HEAD is the night's worklist;
loop commits are one-per-finding so cherry-pick/revert granularity
survives).

Failure → countermeasure:
1. "claimed finished but change didn't work" ⇒ NEVER mark a finding fixed
   without: redeploy → curl served bytes contain the change → browser
   re-run of the EXACT repro from the finding entry → evidence line
   appended to the finding (`verified_at`, method). No evidence ⇒ still open.
2. "fix didn't fix the problem" ⇒ findings carry a written repro first
   (page, steps, expected vs actual); the repro IS the acceptance test.
   If 3 fix attempts on one finding fail, mark `needs-user` with the
   diagnosis and move on — no thrashing.
3. "not eager to go further" ⇒ emptiness is NOT a stop condition: when
   the queue is empty, run another FULL sweep (tests/uplift-qa.md) — the
   night only ends on the morning /steer. The goal text is mechanical and
   short (see below) so "stating the goal" is no longer the weak link.

Standing goal line to fire in the evening (paste as-is):
  /goal Run the uplift overnight loop from
  .hermes/plans/2026-09-13_uplift-to-production.md in the worktree
  ~/git/omlx/worktrees/uplift. First do the pre-flight snapshot (tag +
  rollback bundle). Then work Phase 1A parity tasks P1A-1..8 from the
  plan, then sweep per tests/uplift-qa.md and fix findings with evidence
  (protocol v2). Do not stop while the clock is before 06:45 unless
  blocked on the user. When everything is done, sweep again.

Note (user, 2026-09-13): live vs shadow on kocour is NOT a concern —
oMLX there is not mission critical and the uplift profile is isolated.
The loop may keep the gateway in whatever mode it started in.

Morning /steer "wrap up" means: finish the finding in hand, one last
quick sweep, redeploy, update docs/uplift-dashboard.md handoff, commit +
push, then post a summary: commits with one-liners, findings fixed with
evidence pointers, findings marked needs-user, and what to check first
over coffee.

## Long-run session mechanics (how Phase 1 overnight actually runs)

1. **Standing goal (`/goal`)** — the driver already seen this session
   ("[Continuing toward your standing goal]"). Goal text must carry the
   loop protocol + budget, e.g.: "Run the uplift QA sweep loop per
   .hermes/plans/…#1.2 until two consecutive clean sweeps or 07:00.
   Do not stop after one pass."
2. **delegate_task background children** for parallel read-only sweeps
   (e.g. per-page browser QA in parallel, code-quality scan) while the
   main loop fixes findings. Results arrive as new messages between turns.
3. **Kanban** — NOT available in this profile's toolset right now
   (no kanban tools wired). It is the right long-term fit for
   Phase 5's multi-agent pipeline (orchestrator + worker + reviewer
   cards, goal_mode for iterate-until-done). Set up when the user wants
   it: enable kanban on the gateway side, then `kanban-orchestrator`
   skill guides card creation. Until then, plan file + findings.json +
   todo_list is the equivalent board.
4. **Cron** (local output only in TUI sessions) — useful later for
   nightly regression runs saved to cron output, not for delivery.

## Decision cards for the user (answer before Phase 2/3 work starts)

- D1: i18n — wire 9 locales or declare EN-only? (2.2)
- D2: Phase 3 install shape A/B/C (3.1; recommendation: A)
- D3: overnight goal: enabled budget/stop time and whether live-writes
  mode stays ON during overnight runs (recommendation: shadow mode
  overnight, live only by day — protects real config from 3 a.m. edits).
