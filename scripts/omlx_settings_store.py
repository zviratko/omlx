"""Sandboxed replica of oMLX per-model settings + profiles + templates.

This module reimplements the behaviour of omlx/model_settings.py
(ModelSettings dataclass + ModelSettingsManager), omlx/model_profiles.py
(field allowlists, name validation, profile merge semantics) and the admin
API write semantics relevant to the Uplift dashboard mock gateway. It is a
faithful copy for DEMO/DEV use only — it never imports mlx and NEVER writes
to the real ~/.omlx: all persistence goes to the --base directory given to
UpliftStore(base_path=...).

File layout, JSON shape and save semantics (indent=2, atomic replace,
version key, None-stripping to_dict) match the originals so the produced
model_settings.json / model_profiles.json / global_templates.json could be
loaded by the real server unchanged.
"""

import json
import os
import re
import threading
import unicodedata
from datetime import datetime, timezone

SETTINGS_VERSION = 1
PROFILES_VERSION = 1
TEMPLATES_VERSION = 1

# ---------------------------------------------------------------- field schema
# Field names + defaults captured from omlx.model_settings.ModelSettings
# (84 fields, dataclass order). A None default means Optional.
_FIELDS = [
    ("max_context_window", None),
    ("max_tokens", None),
    ("temperature", None),
    ("top_p", None),
    ("top_k", None),
    ("repetition_penalty", None),
    ("min_p", None),
    ("presence_penalty", None),
    ("force_sampling", False),
    ("max_tool_result_tokens", None),
    ("chat_template_kwargs", None),
    ("forced_ct_kwargs", None),
    ("ttl_seconds", None),
    ("model_type_override", None),
    ("model_alias", None),
    ("index_cache_freq", None),
    ("enable_thinking", None),
    ("qwen4_ple_ssd_offload", False),
    ("deepseek_v41_engram_ssd_offload", False),
    ("deepseek_v41_ced_prefill_enabled", False),
    ("preserve_thinking", None),
    ("cache_reasoning_output", None),
    ("thinking_budget_enabled", False),
    ("thinking_budget_tokens", None),
    ("reasoning_parser", None),
    ("guided_grammar_enabled", False),
    ("guided_grammar", None),
    ("turboquant_kv_enabled", False),
    ("turboquant_kv_bits", 4),
    ("turboquant_skip_last", True),
    ("qwen35_ane_prefill_enabled", False),
    ("qwen35_ane_prefill_sequence_length", 2048),
    ("qwen35_ane_prefill_tail_padding_min_tokens", 0),
    ("qwen35_ane_prefill_fraction", None),
    ("qwen35_ane_prefill_shared_fraction", 1.0),
    ("qwen35_ane_prefill_fused_down", False),
    ("qwen35_ane_prefill_max_layers", 64),
    ("qwen35_ane_prefill_dual_ane", True),
    ("qwen35_ane_prefill_gdn", True),
    ("qwen35_ane_prefill_gdn_fraction", 0.5),
    ("qwen35_ane_prefill_gdn_max_layers", 48),
    ("qwen35_ane_prefill_cpu_enabled", False),
    ("qwen35_ane_prefill_cpu_fraction", 0.135),
    ("qwen35_ane_prefill_cpu_down_fraction", 0.0),
    ("qwen35_ane_prefill_cpu_gdn_fraction", 0.0),
    ("qwen35_ane_prefill_cpu_threads", 8),
    ("qwen35_ane_prefill_cpu_shared_resource", True),
    ("qwen35_oq_a8_enabled", False),
    ("qwen35_oq_a8_min_tokens", 128),
    ("moe_expert_offload_enabled", False),
    ("moe_expert_offload_resident_fraction", 0.25),
    ("specprefill_enabled", False),
    ("specprefill_draft_model", None),
    ("specprefill_keep_pct", None),
    ("specprefill_threshold", None),
    ("dflash_enabled", False),
    ("dflash_draft_model", None),
    ("dflash_draft_quant_enabled", None),
    ("dflash_draft_quant_weight_bits", None),
    ("dflash_draft_quant_activation_bits", None),
    ("dflash_draft_quant_group_size", None),
    ("dflash_max_ctx", None),
    ("dflash_in_memory_cache", True),
    ("dflash_in_memory_cache_max_entries", 4),
    ("dflash_in_memory_cache_max_bytes", 8589934592),
    ("dflash_ssd_cache", False),
    ("dflash_ssd_cache_max_bytes", 21474836480),
    ("dflash_draft_window_size", None),
    ("dflash_draft_sink_size", 0),
    ("dflash_block_size", None),
    ("dflash_verify_mode", None),
    ("mtp_enabled", False),
    ("mtp_num_draft_tokens", None),
    ("vlm_mtp_enabled", False),
    ("vlm_mtp_draft_model", None),
    ("vlm_mtp_draft_block_size", None),
    ("is_pinned", False),
    ("is_default", False),
    ("is_hidden", False),
    ("is_favorite", False),
    ("trust_remote_code", False),
    ("display_name", None),
    ("description", None),
    ("active_profile_name", None),
]

