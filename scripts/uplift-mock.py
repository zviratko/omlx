#!/usr/bin/env python3
"""Uplift mock gateway: read-through proxy for the real oMLX admin API plus a
shadow write layer and simulated request-lifecycle data.

Architecture
  * GETs proxy to --upstream (real oMLX) when reachable; responses are merged
    with the shadow state so writes made through the mock are reflected.
  * ALL writes (POST/PUT) are intercepted here and NEVER forwarded upstream:
    a shadow override layer (load/unload/pin/settings) diverges from real
    state until cleared. GET /admin/api/mock/reset clears the shadow.
  * Observer thread polls upstream /stats every second and derives request
    lifecycle records (prefilling -> generating -> complete) from the real
    per-request rows, collecting genuine prompt/completion token samples for
    server-side percentiles.
  * Sim thread (--sim RATE, default 0.5/s) generates synthetic requests so
    the demo has traffic when the real server is idle. Records carry
    origin: real|sim.
  * Extra endpoints (shape previews for a future real backend):
      GET  /admin/api/requests            lifecycle records (+states)
      GET  /admin/api/requests/stream     SSE event stream
      GET  /admin/api/mock/info           gateway status (upstream, sim, overrides)
      POST /admin/api/mock/reset          clear shadow overrides + sim requests
      GET  /admin/api/stats               upstream stats + request_stats overlay

Stdlib only. Localhost dev/demo use — NOT production.

Run: python3 scripts/uplift-mock.py [--port 11437] [--upstream http://127.0.0.1:11435]
                                    [--sim 0.5]
UI:  http://127.0.0.1:11436/index.html   (defaults to this mock)
"""
import argparse
import json
import math
import os
import queue
import random
import string
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import omlx_settings_store as store_mod

START = time.time()
LOCK = threading.Lock()
RNG = random.Random(42)

ARGS = None                      # parsed CLI (set in main)
UPSTREAM = "http://127.0.0.1:11435"
UP_STATUS = {"ok": False, "last_error": None, "last_ok_ts": None, "polls": 0}
STORE = None                     # sandboxed settings/profile/template store (UpliftStore)

# ------------------------------------------------------------------ shadow
# model_id -> full upstream /admin/api/models entry (schema) under MODELS_BASE;
# overrides layered in MODELS_OVER: {loaded?, pinned?, settings:{...}?,
# loading_until?}. Shadow wins over base in merged views.
MODELS_BASE = {}                 # id -> upstream dict (latest successful fetch)
MODELS_OVER = {}                 # id -> override dict
FETCH = {"models_ts": 0.0}

# ------------------------------------------------------- request records
# id -> {id, model, origin: real|sim, state, queued_at, prefill_started,
#        generation_started, finished_at, prompt_tokens, completion_tokens,
#        cached_tokens, tps, error, seen_ts}
REQUESTS = {}
FINISHED_ORDER = []
EVENTS = []
EVENT_SUBS = []
COUNT = {"requests": 0, "prompt": 0, "completion": 0, "cached": 0, "errors": 0}
SIZES = {"prompt": [], "completion": []}
LATENCY = {"first_token_ms": [], "total_ms": []}
ORIGIN_COUNT = {"real": 0, "sim": 0}
LOGS_CACHE = {"ts": 0.0, "body": None}
REAL_IDLE_SECONDS = None         # upstream idle signal for info endpoint

# ---------------------------------------------- shadow tasks (dl/quant/up)
# id -> {id, kind, name, dest, status, progress, size, started_at, error}
SHADOW_TASKS = {}
TASK_DUR = 20.0                  # seconds a simulated download/quant/upload takes


def rid():
    return "".join(RNG.choices(string.hexdigits.lower(), k=12))


def emit(ev):
    ev.setdefault("ts", time.time())
    EVENTS.append(ev)
    if len(EVENTS) > 500:
        del EVENTS[:len(EVENTS) - 500]
    for q in list(EVENT_SUBS):
        try:
            q.put_nowait(ev)
        except Exception:
            pass


