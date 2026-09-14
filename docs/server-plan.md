# Server plan: retiring the mock gateway (R10-B0)

Audited 2026-09-15. Mock = `scripts/uplift-mock.py` (1413 lines) read-through
proxy in front of real oMLX (`--upstream`, :11435/:8000). Probes below were
made against the installed oMLX 0.7.0.dev2 on kocour (:8000; 401 = route
exists, needs cookie auth).

## Interoperability verdict (read this first)

- `ModelSettings.from_dict` **silently drops unknown keys**
  (`omlx/model_settings.py`, filters to `fields(cls)`), so uplift extras
  in a settings dict never corrupt the store but also never persist
  unknown keys implicitly.
- The admin **PUT settings route forbids unknown keys**
  (`UpdateModelSettingsRequest`, `ConfigDict(extra="forbid")` — proven
  live when `cache_reasoning_output` was rejected with
  `extra_forbidden`). Every uplift field must therefore exist in the
  upstream request schema before the editor can write it.
- Consequence: no secret side-channel for uplift-only keys. Anything new
  is a classic-compatible route/schema change (R10-B1 territory).

## Keep / replace table

| mock behaviour | upstream status | verdict |
|---|---|---|
| GET /admin/api/models, /stats, /global-settings, model settings, profiles (+CRUD), profile-templates, profile-fields, grammar/parsers, logs, hf/ms tasks | all exist upstream (401 with cookie auth) | **REPLACE** — pure proxy today |
| `/admin/static/omlx_preset.json` (classic grammar presets) | served natively by classic static dir | **REPLACE** — point uplift at the same URL |
| shadow write layer (load/unload/pin/settings overrides + `_shadow` badge) | sandbox-only feature | **KEEP** in mock; production goes direct-to-upstream (`?api=` or same-origin) |
| GS_FLAT_MAP (flat integrations_* -> nested global-settings) | upstream GET returns nested sections already; classic posts nested too | **REPLACE** — uplift should read/write nested `global-settings` shape; mock overlay exists only for shadow mode |
| api_key masking (`••••` on GET, echo-on-write) | upstream GET /admin/api/settings masks it too (classic relies on it) — verify during B1 | likely **REPLACE** with a passthrough; re-probe before deleting mock logic |
| POST /admin/api/models/<id>/pin + /unpin | **no upstream route** — mock translates to PUT `is_pinned` | **REPLACE**: drop the POST calls, write `is_pinned` via PUT settings (route accepts it) |
| GET /admin/api/requests + /requests/stream (live request lifecycle feed) | `/admin/api/requests` 404 upstream; stream mock-only (SSE sim) | **KEEP** (mock) / new upstream route is B1+ scope; Status page must degrade gracefully without it |
| /admin/api/mock/info, /mock/reset | harness endpoints | **KEEP** (mock only) |
| simulated disk deletes, tasks sandbox | mock-only | **KEEP** |

## R10-B1 work list (smallest first)

1. Serve `/uplift` (+ uplift.js/css) from oMLX itself — static route, same
   pattern classic uses (already planned as Phase 3.2).
2. Switch uplift to nested `global-settings` payloads; delete GS_FLAT_MAP
   from the mock afterwards.
3. Replace pin POSTs with `is_pinned` PUT settings; runtime pin/unload keep
   using existing load/unload routes.
4. Add `expose_as_model`/`api_name` visibility for stored profiles to
   `/admin/api/models` payload (or accept N profile GETs — current editor
   already does this; row alias tree caches 30 s).
5. Run UI against real :8000 with cookie auth from the login route; fix
   fallout; keep the mock as `?api=` sandbox fallback.

## Known gaps to respect

- Upstream 401s without login cookie — uplift's direct-API mode needs the
  same login flow classic uses (mock logs in via --api-key today).
- `cache_reasoning_output` needs a route field (see
  docs/unexposed-settings.md) — upstream change, not uplift-only.
- requests/stream has no upstream equivalent; Status page needs a graceful
  "feed unavailable" path when running without the mock.