MODEL_DEFAULTS = {name: d for name, d in _FIELDS}
FIELD_NAMES = {name for name, _ in _FIELDS}

# ---------------------------------------------------------------- field lists
# From omlx/model_profiles.py — keep in sync when the server schema changes.
UNIVERSAL_PROFILE_FIELDS = (
    "max_context_window", "max_tokens", "temperature", "top_p", "top_k",
    "min_p", "repetition_penalty", "presence_penalty", "force_sampling",
    "enable_thinking", "preserve_thinking", "cache_reasoning_output",
    "thinking_budget_enabled", "thinking_budget_tokens", "reasoning_parser",
    "guided_grammar_enabled", "guided_grammar", "max_tool_result_tokens",
    "chat_template_kwargs", "forced_ct_kwargs",
)
MODEL_SPECIFIC_PROFILE_FIELDS = (
    "turboquant_kv_enabled", "turboquant_kv_bits", "turboquant_skip_last",
    "qwen35_ane_prefill_enabled", "qwen35_ane_prefill_sequence_length",
    "qwen35_ane_prefill_tail_padding_min_tokens", "qwen35_ane_prefill_fraction",
    "qwen35_ane_prefill_shared_fraction", "qwen35_ane_prefill_fused_down",
    "qwen35_ane_prefill_max_layers", "qwen35_ane_prefill_dual_ane",
    "qwen35_ane_prefill_gdn", "qwen35_ane_prefill_gdn_fraction",
    "qwen35_ane_prefill_gdn_max_layers", "qwen35_ane_prefill_cpu_enabled",
    "qwen35_ane_prefill_cpu_fraction", "qwen35_ane_prefill_cpu_down_fraction",
    "qwen35_ane_prefill_cpu_gdn_fraction", "qwen35_ane_prefill_cpu_threads",
    "qwen35_ane_prefill_cpu_shared_resource",
    "qwen35_oq_a8_enabled", "qwen35_oq_a8_min_tokens",
    "moe_expert_offload_enabled", "moe_expert_offload_resident_fraction",
    "specprefill_enabled", "specprefill_draft_model", "specprefill_keep_pct",
    "specprefill_threshold",
    "dflash_enabled", "dflash_draft_model", "dflash_draft_quant_enabled",
    "dflash_draft_quant_weight_bits", "dflash_draft_quant_activation_bits",
    "dflash_draft_quant_group_size", "dflash_max_ctx",
    "dflash_in_memory_cache", "dflash_in_memory_cache_max_entries",
    "dflash_in_memory_cache_max_bytes", "dflash_ssd_cache",
    "dflash_ssd_cache_max_bytes", "dflash_draft_window_size",
    "dflash_draft_sink_size", "dflash_block_size", "dflash_verify_mode",
    "mtp_enabled", "mtp_num_draft_tokens",
    "vlm_mtp_enabled", "vlm_mtp_draft_model", "vlm_mtp_draft_block_size",
    "index_cache_freq",
)
EXCLUDED_FROM_PROFILES = frozenset({
    "is_pinned", "is_default", "is_hidden", "is_favorite", "display_name",
    "description", "model_alias", "model_type_override", "active_profile_name",
    "ttl_seconds", "qwen4_ple_ssd_offload", "deepseek_v41_engram_ssd_offload",
    "deepseek_v41_ced_prefill_enabled", "trust_remote_code",
})
UNIVERSAL_SET = frozenset(UNIVERSAL_PROFILE_FIELDS)
PROFILE_SET = UNIVERSAL_SET | frozenset(MODEL_SPECIFIC_PROFILE_FIELDS)

