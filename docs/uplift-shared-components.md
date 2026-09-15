# Uplift ↔ Classic shared-component register (R11)

Every file/surface the Uplift dashboard touches, with its status. Rule:
anything `needs-change` is a NOT-YET until the user signs it off.

| Component | Status | How |
|---|---|---|
| `omlx/admin/routes.py` | additive-changed | New `/admin/uplift` + `/admin/uplift/{path}` GET routes (redirect-to-slash, cookie auth via `require_admin`, traversal guard, `no-store` on HTML). No existing route, template, or schema touched. |
| `omlx/admin/static/uplift/*` | untouched by classic | Uplift's own bundle (index.html, uplift.js, core.js, modelspec.js, uplift.css, vendor/uPlot). Lives under the static dir but classic never references these paths. |
| `omlx/admin/templates/**` | untouched | Uplift serves static HTML; no Jinja template changes. |
| `omlx/admin/i18n/*` | untouched so far | Uplift is EN-only until P1B-1/2 wire `t()`. New keys will be additive files/keys only; classic's existing keys stay byte-identical. |
| `omlx/admin/static/js/dashboard.js`, `css/*` | untouched | Classic bundle verified byte-identical after the uplift route landed (diffed served `dashboard.js`, 2026-09-16). |
| `/admin/api/*` routes | untouched (read/write through existing ones) | Uplift calls models/settings/profiles/logs/hf/oq APIs exactly like classic. `model-settings-index` + `/api/profiles` are mock-gateway-only; direct mode degrades to 0 stored/missing (known, docs/server-plan.md). |
| `omlx/model_settings.py` | untouched | Uplift writes only upstream-schema keys (extra keys are 400-forbidden upstream). |
| Settings file `~/.omlx/settings.json` | shared, semantics preserved | Same flat/nested payloads classic uses; P1A-7 interop test proves a Uplift no-op save leaves the file byte-identical. |

## Opt-in behaviour

- Classic stays at `/admin/dashboard`; Uplift lives at `/admin/uplift/`.
  Both served by one oMLX process at the same time; no redirects between them.
- Removing `omlx/admin/static/uplift/` (or the two routes) leaves classic
  fully functional — the routes only 404 then; nothing else imports them.
- Deleting the route block is the whole uninstall for the server side.

## needs-user (nothing yet blocked)

- None. Future P1B i18n work must not reword classic's keys; new uplift
  keys go into the same locale JSONs additively.