# ------------------------------------------------------------ http helpers
def upstream_get(path, timeout=4):
    req = urllib.request.Request(UPSTREAM + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def upstream_get_text(path, timeout=6):
    req = urllib.request.Request(UPSTREAM + path, headers={"Accept": "text/plain,*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


# ---------------------------------------------------------- shadow merging
def over(mid):
    return MODELS_OVER.setdefault(mid, {})


def effective_loaded(mid):
    o = MODELS_OVER.get(mid, {})
    if "loaded" in o:
        return o["loaded"]
    base = MODELS_BASE.get(mid, {})
    return bool(base.get("loaded")) or o.get("loading_until") is not None


def merge_model(base):
    mid = base["id"]
    o = MODELS_OVER.get(mid, {})
    m = dict(base)
    if o.get("loading_until") is not None:
        m["loaded"], m["is_loading"] = True, True
    else:
        m["loaded"] = effective_loaded(mid)
        m["is_loading"] = bool(base.get("is_loading")) and m["loaded"]
    m["pinned"] = o.get("pinned", base.get("pinned"))
    if m["loaded"]:
        est = base.get("estimated_size") or 0
        m["actual_size"] = base.get("actual_size") or est
        m["estimated_size"] = est or m["actual_size"]
    s = dict(base.get("settings") or {})
    s.update(o.get("settings") or {})
    # Sandboxed store is the settings source of truth for every model whose
    # record exists there (seeded copy of real settings + all gateway writes).
    if STORE is not None:
        st = STORE.get_settings(mid)
        st_pop = store_mod.to_dict_stripping_none(st)
        for k in store_mod.MODEL_DEFAULTS:
            if k in st_pop:
                s[k] = st_pop[k]
            else:
                s.pop(k, None)
        m["is_default"] = st.get("is_default", False)
        m["is_hidden"] = st.get("is_hidden", False)
        m["is_favorite"] = st.get("is_favorite", False)
        if st.get("model_alias"):
            m["model_alias"] = st["model_alias"]
        if st.get("display_name"):
            m["display_name"] = st["display_name"]
        if st.get("active_profile_name"):
            m["active_profile_name"] = st["active_profile_name"]
        if st.get("model_type_override"):
            m["model_type"] = st["model_type_override"]
        # Reflect store-driven pin in the fields the classic UI reads.
        if st.get("is_pinned"):
            m["pinned"] = True
    m["settings"] = s
    m["_shadow"] = bool(o) or (STORE is not None)
    return m


# ------------------------------------------------------------- observer
def observer_tick():
    """Poll upstream stats: refresh base, derive real request transitions."""
    global REAL_IDLE_SECONDS
    try:
        st = upstream_get("/admin/api/stats")
        UP_STATUS.update(ok=True, last_ok_ts=time.time(),
                         last_error=None, polls=UP_STATUS["polls"] + 1)
    except Exception as e:  # noqa: BLE001 - report, retry next tick
        UP_STATUS["last_error"] = f"{type(e).__name__}: {e}"
        UP_STATUS["ok"] = False
        return
    now = time.time()
    REAL_IDLE_SECONDS = st.get("active_models", {}).get("idle_seconds")
    seen_live = set()
    with LOCK:
        for m in st.get("active_models", {}).get("models", []):
            mid = m.get("id", "?")
            # prefilling rows: may be new (-> prefilling) or transitioning
            for row in m.get("prefilling", []) or []:
                r = observe_real(mid, row, "prefilling", now)
                if r:
                    seen_live.add(r["id"])
            for row in m.get("generating", []) or []:
                r = observe_real(mid, row, "generating", now)
                if r:
                    seen_live.add(r["id"])
            for wid in m.get("waiting", []) or []:
                wid = wid if isinstance(wid, str) else str(wid)
                if wid in REQUESTS and REQUESTS[wid]["state"] == "queued":
                    seen_live.add(wid)
                elif wid not in REQUESTS:
                    r = {"id": wid, "model": mid, "origin": "real", "state": "queued",
                         "queued_at": now, "prefill_started": None,
                         "generation_started": None, "finished_at": None,
                         "prompt_tokens": None, "completion_tokens": 0,
                         "cached_tokens": 0, "tps": None, "error": None,
                         "seen_ts": now}
                    REQUESTS[wid] = r
                    seen_live.add(wid)
                    emit({"type": "request", "id": wid, "model": mid,
                          "state": "queued", "origin": "real"})
        # Any real-origin request not seen live this tick finished -> complete.
        for rid_, r in list(REQUESTS.items()):
            if r["origin"] != "real" or rid_ in seen_live:
                continue
            if r["state"] in ("complete", "error"):
                continue
            r["state"], r["finished_at"] = "complete", now
            finish_stats(r)
            emit({"type": "request", "id": rid_, "model": r["model"],
                  "state": "complete", "origin": "real"})
        # Shadow load transitions (simulated load of an unloaded model).
        for mid, o in MODELS_OVER.items():
            lu = o.get("loading_until")
            if lu and now >= lu:
                o["loading_until"] = None
                o["loaded"] = True
                emit({"type": "model-ready", "id": mid})


def observe_real(mid, row, live_state, now):
    """Create or update a real-origin request record from an upstream row."""
    id_ = str(row.get("request_id") or row.get("id") or "")
    if not id_:
        return None
    prompt = row.get("prompt_tokens")
    generated = row.get("generated_tokens", 0) or 0
    tps = row.get("tokens_per_second")
    r = REQUESTS.get(id_)
    if r is None or r["origin"] != "real":
        r = {"id": id_, "model": mid, "origin": "real", "state": live_state,
             "queued_at": now, "prefill_started": now if live_state == "prefilling" else None,
             "generation_started": now if live_state == "generating" else None,
             "finished_at": None,
             "prompt_tokens": prompt if isinstance(prompt, (int, float)) else None,
             "completion_tokens": generated, "cached_tokens": 0,
             "tps": tps if isinstance(tps, (int, float)) else None,
             "error": None, "seen_ts": now}
        REQUESTS[id_] = r
        emit({"type": "request", "id": id_, "model": mid, "state": live_state,
              "origin": "real"})
    else:
        r["seen_ts"] = now
        if r["state"] == "complete" or r["state"] == "error":
            r["state"], r["finished_at"] = live_state, None
        if live_state == "generating" and r["generation_started"] is None:
            r["generation_started"] = now
            if r["state"] != "generating":
                r["state"] = "generating"
                emit({"type": "request", "id": id_, "model": mid,
                      "state": "generating", "origin": "real"})
        if isinstance(prompt, (int, float)):
            r["prompt_tokens"] = prompt
        if generated:
            r["completion_tokens"] = generated
        if isinstance(tps, (int, float)):
            r["tps"] = tps
    return r


def finish_stats(r):
    """Account a finished request (both origins)."""
    if r.get("_accounted"):
        return
    r["_accounted"] = True
    ORIGIN_COUNT[r["origin"]] += 1
    COUNT["requests"] += 1
    pt = r.get("prompt_tokens") or 0
    ct = r.get("completion_tokens") or 0
    COUNT["prompt"] += pt
    COUNT["completion"] += ct
    COUNT["cached"] += r.get("cached_tokens") or 0
    COUNT["errors"] += r["state"] == "error"
    if pt:
        SIZES["prompt"].append(pt)
    if ct:
        SIZES["completion"].append(ct)
    if r.get("generation_started") and r.get("queued_at"):
        LATENCY["first_token_ms"].append((r["generation_started"] - r["queued_at"]) * 1000)
    if r.get("finished_at") and r.get("queued_at"):
        LATENCY["total_ms"].append((r["finished_at"] - r["queued_at"]) * 1000)
    if len(SIZES["prompt"]) > 5000:
        SIZES["prompt"].pop(0)
    if len(SIZES["completion"]) > 5000:
        SIZES["completion"].pop(0)
    for k in LATENCY:
        if len(LATENCY[k]) > 5000:
            LATENCY[k].pop(0)
    FINISHED_ORDER.append(r["id"])
    while len(FINISHED_ORDER) > 400:
        old = FINISHED_ORDER.pop(0)
        r2 = REQUESTS.get(old)
        if r2 and r2["state"] in ("complete", "error"):
            REQUESTS.pop(old, None)


# ------------------------------------------------------------- simulation
def sim_tick(speed):
    """Advance synthetic requests (works even with upstream idle/offline)."""
    now = time.time()
    with LOCK:
        loaded = [mid for mid in MODELS_BASE
                  if effective_loaded(mid) and MODELS_OVER.get(mid, {}).get("loading_until") is None]
        if not loaded and not MODELS_BASE:
            # Upstream never answered (offline demo): invent two placeholder
            # models so the lifecycle sim still runs.
            MODELS_BASE.setdefault("demo-model-a", {"id": "demo-model-a",
                                                    "estimated_size": 8_000_000_000, "loaded": True})
            MODELS_BASE.setdefault("demo-model-b", {"id": "demo-model-b",
                                                    "estimated_size": 2_000_000_000, "loaded": True})
            loaded = ["demo-model-a", "demo-model-b"]
        if loaded and RNG.random() < min(0.95, 1.25 * speed):
            mid = RNG.choice(loaded)
            prompt = int(math.exp(RNG.uniform(4.5, 11.7)))
            target = int(math.exp(RNG.uniform(1.5, 7.6)))
            r = {"id": rid(), "model": mid, "origin": "sim", "state": "queued",
                 "queued_at": now, "prefill_started": None, "generation_started": None,
                 "finished_at": None, "prompt_tokens": prompt, "completion_tokens": 0,
                 "cached_tokens": int(prompt * min(1.0, RNG.uniform(0.0, 0.95))),
                 "tps": None, "error": None, "seen_ts": now,
                 "target_tokens": target,
                 "prefill_s": max(0.05, prompt / RNG.uniform(900, 2600)),
                 "gen_rate": RNG.uniform(38, 65)}
            REQUESTS[r["id"]] = r
            emit({"type": "request", "id": r["id"], "model": mid,
                  "state": "queued", "origin": "sim"})
        for r in list(REQUESTS.values()):
            if r["origin"] != "sim":
                continue
            if r["state"] == "queued":
                wait_s = RNG.uniform(0.05, 1.8) if RNG.random() < 0.3 else 0.15
                if now - r["queued_at"] > wait_s:
                    active = sum(1 for x in REQUESTS.values() if x["state"] == "prefilling")
                    if active < 2:
                        r["state"], r["prefill_started"] = "prefilling", now
                        emit({"type": "request", "id": r["id"], "model": r["model"],
                              "state": "prefilling", "origin": "sim"})
            elif r["state"] == "prefilling":
                if now - r["prefill_started"] > r["prefill_s"] / max(speed, 0.05):
                    if RNG.random() < 0.03:
                        r["state"], r["error"] = "error", "prefill OOM (simulated)"
                    else:
                        r["state"], r["generation_started"] = "generating", now
                    emit({"type": "request", "id": r["id"], "model": r["model"],
                          "state": r["state"], "origin": "sim"})
            elif r["state"] == "generating":
                elapsed = now - r["generation_started"]
                r["completion_tokens"] = min(r["target_tokens"], int(elapsed * r["gen_rate"]))
                r["tps"] = round(r["gen_rate"] * RNG.uniform(0.97, 1.03), 1)
                if RNG.random() < 0.004:
                    r["state"], r["error"] = "error", "generation aborted (simulated)"
                elif r["completion_tokens"] >= r["target_tokens"]:
                    r["state"] = "complete"
                else:
                    continue
                emit({"type": "request", "id": r["id"], "model": r["model"],
                      "state": r["state"], "origin": "sim"})
            if r["state"] in ("complete", "error") and not r.get("_accounted"):
                r["finished_at"] = now
                finish_stats(r)


def sim_clock():
    while True:
        time.sleep(0.2)
        sim_tick(ARGS.sim)


def model_clock():
    """Shadow load transition timer for simulated loads (observer also checks,
    this covers the no-upstream case)."""
    while True:
        time.sleep(1)
        now = time.time()
        with LOCK:
            for mid, o in MODELS_OVER.items():
                lu = o.get("loading_until")
                if lu and now >= lu:
                    o["loading_until"] = None
                    o["loaded"] = True
                    emit({"type": "model-ready", "id": mid})


def base_models_refresh():
    """Fetch the real models list (schema + settings) periodically."""
    while True:
        try:
            data = upstream_get("/admin/api/models")
            with LOCK:
                MODELS_BASE.clear()
                for m in data.get("models", []):
                    MODELS_BASE[m["id"]] = m
                FETCH["models_ts"] = time.time()
        except Exception as e:  # noqa: BLE001
            UP_STATUS["last_error"] = f"models: {type(e).__name__}: {e}"
        time.sleep(10)


# ----------------------------------------------------------------- stats
def percentile(values, p):
    if not values:
        return None
    s = sorted(values)
    idx = (p / 100) * (len(s) - 1)
    lo, hi = math.floor(idx), math.ceil(idx)
    return s[lo] if lo == hi else s[lo] + (s[hi] - s[lo]) * (idx - lo)


def pct_block(values):
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    return {"n": len(vals), "avg": round(sum(vals) / len(vals), 1),
            "p50": round(percentile(vals, 50), 1), "p90": round(percentile(vals, 90), 1),
            "p95": round(percentile(vals, 95), 1), "p99": round(percentile(vals, 99), 1),
            "max": round(max(vals), 1)}


def request_stats_overlay():
    return {
        "source": "gateway(real-observed+simulated)",
        "observed_real": ORIGIN_COUNT["real"],
        "simulated": ORIGIN_COUNT["sim"],
        "prompt_tokens": pct_block(SIZES["prompt"]),
        "completion_tokens": pct_block(SIZES["completion"]),
        "first_token_ms": pct_block(LATENCY["first_token_ms"]),
        "total_ms": pct_block(LATENCY["total_ms"]),
        "errors_total": COUNT["errors"],
    }


def build_stats():
    """Upstream stats with shadow adjustments + request_stats overlay."""
    st = upstream_get("/admin/api/stats")
    now = time.time()
    with LOCK:
        st.setdefault("active_models", {}).setdefault("models", [])
        am = st["active_models"]
        upstream_ids = {m["id"] for m in am["models"]}
        kept, removed_size = [], 0
        for m in am["models"]:
            if effective_loaded(m["id"]):
                kept.append(m)
            else:
                removed_size += m.get("actual_size") or 0
        # Shadow loads of models that are NOT actually loaded upstream:
        # inject a synthetic active-model row so the UI shows it working.
        for mid, o in MODELS_OVER.items():
            if mid in upstream_ids or not effective_loaded(mid):
                continue
            base = MODELS_BASE.get(mid, {})
            size = base.get("estimated_size") or 0
            kept.append({"id": mid, "estimated_size": size, "actual_size": size,
                         "actual_size_formatted": f"{size/1e9:.2f} GB",
                         "pinned": o.get("pinned", base.get("pinned", False)),
                         "is_loading": o.get("loading_until") is not None,
                         "loading_elapsed_seconds": round(now - (o.get("load_started") or now), 1),
                         "loading_estimated_seconds": 5, "loading_remaining_seconds_estimate": None,
                         "active_requests": 0, "waiting_requests": 0, "waiting": [],
                         "activities": [],
                         "prefilling": [{"request_id": r["id"],
                                         "prompt_tokens": r["prompt_tokens"],
                                         "progress": 0.5} for r in REQUESTS.values()
                                        if r["model"] == mid and r["state"] == "prefilling"],
                         "generating": [{"request_id": r["id"],
                                         "prompt_tokens": r["prompt_tokens"],
                                         "generated_tokens": r["completion_tokens"],
                                         "tokens_per_second": r["tps"] or 0.0,
                                         "elapsed_seconds": round(now - (r["generation_started"] or now), 2)}
                                        for r in REQUESTS.values()
                                        if r["model"] == mid and r["state"] == "generating"],
                         "idle_seconds": None, "ttl_remaining_seconds": None,
                         "dflash": None, "cluster": None})
        am["models"] = kept
        if removed_size:
            used = am.get("model_memory_used") or 0
            am["model_memory_used"] = max(0, used - removed_size)
            mp = am.get("memory_pressure") or {}
            if mp.get("current_bytes"):
                mp["current_bytes"] = max(0, mp["current_bytes"] - removed_size)
        st["request_stats"] = request_stats_overlay()
    return st


# --------------------------------------------------------------- handlers
SETTINGS_TYPES = {"temperature": (float, 0.0, 2.0), "top_p": (float, 0.0, 1.0),
                  "max_tokens": (int, 1, 262144), "ttl_seconds": (int, 30, 86400),
                  "top_k": (int, 0, 1000), "repetition_penalty": (float, 0.0, 5.0),
                  "min_p": (float, 0.0, 1.0), "presence_penalty": (float, -4.0, 4.0)}
SETTINGS_ENUMS = {"reasoning_effort": ["auto", "none", "low", "medium", "high", "xhigh", "max"]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self, path, cache_key=None):
        """GET through to upstream; merge overrides where applicable."""
        try:
            if path.startswith("/admin/api/models"):
                with LOCK:
                    merged = [merge_model(m) for m in MODELS_BASE.values()]
                return self._json({"models": merged, "_gateway": {"fetched": FETCH["models_ts"]}})
            if path.startswith("/admin/api/logs"):
                now = time.time()
                c = LOGS_CACHE
                if now - c["ts"] > 3 or c["body"] is None:
                    c["body"] = upstream_get_text(path)
                    c["ts"] = now
                try:
                    return self._json(json.loads(c["body"]))
                except json.JSONDecodeError:
                    return self._json({"logs": c["body"]})
            return self._json(upstream_get(path))
        except Exception as e:  # noqa: BLE001
            return self._json({"detail": f"upstream unreachable: {e}", "_gateway_offline": True}, 502)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        p = u.path
        if p == "/admin/api/stats":
            try:
                self._json(build_stats())
            except Exception as e:  # noqa: BLE001
                self._json({"detail": f"upstream unreachable: {e}",
                            "request_stats": request_stats_overlay(),
                            "_gateway_offline": True}, 502)
        elif p == "/admin/api/requests":
            self._json(self._requests_payload(int(q.get("limit", ["40"])[0])))
        elif p == "/admin/api/requests/stream":
            self._sse()
        elif p == "/admin/api/mock/info":
            with LOCK:
                self._json({"upstream": UPSTREAM, **UP_STATUS,
                            "sim_rate": ARGS.sim,
                            "observed_real": ORIGIN_COUNT["real"],
                            "simulated": ORIGIN_COUNT["sim"],
                            "overrides": {k: {kk: vv for kk, vv in v.items()
                                              if vv is not None and vv != {}}
                                          for k, v in MODELS_OVER.items()},
                            "models_base": len(MODELS_BASE),
                            "uptime_seconds": round(time.time() - START, 1)})
        elif p == "/admin/api/models" or p.startswith("/admin/api/models?"):
            self._proxy(p + ("?" + u.query if u.query else ""))
        elif p.startswith("/admin/api/models/") and p.endswith("/settings"):
            mid = urllib.parse.unquote(p[len("/admin/api/models/"):-len("/settings")])
            with LOCK:
                base = MODELS_BASE.get(mid)
                if not base and mid not in MODELS_OVER:
                    self._json({"detail": "unknown model"}, 404)
                else:
                    s = dict((base or {}).get("settings") or {})
                    s.update(MODELS_OVER.get(mid, {}).get("settings") or {})
                    if STORE is not None:
                        s = store_mod.to_dict_stripping_none(STORE.get_settings(mid))
                    self._json({"id": mid, "settings": s})
        elif p.startswith("/admin/api/models/") and p.endswith("/profiles"):
            mid = urllib.parse.unquote(p[len("/admin/api/models/"):-len("/profiles")])
            self._json({"profiles": STORE.list_profiles(mid) if STORE else []})
        elif p == "/admin/api/profile-templates":
            self._json({"templates": STORE.list_templates() if STORE else []})
        elif p == "/admin/api/profile-fields":
            self._json({"universal": list(store_mod.UNIVERSAL_PROFILE_FIELDS),
                        "model_specific": list(store_mod.MODEL_SPECIFIC_PROFILE_FIELDS)})
        elif p.startswith("/admin/api/models/") and p.endswith("/generation_config"):
            # Read-only passthrough to the real server.
            self._proxy(p)
        elif p == "/admin/api/logs":
            self._proxy(p + ("?" + u.query if u.query else ""))
        elif p.startswith("/admin/api/hf/tasks") or p.startswith("/admin/api/ms/tasks") \
                or p.startswith("/admin/api/oq/tasks") or p.startswith("/admin/api/upload/tasks"):
            # sub-page task lists: upstream + shadow tasks merged in
            try:
                base = upstream_get(p + ("?" + u.query if u.query else ""))
            except Exception:
                base = {"tasks": []}
            kinds = {"hf": ("download",), "ms": ("download",),
                     "oq": ("quantize",), "upload": ("upload",)}
            key = p.split("/")[3]     # /admin/api/<kind>/tasks
            upstream_rows = [t for t in (base.get("tasks") or [])
                             if t.get("kind", key) in kinds[key]]
            with LOCK:
                rows = upstream_rows + [dict(t) for t in SHADOW_TASKS.values()
                                        if t["kind"] == key]
            rows = sorted(rows, key=lambda t: t.get("started_at", 0), reverse=True)[:50]
            self._json({"tasks": rows})
        elif p.startswith("/admin/api/hf/task/") or p.startswith("/admin/api/oq/task/") \
                or p.startswith("/admin/api/upload/task/"):
            tid = urllib.parse.unquote(p.rsplit("/", 1)[-1])
            with LOCK:
                t = SHADOW_TASKS.get(tid)
            if t:
                self._json({"task": dict(t)})
            else:
                self._proxy(p)
        elif p.startswith("/admin/api/model-settings-index"):
            # what the prune dialog needs: stored ids that no longer exist on disk
            known = set(MODELS_BASE) | set(MODELS_OVER)
            with LOCK:
                stored = STORE.known_model_ids() if STORE else set()
                alias_of = {mid: s.get("model_alias")
                            for mid, s in (STORE._settings.items() if STORE else [])}
            aliases = {a for a in alias_of.values() if a}
            orphans = sorted(stored - known - aliases)
            entries = sorted(
                ({"id": mid, "alias": alias_of.get(mid)} for mid in stored),
                key=lambda e: e["id"])
            self._json({"stored": len(stored), "known": len(known),
                        "orphans": orphans, "entries": entries})
        else:
            self._proxy(p + ("?" + u.query if u.query else ""))

    def _requests_payload(self, limit):
        with LOCK:
            rows = sorted(REQUESTS.values(), key=lambda r: r["queued_at"], reverse=True)[:limit]
            keys = ("id", "model", "origin", "state", "queued_at", "prefill_started",
                    "generation_started", "finished_at", "prompt_tokens",
                    "completion_tokens", "cached_tokens", "tps", "error")
            return {"requests": [{k: r.get(k) for k in keys} for r in rows],
                    "states": ["queued", "prefilling", "generating", "complete", "error"]}

    def _sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self._cors()
        self.close_connection = True
        self.send_header("Connection", "close")
        self.end_headers()
        q = queue.Queue()
        EVENT_SUBS.append(q)
        try:
            deadline = time.time() + 1800
            for ev in EVENTS[-20:]:
                self.wfile.write(f"data: {json.dumps(ev)}\n\n".encode())
            while time.time() < deadline:
                try:
                    ev = q.get(timeout=10)
                    self.wfile.write(f"data: {json.dumps(ev)}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
        except (BrokenPipeError, OSError):
            pass
        finally:
            EVENT_SUBS.remove(q)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return None

    # ---- writes: always intercepted, NEVER forwarded upstream ----
    def do_PUT(self):
        p = urlparse(self.path).path
        parts = p.split("/")
        if p.startswith("/admin/api/models/") and p.endswith("/settings"):
            mid = urllib.parse.unquote(p[len("/admin/api/models/"):-len("/settings")])
            body = self._read_body()
            if body is None:
                return self._json({"detail": "invalid JSON"}, 400)
            if STORE is None:
                return self._json({"detail": "store unavailable"}, 503)
            base = MODELS_BASE.get(mid) or {}
            if mid not in MODELS_BASE and mid not in MODELS_OVER:
                return self._json({"detail": "unknown model"}, 404)
            prev = STORE.get_settings(mid)
            alias_taken = STORE.alias_taken(MODELS_BASE)
            with LOCK:
                try:
                    merged = STORE.update_from_admin(
                        mid, body, alias_taken, base.get("config_model_type", ""))
                except RuntimeError as e:
                    if str(e).startswith("alias-conflict:"):
                        return self._json({"detail": f"Alias '{str(e)[15:]}' is already used"}, 400)
                    raise
                except ValueError as e:
                    return self._json({"detail": str(e)}, 400)
            # management flags ride through the same endpoint; sync shadow so
            # the classic pin badge agrees immediately
            if "is_pinned" in body:
                over(mid)["pinned"] = bool(body["is_pinned"])
            sig_before = store_mod.engine_signature(prev)
            sig_after = store_mod.engine_signature(merged)
            loaded = effective_loaded(mid)
            requires_reload = loaded and sig_before != sig_after
            emit({"type": "settings", "id": mid, "changed": list(body),
                  "requires_reload": requires_reload})
            return self._json({
                "success": True, "model_id": mid,
                "settings": store_mod.to_dict_stripping_none(merged),
                "model_type": merged.get("model_type_override") or base.get("model_type"),
                "engine_type": base.get("engine_type"),
                "requires_reload": requires_reload,
                "auto_unloaded": False, "auto_reloaded": False,
                "_shadow": True})
        # PUT /api/models/{id}/profiles/{name}  (update)
        if len(parts) >= 7 and parts[1] == "admin" and parts[3] == "models" and parts[5] == "profiles":
            mid = urllib.parse.unquote(parts[4])
            name = urllib.parse.unquote(parts[6])
            body = self._read_body() or {}
            if STORE is None:
                return self._json({"detail": "store unavailable"}, 503)
            try:
                updated = STORE.update_profile(
                    mid, name, new_name=body.get("new_name"),
                    display_name=body.get("display_name"), description=body.get("description"),
                    settings=body.get("settings"), source_template=body.get("source_template"),
                    expose_as_model=body.get("expose_as_model"), api_name=body.get("api_name"))
            except store_mod.InvalidProfileNameError as e:
                return self._json({"detail": str(e)}, 400)
            except ValueError as e:
                return self._json({"detail": str(e)}, 409)
            if updated is None:
                return self._json({"detail": f"Profile not found: {name}"}, 404)
            if body.get("also_save_as_template") and body.get("settings") is not None:
                STORE.upsert_template(updated["name"],
                                      display_name=updated.get("display_name"),
                                      description=updated.get("description"),
                                      settings=body["settings"])
            emit({"type": "profile", "id": mid, "action": "update", "name": updated["name"]})
            return self._json({"profile": updated})
        # PUT /api/profile-templates/{name}
        if len(parts) == 5 and parts[1] == "admin" and parts[3] == "profile-templates":
            name = urllib.parse.unquote(parts[4])
            body = self._read_body() or {}
            if STORE is None:
                return self._json({"detail": "store unavailable"}, 503)
            try:
                rec = STORE.upsert_template(name,
                                            display_name=body.get("display_name"),
                                            description=body.get("description"),
                                            settings=body.get("settings"))
            except store_mod.InvalidProfileNameError as e:
                return self._json({"detail": str(e)}, 400)
            return self._json({"template": rec})
        return self._json({"detail": "write endpoint not provided by gateway", "_intercepted": True}, 404)

    def do_POST(self):
        p = urlparse(self.path).path
        parts = p.split("/")
        if p.startswith("/admin/api/mock/reset"):
            with LOCK:
                MODELS_OVER.clear()
                for rid_ in [k for k, r in REQUESTS.items()
                             if r["origin"] == "sim" and r["state"] in ("complete", "error")]:
                    REQUESTS.pop(rid_, None)
            emit({"type": "mock-reset"})
            return self._json({"ok": True, "cleared": "shadow overrides + finished sim requests"})
        if len(parts) == 6 and parts[1] == "admin" and parts[3] == "requests" and parts[-1] == "cancel":
            id_ = urllib.parse.unquote(parts[4])
            with LOCK:
                r = REQUESTS.get(id_)
                if not r:
                    return self._json({"detail": "unknown request"}, 404)
                if r["state"] in ("complete", "error"):
                    return self._json({"detail": "already finished"}, 409)
                if r["origin"] != "sim":
                    return self._json({"detail": "real requests live in oMLX; "
                                       "gateway cannot cancel them (no upstream route)"}, 501)
                r["state"], r["error"] = "error", "cancelled (simulated)"
                r["finished_at"] = time.time()
                finish_stats(r)
            emit({"type": "request", "id": id_, "model": r["model"],
                  "state": "error", "origin": "sim", "cancelled": True})
            return self._json({"id": id_, "state": r["state"]})
        if len(parts) >= 6 and parts[3] == "models" and parts[-1] in ("load", "unload", "pin", "unpin"):
            mid = urllib.parse.unquote(parts[4])
            action = parts[-1]
            with LOCK:
                if mid not in MODELS_BASE and mid not in MODELS_OVER:
                    return self._json({"detail": "unknown model"}, 404)
                o = over(mid)
                if action == "load":
                    if effective_loaded(mid):
                        return self._json({"id": mid, "loaded": True, "note": "already loaded"})
                    base = MODELS_BASE.get(mid, {})
                    if base.get("loaded"):
                        # Really loaded upstream: shadow must not pretend otherwise.
                        o.pop("loaded", None)
                    else:
                        o["loading_until"] = time.time() + 5
                        o["load_started"] = time.time()
                        o["loaded"] = False
                    emit({"type": "model-load", "id": mid})
                elif action == "unload":
                    busy = any(r["model"] == mid and r["state"] in
                               ("queued", "prefilling", "generating") for r in REQUESTS.values())
                    if busy:
                        return self._json({"detail": "model busy — active requests"}, 409)
                    o["loaded"] = False
                    o.pop("loading_until", None)
                    emit({"type": "model-unload", "id": mid})
                elif action in ("pin", "unpin"):
                    o["pinned"] = action == "pin"
                    if STORE is not None:
                        STORE.set_flag(mid, "is_pinned", action == "pin")
                    emit({"type": "model-pin", "id": mid, "pinned": o["pinned"]})
                return self._json({"id": mid, "loaded": effective_loaded(mid),
                                   "pinned": o.get("pinned"), "_shadow": True})
        # POST /api/models/{id}/profiles  (create)
        if len(parts) == 6 and parts[1] == "admin" and parts[3] == "models" and parts[5] == "profiles":
            mid = urllib.parse.unquote(parts[4])
            body = self._read_body() or {}
            if STORE is None:
                return self._json({"detail": "store unavailable"}, 503)
            try:
                rec = STORE.save_profile(
                    mid, body.get("name"), display_name=body.get("display_name"),
                    description=body.get("description"), settings=body.get("settings") or {},
                    source_template=body.get("source_template"),
                    expose_as_model=bool(body.get("expose_as_model")), api_name=body.get("api_name"))
            except store_mod.InvalidProfileNameError as e:
                return self._json({"detail": str(e)}, 400)
            except ValueError as e:
                return self._json({"detail": str(e)}, 409)
            if body.get("also_save_as_template"):
                STORE.upsert_template(rec["name"], display_name=rec.get("display_name"),
                                      description=rec.get("description"),
                                      settings=body.get("settings") or {})
            emit({"type": "profile", "id": mid, "action": "create", "name": rec["name"]})
            return self._json({"profile": rec})
        # POST /api/models/{id}/profiles/{name}/apply
        if len(parts) == 8 and parts[1] == "admin" and parts[3] == "models" \
                and parts[5] == "profiles" and parts[7] == "apply":
            mid, name = urllib.parse.unquote(parts[4]), urllib.parse.unquote(parts[6])
            if STORE is None:
                return self._json({"detail": "store unavailable"}, 503)
            base = MODELS_BASE.get(mid) or {}
            applied = STORE.apply_profile(mid, name, base.get("config_model_type", ""))
            if applied is None:
                return self._json({"detail": f"Profile not found: {name}"}, 404)
            emit({"type": "profile", "id": mid, "action": "apply", "name": name})
            return self._json({"model_id": mid,
                               "settings": store_mod.to_dict_stripping_none(applied)})
        # POST /api/profile-templates  (create/upsert)
        if len(parts) == 4 and parts[1] == "admin" and parts[3] == "profile-templates":
            body = self._read_body() or {}
            if STORE is None:
                return self._json({"detail": "store unavailable"}, 503)
            try:
                rec = STORE.upsert_template(body.get("name"),
                                            display_name=body.get("display_name"),
                                            description=body.get("description"),
                                            settings=body.get("settings") or {})
            except store_mod.InvalidProfileNameError as e:
                return self._json({"detail": str(e)}, 400)
            return self._json({"template": rec})
        # ---- sub-page writes: downloader / quantizer / uploader (shadow) ----
        if p in ("/admin/api/hf/download", "/admin/api/ms/download"):
            body = self._read_body() or {}
            repo = body.get("repo_id") or body.get("model") or "?"
            tid = start_shadow_task("hf" if "hf" in p else "ms",
                                    "downloading", repo,
                                    dest=f"~/.omlx-models/{repo}")
            return self._json({"task_id": tid, "status": "downloading", "_shadow": True})
        if p == "/admin/api/oq/start":
            body = self._read_body() or {}
            name = body.get("model_name") or (body.get("model_path") or "?").rsplit("/", 1)[-1]
            tid = start_shadow_task("oq", "quantizing", name,
                                    dest=f"~/.omlx-models/{name}-oq")
            return self._json({"task_id": tid, "status": "quantizing", "_shadow": True})
        if p == "/admin/api/upload/start":
            body = self._read_body() or {}
            name = body.get("model_name") or (body.get("model_path") or "?").rsplit("/", 1)[-1]
            tid = start_shadow_task("upload", "uploading", name,
                                    dest=body.get("target_repo") or f"hf:{name}")
            return self._json({"task_id": tid, "status": "uploading", "_shadow": True})
        if p.endswith("/cancel") and "/admin/api/" in p:
            tid = urllib.parse.unquote(p.rsplit("/", 2)[-2])
            with LOCK:
                t = SHADOW_TASKS.get(tid)
                if t:
                    t["status"] = "cancelled"
            if t:
                return self._json({"cancelled": True, "task_id": tid})
        # ---- prune model settings (removes config for removed models) ----
        if p == "/admin/api/prune-model-settings":
            body = self._read_body() or {}
            ids = [str(x) for x in (body.get("ids") or [])]
            if not ids:
                return self._json({"detail": "ids required"}, 400)
            if STORE is None:
                return self._json({"detail": "store unavailable"}, 503)
            with LOCK:
                removed = STORE.prune_settings(ids)
                removed_t = STORE.prune_templates(removed)
            emit({"type": "prune", "removed": removed, "templates": removed_t})
            return self._json({"removed": removed, "removed_templates": removed_t})
        return self._json({"detail": "write endpoint not provided by gateway", "_intercepted": True}, 404)

    def do_DELETE(self):
        p = urlparse(self.path).path
        parts = p.split("/")
        if len(parts) >= 7 and parts[1] == "admin" and parts[3] == "models" and parts[5] == "profiles":
            mid, name = urllib.parse.unquote(parts[4]), urllib.parse.unquote(parts[6])
            if STORE and STORE.delete_profile(mid, name):
                emit({"type": "profile", "id": mid, "action": "delete", "name": name})
                return self._json({"deleted": True, "name": name})
            return self._json({"detail": f"Profile not found: {name}"}, 404)
        if len(parts) == 5 and parts[1] == "admin" and parts[3] == "profile-templates":
            name = urllib.parse.unquote(parts[4])
            if STORE and STORE.delete_template(name):
                return self._json({"deleted": True, "name": name})
            return self._json({"detail": f"Template not found: {name}"}, 404)
        return self._json({"detail": "write endpoint not provided by gateway", "_intercepted": True}, 404)


def tasks_tick():
    """Advance shadow download/quantize/upload tasks; complete them at 100%."""
    now = time.time()
    done = []
    with LOCK:
        for t in SHADOW_TASKS.values():
            if t["status"] not in ("downloading", "quantizing", "uploading", "queued"):
                continue
            elapsed = now - t["started_at"]
            t["progress"] = min(0.99, elapsed / t.get("duration", TASK_DUR))
            t["status_next"] = None
            if elapsed >= t.get("duration", TASK_DUR):
                t["status"] = "complete"
                t["progress"] = 1.0
                done.append(dict(t))
    for t in done:
        emit({"type": t["kind"], "id": t["id"], "name": t["name"],
              "status": "complete"})


def start_shadow_task(kind, status, name, dest="", size=0):
    tid = rid()
    with LOCK:
        SHADOW_TASKS[tid] = {"id": tid, "kind": kind, "name": name, "dest": dest,
                             "status": status, "progress": 0.0, "size": size,
                             "started_at": time.time(), "error": None}
    emit({"type": kind, "id": tid, "name": name, "status": status})
    return tid


def observer_loop():
    while True:
        observer_tick()
        tasks_tick()
        time.sleep(1)


def main():
    global ARGS, UPSTREAM, STORE
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=11437)
    ap.add_argument("--upstream", default="http://127.0.0.1:11435")
    ap.add_argument("--sim", type=float, default=0.5,
                    help="synthetic requests per second (0 = observe real only)")
    ap.add_argument("--base", default=os.path.expanduser("~/hermes/TMP/omlx-uplift-data"),
                    help="sandbox dir for model_settings.json / model_profiles.json / "
                         "global_templates.json (NEVER ~/.omlx)")
    ap.add_argument("--seed", action="store_true",
                    help="seed the sandbox from the real ~/.omlx files if missing (copy, read-only on originals)")
    ARGS = ap.parse_args()
    UPSTREAM = ARGS.upstream
    if ARGS.seed:
        real_base = os.environ.get("OMLX_BASE_PATH") or os.path.expanduser("~/.omlx")
        copied = store_mod.seed_from_real(real_base, ARGS.base)
        if copied:
            print(f"seeded sandbox from {real_base}: {', '.join(copied)}")
    STORE = store_mod.UpliftStore(ARGS.base)
    print(f"settings store: sandbox {ARGS.base} "
          f"({len(STORE.known_model_ids())} records, "
          f"{len(STORE.list_templates())} templates)")
    threading.Thread(target=observer_loop, daemon=True).start()
    threading.Thread(target=sim_clock, daemon=True).start()
    threading.Thread(target=model_clock, daemon=True).start()
    threading.Thread(target=base_models_refresh, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    print(f"uplift gateway on http://127.0.0.1:{ARGS.port} -> upstream {UPSTREAM} (sim {ARGS.sim}/s)")
    srv.serve_forever()


if __name__ == "__main__":
    main()