MODEL_TYPE_VALID = {"llm", "vlm", "embedding", "reranker",
                    "audio_stt", "audio_tts", "audio_sts"}
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


class InvalidProfileNameError(ValueError):
    pass


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def validate_profile_name(name):
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise InvalidProfileNameError(
            f"Invalid profile/template name: {name!r}. "
            f"Must match ^[a-z0-9][a-z0-9_-]{{0,31}}$")


def slugify_profile_api_name(value, fallback="profile"):
    text = unicodedata.normalize("NFKD", value or "")
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"[^a-z0-9_-]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-_")
    if not text or not re.match(r"^[a-z0-9]", text):
        text = fallback
    text = text[:32].rstrip("-_")
    if not text or not NAME_RE.match(text):
        text = fallback[:32].rstrip("-_") or "profile"
    return text


def _filter_and_sanitize(data, allowed):
    return {k: v for k, v in data.items()
            if k in allowed and v is not None and v != ""}


def filter_universal_fields(data):
    return _filter_and_sanitize(data or {}, UNIVERSAL_SET)


def filter_profile_fields(data):
    return _filter_and_sanitize(data or {}, PROFILE_SET)


# ---------------------------------------------------------------- conflicts
def vlm_mtp_processor_conflicts(data):
    names = []
    if data.get("guided_grammar_enabled") or data.get("guided_grammar"):
        names.append("guided_grammar_enabled")
    rep = data.get("repetition_penalty")
    if rep is not None and rep != 1.0:
        names.append("repetition_penalty")
    pres = data.get("presence_penalty")
    if pres is not None and pres != 0.0:
        names.append("presence_penalty")
    return names


def resolve_vlm_mtp_conflicts(data):
    if not data.get("vlm_mtp_enabled"):
        return data, []
    conflicts = vlm_mtp_processor_conflicts(data)
    if not conflicts:
        return data, []
    resolved = dict(data)
    resolved["vlm_mtp_enabled"] = False
    return resolved, conflicts


def resolve_qwen35_prefill_conflicts(data):
    if not (data.get("qwen35_oq_a8_enabled") and data.get("qwen35_ane_prefill_enabled")):
        return data, []
    resolved = dict(data)
    resolved["qwen35_oq_a8_enabled"] = False
    return resolved, ["qwen35_ane_prefill_enabled"]


def validate_moe_expert_offload(settings):
    fraction = settings.get("moe_expert_offload_resident_fraction", 0.25)
    if (isinstance(fraction, bool)
            or not isinstance(fraction, (int, float))
            or not 0 < fraction <= 1):
        raise ValueError("moe_expert_offload_resident_fraction must be in (0, 1]")
    if settings.get("moe_expert_offload_enabled") and any(
            settings.get(k) for k in ("mtp_enabled", "vlm_mtp_enabled", "dflash_enabled")):
        raise ValueError(
            "MoE expert offload cannot be combined with Lightning MTP, "
            "VLM MTP, or DFlash; disable speculative decoding first.")


