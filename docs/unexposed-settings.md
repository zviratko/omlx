# Unexposed settings candidates (R10-15 audit)

Audited 2026-09-15 against `omlx/model_settings.py` (84 fields) and
`omlx/settings.py`, diffed against every key string referenced in
`omlx/admin/static/uplift/uplift.js` + `modelspec.js`. Classic dashboard
parity was checked separately.

## Model settings — real gaps (candidate for the editor ADVANCED area)

| key | type/default | meaning | classic UI? | verdict |
|---|---|---|---|---|
| `mtp_num_draft_tokens` | int / None | Max chained MTP draft tokens per verify cycle (speculative depth). None = model default (3 on DeepSeek-V4, Qwen3.5/3.6). Adaptive controller picks 1..max; set 1 for fixed depth-1. | no | **EXPOSED** 2026-09-15 — child of MTP toggle in the editor; server route validates range + model compatibility. |
| `cache_reasoning_output` | bool / None | Cache `think` output for the next turn. None = auto (when history keeps it). | no | **BLOCKED upstream**: not a field of `UpdateModelSettingsRequest` in installed 0.7.0.dev2 routes.py — PUT rejects it (`extra_forbidden`). Needs an upstream route field before the widget can ship. |
| `preserve_thinking` | bool / None | Keep `think` blocks in historical turns. None = auto when the template supports it. NOTE: uplift exposes it via the kwargs Add menu AND the editor omits a direct widget (modelspec.js lists it); classic comment says classic modal has no widget either. | no | already reachable (kwargs row). Direct widget optional. |
| `is_pinned` | bool / False | Keep model loaded in memory across idle eviction (persisted flag). Distinct from the row PINNED lamp which calls the runtime `pin`/`unpin` action + UI-order flag. | partly | needs care: decide semantics before exposing (see notes). |
| `display_name`, `description` | str / None | Admin metadata for the model. | list shows display_name | LOW: nice-to-have Basic fields. |
| `active_profile_name` | str / None | Currently applied profile (bookkeeping written by profile-apply routes). | n/a | internal, do not edit by hand. |
| `chat_template_kwargs`, `forced_ct_kwargs` | dict/list | The raw kwargs pair — uplift edits them through the kwargs entry editor. | yes | covered (ctKwargEntries). |

## Server settings — real gaps

| key | type/default | meaning | verdict |
|---|---|---|---|
| `cors_origins` | list `["*"]` | CORS allow-list. | EXPOSE (Advanced, comma-separated text). |
| `memory.soft_threshold` / `hard_threshold` | 0.85 / 0.95 | Memory pressure eviction thresholds. uplift exposes `memory_guard_tier` / `prefill_memory_guard` / custom ceiling instead; raw thresholds are what tiers compute from — expose only if a custom tier needs numbers. |
| `memory.prefill_safe_zone_ratio` / `prefill_min_chunk_tokens` | 0.8 / 32 | Prefill memory headroom knobs. LOW (same tier story). |
| `logging.log_dir` / `retention_days` | None / 7 | Log location + rotation. EXPOSE (Advanced) — harmless, useful. |
| `integrations.web_search_*` (provider, brave key, searxng url, ddgs backends, content mode/truncate) | various | Web-search tool config. The LIVE box is the real `~/.omlx`; a *key* field belongs behind the password-field widget. DEFER (needs secret-safe widget). |
| `integrations.markitdown_*` | bool/str | Document-conversion endpoint knobs. LOW. |
| `auth.secret_key` / `sub_keys` | — | Auth material. DEFER (secret widget). |
| `cache.gdn_ssd_split_enabled` | None | GDN SSD split switch. | LOW (power-user). (`gdn_sidecar_state_dtype` already reachable via the gdn_sidecar_precision widget.) |

## Notes

- `pinned` in uplift's row lamp is the runtime pin action (load + order
  flag), NOT `ModelSettings.is_pinned` (keep-loaded-across-eviction).
  Same word, two concepts — don't wire them together without a decision.
- Classic payload compatibility: any new widget must write the same
  snake_case key inside `settings` — no renaming.
- Audit method is repeatable: parse `AnnAssign` fields from
  `model_settings.py`/`settings.py`, grep key strings in the uplift JS.