def model_post_init_check(d):
    """Mirror of ModelSettings.__post_init__ exclusivity rules."""
    if d.get("qwen35_oq_a8_enabled") and int(d.get("qwen35_oq_a8_min_tokens", 128) or 0) < 1:
        raise ValueError("qwen35_oq_a8_min_tokens must be at least 1")
    if d.get("qwen35_oq_a8_enabled") and d.get("qwen35_ane_prefill_enabled"):
        raise ValueError(
            "qwen35_oq_a8_enabled and qwen35_ane_prefill_enabled cannot both "
            "be True; choose one Qwen3.5 prefill accelerator per model")
    if d.get("mtp_enabled") and d.get("dflash_enabled"):
        raise ValueError(
            "mtp_enabled and dflash_enabled cannot both be True; choose one "
            "speculative-decoding path per model")
    if d.get("vlm_mtp_enabled"):
        for name in ("dflash_enabled", "specprefill_enabled", "mtp_enabled",
                     "turboquant_kv_enabled"):
            if d.get(name):
                raise ValueError(
                    f"vlm_mtp_enabled and {name} cannot both be True; "
                    "choose one speculative path per model")
        pc = vlm_mtp_processor_conflicts(d)
        if pc:
            raise ValueError(
                "vlm_mtp_enabled cannot be combined with "
                + ", ".join(pc)
                + "; these settings require per-request logits processors, "
                  "which the vlm_mtp decode path does not apply")
    validate_moe_expert_offload(d)


def normalize_settings(data):
    """Coerce a dict to the full field set (from_dict + defaults applied) and
    run __post_init__. turboquant_kv_bits normalises to float (the upstream
    normalization fix)."""
    d = {k: v for k, v in (data or {}).items() if k in FIELD_NAMES}
    out = {}
    for name, default in _FIELDS:
        out[name] = d[name] if name in d else (
            copy_default(default) if isinstance(default, (list, dict)) else default)
    if out.get("turboquant_kv_bits") is not None:
        out["turboquant_kv_bits"] = float(out["turboquant_kv_bits"])
    model_post_init_check(out)
    return out


def copy_default(default):
    import copy as _copy
    return _copy.deepcopy(default)


def to_dict_stripping_none(settings):
    return {k: v for k, v in settings.items() if v is not None}


# ------------------------------------------------------- engine-signature keys
# Subset of _engine_runtime_signature relevant for the requires_reload answer.
def engine_signature(settings):
    data = settings
    def has_value(key):
        v = data.get(key)
        return v is not None and v != ""
    sig = []
    def add(k, v): sig.append((k, repr(v)))
    def norm_freq():
        try:
            f = int(data.get("index_cache_freq")) if data.get("index_cache_freq") is not None else None
        except (TypeError, ValueError):
            return None
        return f if f is not None and f >= 2 else None
    add("trust_remote_code", bool(data.get("trust_remote_code", False)))
    add("index_cache_freq", norm_freq())
    mtp = bool(data.get("mtp_enabled", False)); add("mtp_enabled", mtp)
    if mtp: add("mtp_num_draft_tokens", data.get("mtp_num_draft_tokens"))
    tq = bool(data.get("turboquant_kv_enabled", False)); add("turboquant_kv_enabled", tq)
    if tq:
        add("turboquant_kv_bits", data.get("turboquant_kv_bits", 4))
        add("turboquant_skip_last", data.get("turboquant_skip_last", True))
    oq = bool(data.get("qwen35_oq_a8_enabled", False)); add("qwen35_oq_a8_enabled", oq)
    if oq: add("qwen35_oq_a8_min_tokens", data.get("qwen35_oq_a8_min_tokens", 128))
    ane = bool(data.get("qwen35_ane_prefill_enabled", False)); add("qwen35_ane_prefill_enabled", ane)
    if ane:
        add("qwen35_ane_prefill_sequence_length", data.get("qwen35_ane_prefill_sequence_length", 2048))
        add("qwen35_ane_prefill_fraction", data.get("qwen35_ane_prefill_fraction"))
    moe = bool(data.get("moe_expert_offload_enabled", False)); add("moe_expert_offload_enabled", moe)
    if moe: add("moe_expert_offload_resident_fraction", data.get("moe_expert_offload_resident_fraction", 0.25))
    spec = bool(data.get("specprefill_enabled", False)) and has_value("specprefill_draft_model")
    add("specprefill_enabled", spec)
    if spec:
        add("specprefill_draft_model", data.get("specprefill_draft_model"))
        add("specprefill_keep_pct", data.get("specprefill_keep_pct", 0.2))
        add("specprefill_threshold", data.get("specprefill_threshold"))
    dflash = bool(data.get("dflash_enabled", False)) and has_value("dflash_draft_model")
    add("dflash_enabled", dflash)
    if dflash:
        add("dflash_draft_model", data.get("dflash_draft_model"))
        add("dflash_draft_quant_enabled", bool(data.get("dflash_draft_quant_enabled", False)))
    vlm = bool(data.get("vlm_mtp_enabled", False)); add("vlm_mtp_enabled", vlm)
    if vlm:
        add("vlm_mtp_draft_model", data.get("vlm_mtp_draft_model"))
        add("vlm_mtp_draft_block_size", data.get("vlm_mtp_draft_block_size"))
    return tuple(sig)


DIFFUSION_TYPES = {"diffusion_gemma"}


def sanitize_diffusion(settings):
    """Mirror of _sanitize_diffusion_model_settings: strip unsupported knobs."""
    for k in ("top_p", "top_k", "min_p", "repetition_penalty", "presence_penalty"):
        settings[k] = None
    settings["force_sampling"] = False
    settings["enable_thinking"] = None
    settings["preserve_thinking"] = None
    settings["thinking_budget_enabled"] = False
    settings["thinking_budget_tokens"] = None
    settings["reasoning_parser"] = None
    settings["guided_grammar_enabled"] = False
    settings["guided_grammar"] = None
    unsupported = {"enable_thinking", "reasoning_effort", "preserve_thinking"}
    ctk = settings.get("chat_template_kwargs")
    if ctk:
        ctk = {k: v for k, v in ctk.items() if k not in unsupported}
        settings["chat_template_kwargs"] = ctk or None
    if settings.get("forced_ct_kwargs"):
        allowed = set(settings.get("chat_template_kwargs") or {})
        settings["forced_ct_kwargs"] = [k for k in settings["forced_ct_kwargs"]
                                        if k not in unsupported and k in allowed] or None


class UpliftStore:
    """ModelSettingsManager clone writing exclusively under base_path."""

    def __init__(self, base_path):
        self.base_path = str(base_path)
        os.makedirs(self.base_path, exist_ok=True)
        self.settings_file = os.path.join(self.base_path, "model_settings.json")
        self.profiles_file = os.path.join(self.base_path, "model_profiles.json")
        self.templates_file = os.path.join(self.base_path, "global_templates.json")
        self._lock = threading.RLock()
        self._settings = {}
        self._profiles = {}
        self._templates = {}
        self._load_all()

    # ---- persistence (file format identical to the real manager) ----
    def _load_json(self, path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return {}
        except (json.JSONDecodeError, OSError):
            return {}

    def _save_json(self, path, data):
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False, default=str)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

    def _load_all(self):
        data = self._load_json(self.settings_file)
        for mid, blob in (data.get("models") or {}).items():
            blob, _ = resolve_vlm_mtp_conflicts(blob)
            blob, _ = resolve_qwen35_prefill_conflicts(blob)
            try:
                self._settings[mid] = normalize_settings(blob)
            except ValueError:
                pass  # real manager logs and drops
        pdata = self._load_json(self.profiles_file)
        self._profiles = pdata.get("profiles") or {}
        tdata = self._load_json(self.templates_file)
        self._templates = tdata.get("templates") or {}

    def _save_settings(self):
        self._save_json(self.settings_file, {
            "version": SETTINGS_VERSION,
            "models": {mid: to_dict_stripping_none(s)
                       for mid, s in self._settings.items()}})

    def _save_profiles(self):
        self._save_json(self.profiles_file,
                        {"version": PROFILES_VERSION, "profiles": self._profiles})

    def _save_templates(self):
        self._save_json(self.templates_file,
                        {"version": TEMPLATES_VERSION, "templates": self._templates})

    # ---- settings ----
    def get_settings(self, model_id):
        with self._lock:
            cur = self._settings.get(model_id)
            return dict(cur) if cur else normalize_settings({})

    def set_settings(self, model_id, settings):
        with self._lock:
            if settings.get("is_default"):
                for mid, s in self._settings.items():
                    if mid != model_id:
                        s["is_default"] = False
            self._settings[model_id] = dict(settings)
            self._save_settings()

    def known_model_ids(self):
        with self._lock:
            return set(self._settings)

    def alias_taken(self, base_models):
        """Names an alias may not take: aliases held by stored settings + all
        known model ids (routes.py rejects conflicts with both)."""
        with self._lock:
            aliases = {s["model_alias"] for s in self._settings.values() if s.get("model_alias")}
        aliases |= {m.get("model_alias") for m in base_models.values() if m.get("model_alias")}
        aliases |= set(base_models)
        return aliases

    # ---- admin PUT semantics (subset of routes.update_model_settings) ----
    def update_from_admin(self, model_id, payload, alias_taken, config_model_type=""):
        """Apply a ModelSettingsRequest-style payload.

        `sent` = keys present in payload (distinguishes null-clear from
        don't-touch). Returns (settings, unknown_keys). Raises ValueError for
        schema conflicts, RuntimeError('alias-conflict:...') for alias issues.
        """
        with self._lock:
            current = dict(self.get_settings(model_id))
            sent = set(payload)
            diffusion = str(config_model_type or "").lower().replace("-", "_") in DIFFUSION_TYPES

            def want(key):  # admin payload key -> current settings key
                return key in sent

            if want("model_alias"):
                alias = (payload["model_alias"] or "").strip() or None
                own = current.get("model_alias")
                taken = set(alias_taken) - {model_id, own}
                if alias and alias in taken:
                    raise RuntimeError(f"alias-conflict:{alias}")
                current["model_alias"] = alias
            if want("model_type_override"):
                v = payload["model_type_override"] or None
                if v is not None and v not in MODEL_TYPE_VALID:
                    raise ValueError(f"Invalid model_type_override: {v}")
                current["model_type_override"] = v
            for flag in ("is_default", "is_favorite", "is_hidden"):
                if want(flag):
                    value = bool(payload[flag])
                    if flag == "is_default" and value:
                        for mid, s in self._settings.items():
                            if mid != model_id:
                                s["is_default"] = False
                    current[flag] = value
            simple = ("max_context_window", "max_tokens", "temperature", "top_p",
                      "top_k", "repetition_penalty", "min_p", "presence_penalty",
                      "force_sampling", "ttl_seconds", "reasoning_parser",
                      "chat_template_kwargs", "forced_ct_kwargs",
                      "turboquant_kv_enabled", "qwen35_ane_prefill_enabled",
                      "qwen35_ane_prefill_sequence_length",
                      "qwen35_ane_prefill_tail_padding_min_tokens",
                      "qwen35_ane_prefill_fraction",
                      "qwen35_ane_prefill_shared_fraction",
                      "qwen35_ane_prefill_fused_down",
                      "qwen35_ane_prefill_max_layers", "qwen35_ane_prefill_dual_ane",
                      "qwen35_ane_prefill_gdn", "qwen35_ane_prefill_gdn_fraction",
                      "qwen35_ane_prefill_gdn_max_layers",
                      "qwen35_ane_prefill_cpu_enabled", "qwen35_ane_prefill_cpu_fraction",
                      "qwen35_ane_prefill_cpu_down_fraction",
                      "qwen35_ane_prefill_cpu_gdn_fraction",
                      "qwen35_ane_prefill_cpu_threads",
                      "qwen35_ane_prefill_cpu_shared_resource",
                      "qwen4_ple_ssd_offload", "deepseek_v41_engram_ssd_offload",
                      "specprefill_enabled", "specprefill_draft_model",
                      "specprefill_keep_pct", "specprefill_threshold",
                      "dflash_enabled", "dflash_draft_model",
                      "dflash_draft_quant_enabled", "dflash_draft_quant_weight_bits",
                      "dflash_draft_quant_activation_bits",
                      "dflash_draft_quant_group_size", "dflash_max_ctx",
                      "dflash_in_memory_cache", "dflash_in_memory_cache_max_entries",
                      "dflash_in_memory_cache_max_bytes", "dflash_ssd_cache",
                      "dflash_ssd_cache_max_bytes", "dflash_draft_window_size",
                      "dflash_draft_sink_size", "dflash_block_size",
                      "dflash_verify_mode", "mtp_enabled", "mtp_num_draft_tokens",
                      "vlm_mtp_enabled", "vlm_mtp_draft_model",
                      "vlm_mtp_draft_block_size", "turboquant_kv_bits",
                      "turboquant_skip_last", "trust_remote_code",
                      "moe_expert_offload_enabled",
                      "moe_expert_offload_resident_fraction",
                      "qwen35_oq_a8_enabled", "qwen35_oq_a8_min_tokens",
                      "enable_thinking", "preserve_thinking")
            for k in simple:
                if want(k):
                    current[k] = payload[k]
            if want("deepseek_v41_ced_prefill_enabled"):
                is_v41 = str(config_model_type or "").lower().replace("-", "_") == "deepseek_v41"
                current["deepseek_v41_ced_prefill_enabled"] = bool(
                    payload["deepseek_v41_ced_prefill_enabled"] and is_v41)
            if want("max_tool_result_tokens"):
                current["max_tool_result_tokens"] =                     payload["max_tool_result_tokens"] if (payload["max_tool_result_tokens"] or 0) > 0 else None
            if want("enable_index_cache_legacy"):  # unused; index handled below
                pass
            if want("index_cache_freq"):
                v = payload["index_cache_freq"]
                current["index_cache_freq"] = v if v and int(v) >= 2 else None
            if want("thinking_budget_enabled"):
                current["thinking_budget_enabled"] = bool(payload["thinking_budget_enabled"])
            if want("thinking_budget_tokens"):
                v = payload["thinking_budget_tokens"]
                current["thinking_budget_tokens"] = v if v and int(v) > 0 else None
            if want("guided_grammar_enabled"):
                current["guided_grammar_enabled"] = bool(payload["guided_grammar_enabled"])
            if want("guided_grammar"):
                current["guided_grammar"] = payload["guided_grammar"] or None
            if want("qwen35_oq_a8_min_tokens"):
                v = payload["qwen35_oq_a8_min_tokens"]
                if isinstance(v, bool) or not isinstance(v, int) or v < 1:
                    raise ValueError("oQ A8 min tokens must be at least 1.")
                current["qwen35_oq_a8_min_tokens"] = v
            if payload.get("qwen35_oq_a8_enabled"):
                ct = str(config_model_type or "").lower().replace("-", "_")
                if not ct.startswith(("qwen3_5", "qwen3_6", "qwen3_8")):
                    raise ValueError("oQ A8 prefill kernels are supported only for Qwen3.5/3.6/3.8 models.")

            # No silent conflict resolution here: exclusivity violations raise
            # via normalize_settings (like the UI's own pre-save alerts).
            # Legacy conflict resolution (drop oq / drop vlm_mtp) applies at
            # FILE LOAD and on profile apply, mirroring the real manager.
            merged = normalize_settings(current)      # __post_init__ rules
            if diffusion:
                sanitize_diffusion(merged)
            self._settings[model_id] = merged
            self._save_settings()
            return dict(merged)

    # ---- flags used by load/unload/pin endpoints ----
    def set_flag(self, model_id, flag, value=True):
        with self._lock:
            cur = dict(self.get_settings(model_id))
            if flag == "is_default" and value:
                for mid, s in self._settings.items():
                    if mid != model_id:
                        s["is_default"] = False
            cur[flag] = bool(value)
            self._settings[model_id] = cur
            self._save_settings()

    # ---- profiles (manager semantics) ----
    def list_profiles(self, model_id):
        with self._lock:
            return [dict(p) for p in (self._profiles.get(model_id) or {}).values()]

    def save_profile(self, model_id, name, display_name=None, description=None,
                     settings=None, source_template=None, expose_as_model=False,
                     api_name=None, reserved_model_ids=None):
        validate_profile_name(name)
        with self._lock:
            per = self._profiles.setdefault(model_id, {})
            if name in per:
                raise ValueError(f"Profile already exists: {name}")
            record = {
                "name": name,
                "display_name": display_name or name,
                "api_name": slugify_profile_api_name(api_name or display_name or name),
                "description": description or "",
                "created_at": utcnow(), "updated_at": utcnow(),
                # Real manager filters on save (model_settings.save_profile)
                "settings": filter_profile_fields(settings or {}),
                "source_template": source_template,
                "expose_as_model": bool(expose_as_model),
            }
            per[name] = record
            self._save_profiles()
            return dict(record)

    def update_profile(self, model_id, name, new_name=None, display_name=None,
                       description=None, settings=None, source_template=None,
                       expose_as_model=None, api_name=None):
        with self._lock:
            per = self._profiles.get(model_id) or {}
            if name not in per:
                return None
            record = per[name]
            if new_name and new_name != name:
                validate_profile_name(new_name)
                if new_name in per:
                    raise ValueError(f"Profile already exists: {new_name}")
                del per[name]
                record["name"] = new_name
                if display_name is None:
                    record["display_name"] = new_name
            if display_name is not None: record["display_name"] = display_name
            if description is not None: record["description"] = description
            if settings is not None: record["settings"] = filter_profile_fields(settings)
            if source_template is not None: record["source_template"] = source_template
            if expose_as_model is not None: record["expose_as_model"] = bool(expose_as_model)
            if api_name is not None: record["api_name"] = slugify_profile_api_name(api_name)
            record["updated_at"] = utcnow()
            per[record["name"]] = record
            self._save_profiles()
            return dict(record)

    def delete_profile(self, model_id, name):
        with self._lock:
            per = self._profiles.get(model_id) or {}
            if name not in per:
                return False
            del per[name]
            # Real manager clears active_profile_name if it referenced this
            # profile (model_settings.py delete_profile).
            cur = self._settings.get(model_id)
            if cur and cur.get("active_profile_name") == name:
                cur = dict(cur)
                cur["active_profile_name"] = None
                self._settings[model_id] = cur
                self._save_settings()
            self._save_profiles()
            return True

    def apply_profile(self, model_id, name, config_model_type=""):
        """Universal fields: profile authoritative (absent -> default).
        Model-specific: additive overlay. Flags/identity preserved."""
        with self._lock:
            per = self._profiles.get(model_id) or {}
            if name not in per:
                return None
            prof_settings = per[name].get("settings") or {}
            current = dict(self.get_settings(model_id))
            diffusion = str(config_model_type or "").lower().replace("-", "_") in DIFFUSION_TYPES
            merged = {k: v for k, v in current.items() if k not in UNIVERSAL_SET}
            merged.update(filter_profile_fields(prof_settings))
            merged["active_profile_name"] = name
            merged, _ = resolve_vlm_mtp_conflicts(merged)
            merged, _ = resolve_qwen35_prefill_conflicts(merged)
            new = normalize_settings(merged)
            if diffusion:
                sanitize_diffusion(new)
            self._settings[model_id] = new
            self._save_settings()
            return dict(new)

    # ---- templates ----
    def list_templates(self):
        with self._lock:
            return [dict(t) for t in self._templates.values()]

    def upsert_template(self, name, display_name=None, description=None, settings=None):
        validate_profile_name(name)
        with self._lock:
            existing = self._templates.get(name)
            record = {
                "name": name,
                "display_name": display_name or (existing or {}).get("display_name") or name,
                "description": description if description is not None else (existing or {}).get("description"),
                "created_at": (existing or {}).get("created_at") or utcnow(),
                "updated_at": utcnow(),
                "settings": filter_universal_fields(settings) if settings is not None
                            else (existing or {}).get("settings") or {},
            }
            self._templates[name] = record
            self._save_templates()
            return dict(record)

    def delete_template(self, name):
        with self._lock:
            if name not in self._templates:
                return False
            del self._templates[name]
            self._save_templates()
            return True


def seed_from_real(real_base, sandbox_base):
    """Copy the real settings trio into the sandbox ONCE if missing.
    Read-only on the real files."""
    import shutil
    copied = []
    os.makedirs(sandbox_base, exist_ok=True)
    for fname in ("model_settings.json", "model_profiles.json", "global_templates.json"):
        src = os.path.join(str(real_base), fname)
        dst = os.path.join(str(sandbox_base), fname)
        if os.path.exists(src) and not os.path.exists(dst):
            shutil.copy2(src, dst)
            copied.append(fname)
    return copied
