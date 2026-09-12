#!/usr/bin/env python3
"""Mock oMLX admin API for evaluating Uplift dashboard features that the real
backend does not expose yet: server-side percentiles, per-request lifecycle
(queued -> prefilling -> generating -> complete/error), SSE event stream, and
model admin writes (settings PUT, load/unload/pin).

Stdlib only. Localhost dev/demo use — NOT production.

Run:  python3 scripts/uplift-mock.py [--port 11437] [--speed 1.0]
Point Uplift at it:  http://127.0.0.1:11436/index.html?api=http://127.0.0.1:11437
"""
import argparse
import json
import math
import random
import string
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

START = time.time()
LOCK = threading.Lock()
RNG = random.Random(42)

# ---------------------------------------------------------------- world state
MODELS = {
    "Qwen3.8-Flash-Next-Uncensored-Mixed-omlx": {
        "size": 73_980_000_000 // 1000 * 1000, "pinned": True, "loaded": True,
        "settings": {"temperature": 0.7, "max_tokens": 4096, "ttl_seconds": 600,
                     "top_p": 0.9, "reasoning_effort": "auto"},
    },
    "Qwen3-VL-Embedding-2B-mlx-5bit": {
        "size": 2_780_000_000, "pinned": True, "loaded": True,
        "settings": {"temperature": 0.0, "max_tokens": 8192, "ttl_seconds": 300,
                     "top_p": 1.0, "reasoning_effort": "none"},
    },
    "jina-reranker-v3.5-mlx-q8": {
        "size": 1_670_000_000, "pinned": True, "loaded": True,
        "settings": {"temperature": 0.0, "max_tokens": 16, "ttl_seconds": 120,
                     "top_p": 1.0, "reasoning_effort": "none"},
    },
    "K2-Horizon-MoVA-36B-A4B": {
        "size": 21_400_000_000, "pinned": False, "loaded": False,
        "settings": {"temperature": 0.6, "max_tokens": 4096, "ttl_seconds": 600,
                     "top_p": 0.95, "reasoning_effort": "auto"},
    },
}
MEM_MAX = 110_000_000_000

# request_id -> record; record.state: queued|prefilling|generating|complete|error
REQUESTS = {}
FINISHED_ORDER = []           # ids of finished requests, oldest first
EVENTS = []                   # SSE queue: {type, ts, ...}
EVENT_SUBS = []               # list of queue.Queue
COUNT = {"requests": 0, "prompt": 0, "completion": 0, "cached": 0, "errors": 0}
# Full-population token-size samples (the metric the real backend lacks)
SIZES = {"prompt": [], "completion": []}
LATENCY = {"queue_ms": [], "first_token_ms": [], "total_ms": []}


def rid():
    return "".join(RNG.choices(string.hexdigits.lower(), k=12))


def load_sim():
    """Model-load flapping: occasionally load/unload the unpinned model."""
    while True:
        time.sleep(20)
        with LOCK:
            m = MODELS["K2-Horizon-MoVA-36B-A4B"]
            if not m["loaded"] and RNG.random() < 0.5:
                m["loaded"], m["loading_until"] = True, time.time() + RNG.uniform(4, 8)
                EVENTS.append({"type": "model-load", "id": "K2-Horizon-MoVA-36B-A4B",
                               "ts": time.time()})
            elif m["loaded"] and m.get("loading_until") is None and RNG.random() < 0.25:
                m["loaded"] = False
                EVENTS.append({"type": "model-unload", "id": "K2-Horizon-MoVA-36B-A4B",
                               "ts": time.time()})
            if m.get("loading_until") and time.time() > m["loading_until"]:
                m["loading_until"] = None
                EVENTS.append({"type": "model-ready", "id": "K2-Horizon-MoVA-36B-A4B",
                               "ts": time.time()})


def emit(ev):
    EVENTS.append(ev)
    if len(EVENTS) > 500:
        del EVENTS[:len(EVENTS) - 500]
    for q in list(EVENT_SUBS):
        try:
            q.put_nowait(ev)
        except Exception:
            pass


def request_sim(speed):
    """Spawn and advance requests through their lifecycle."""
    while True:
        time.sleep(0.2)
        now = time.time()
        with LOCK:
            loaded = [k for k, m in MODELS.items()
                      if m["loaded"] and not m.get("loading_until")]
            # spawn: roughly one request per 1.6s / speed
            if loaded and RNG.random() < 0.13 * speed:
                model = RNG.choice(loaded)
                prompt = int(math.exp(RNG.uniform(4.5, 11.7)))       # 90 .. 120k
                target = int(math.exp(RNG.uniform(1.5, 7.6)))        # 4 .. 2000
                r = {"id": rid(), "model": model, "state": "queued",
                     "queued_at": now, "prefill_started": None,
                     "generation_started": None, "finished_at": None,
                     "prompt_tokens": prompt,
                     "cached_tokens": int(prompt * min(1.0, RNG.uniform(0.0, 0.95))),
                     "completion_tokens": 0, "target_tokens": target,
                     "prefill_s": max(0.05, prompt / RNG.uniform(900, 2600)),
                     "gen_rate": RNG.uniform(38, 65),
                     "tps": None, "error": None}
                REQUESTS[r["id"]] = r
                emit({"type": "request", "id": r["id"], "model": model,
                      "state": "queued", "ts": now})
            # advance
            for r in list(REQUESTS.values()):
                if r["state"] == "queued":
                    wait_s = RNG.uniform(0.05, 1.8) if RNG.random() < 0.3 else 0.15
                    if now - r["queued_at"] > wait_s:
                        active = sum(1 for x in REQUESTS.values() if x["state"] == "prefilling")
                        if active < 2:
                            r["state"] = "prefilling"
                            r["prefill_started"] = now
                            emit({"type": "request", "id": r["id"], "model": r["model"],
                                  "state": "prefilling", "ts": now})
                elif r["state"] == "prefilling":
                    if now - r["prefill_started"] > r["prefill_s"] / speed:
                        if RNG.random() < 0.03:
                            r["state"], r["error"] = "error", "prefill OOM (simulated)"
                        else:
                            r["state"] = "generating"
                            r["generation_started"] = now
                        emit({"type": "request", "id": r["id"], "model": r["model"],
                              "state": r["state"], "ts": now})
                elif r["state"] == "generating":
                    elapsed = now - r["generation_started"]
                    r["completion_tokens"] = min(r["target_tokens"],
                                                 int(elapsed * r["gen_rate"]))
                    r["tps"] = round(r["gen_rate"] * RNG.uniform(0.97, 1.03), 1)
                    if RNG.random() < 0.004:
                        r["state"], r["error"] = "error", "generation aborted (simulated)"
                    elif r["completion_tokens"] >= r["target_tokens"]:
                        r["state"] = "complete"
                    else:
                        continue
                    emit({"type": "request", "id": r["id"], "model": r["model"],
                          "state": r["state"], "ts": now})
                if r["state"] in ("complete", "error") and r["id"] not in FINISHED_ORDER:
                    r["finished_at"] = now
                    FINISHED_ORDER.append(r["id"])
                    COUNT["requests"] += 1
                    COUNT["prompt"] += r["prompt_tokens"]
                    COUNT["completion"] += r["completion_tokens"]
                    COUNT["cached"] += r["cached_tokens"]
                    COUNT["errors"] += r["state"] == "error"
                    SIZES["prompt"].append(r["prompt_tokens"])
                    SIZES["completion"].append(r["completion_tokens"])
                    LATENCY["queue_ms"].append((r["prefill_started"] - r["queued_at"]) * 1000
                                               if r["prefill_started"] else 0)
                    if r["generation_started"]:
                        LATENCY["first_token_ms"].append(
                            (r["generation_started"] - r["queued_at"]) * 1000)
                    LATENCY["total_ms"].append((r["finished_at"] - r["queued_at"]) * 1000)
            # prune old finished requests (keep window of 300)
            while len(FINISHED_ORDER) > 300:
                old = FINISHED_ORDER.pop(0)
                REQUESTS.pop(old, None)


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


# ------------------------------------------------------------------ endpoints
def stats_payload():
    now = time.time()
    models_out, mem_used = [], 0
    for mid, m in MODELS.items():
        if not m["loaded"]:
            continue
        loading = m.get("loading_until") is not None
        prefilling = [{"request_id": r["id"], "prompt_tokens": r["prompt_tokens"],
                       "progress": round(min(1.0, (now - (r["prefill_started"] or now)) / max(r["prefill_s"], .01)), 2)}
                      for r in REQUESTS.values() if r["model"] == mid and r["state"] == "prefilling"]
        generating = [{"request_id": r["id"], "prompt_tokens": r["prompt_tokens"],
                       "generated_tokens": r["completion_tokens"],
                       "tokens_per_second": r["tps"] or 0.0,
                       "elapsed_seconds": round(now - r["generation_started"], 2) if r["generation_started"] else None}
                      for r in REQUESTS.values() if r["model"] == mid and r["state"] == "generating"]
        waiting = [r["id"] for r in REQUESTS.values() if r["model"] == mid and r["state"] == "queued"]
        mem_used += m["size"]
        models_out.append({
            "id": mid, "estimated_size": m["size"], "actual_size": m["size"],
            "actual_size_formatted": f"{m['size']/1e9:.2f} GB",
            "pinned": m["pinned"], "is_loading": loading,
            "loading_elapsed_seconds": round(now - m.get("load_started", now), 1) if loading else None,
            "loading_estimated_seconds": None, "loading_remaining_seconds_estimate": None,
            "active_requests": len(prefilling) + len(generating),
            "waiting_requests": len(waiting), "waiting": waiting, "activities": [],
            "prefilling": prefilling, "generating": generating,
            "idle_seconds": None, "ttl_remaining_seconds": m["settings"]["ttl_seconds"],
            "dflash": None, "cluster": None,
        })
    active = [r for r in REQUESTS.values() if r["state"] in ("prefilling", "generating")]
    gen_tps = sum(r["tps"] for r in active if r["state"] == "generating" and r["tps"]) or \
        (COUNT["completion"] / max(1, sum((r["finished_at"] - r["generation_started"])
           for r in REQUESTS.values() if r["finished_at"] and r["generation_started"])) if COUNT["completion"] else 0)
    pre_tps = COUNT["prompt"] / max(1, now - START)
    eff = COUNT["cached"] / COUNT["prompt"] * 100 if COUNT["prompt"] else 0
    level = "hard" if mem_used > MEM_MAX * 0.9 else "soft" if mem_used > MEM_MAX * 0.75 else "ok"
    return {
        "total_tokens_served": COUNT["prompt"] + COUNT["completion"],
        "total_cached_tokens": COUNT["cached"], "cache_efficiency": round(eff, 1),
        "total_prompt_tokens": COUNT["prompt"], "total_completion_tokens": COUNT["completion"],
        "total_requests": COUNT["requests"], "avg_prefill_tps": round(pre_tps, 1),
        "avg_generation_tps": round(gen_tps, 1), "uptime_seconds": round(now - START, 1),
        "host": "127.0.0.1", "port": 11437, "api_key": "mock", "cli_prefix": "mock",
        "engines": {"mlx-lm": {"name": "mock-lm", "version": "0.0-mock", "commit": None, "url": None}},
        "active_models": {
            "models": models_out, "model_memory_used": mem_used, "model_memory_max": MEM_MAX,
            "memory_pressure": {"enabled": True, "current_bytes": mem_used,
                                "soft_bytes": int(MEM_MAX * .75), "hard_bytes": int(MEM_MAX * .9),
                                "current_formatted": f"{mem_used/1e9:.1f} GB",
                                "soft_formatted": f"{MEM_MAX*.75/1e9:.0f} GB",
                                "hard_formatted": f"{MEM_MAX*.9/1e9:.0f} GB",
                                "pressure_level": level},
            "total_active_requests": len(active),
            "total_waiting_requests": sum(1 for r in REQUESTS.values() if r["state"] == "queued"),
        },
        "runtime_cache": {"base_path": "/tmp/mock", "ssd_cache_dir": "/tmp/mock/ssd",
                          "response_state_dir": "/tmp/mock/state", "total_num_files": 1234,
                          "total_size_bytes": RNG.randrange(4_000_000_000, 6_000_000_000),
                          "disk_max_bytes": 40_000_000_000, "hot_cache_max_bytes": 8_000_000_000,
                          "hot_cache_size_bytes": RNG.randrange(1_000_000_000, 3_000_000_000),
                          "hot_cache_entries": 55, "models": []},
        # ---- the metrics the real backend does not expose (mock shows the shape) ----
        "request_stats": {
            "source": "mock-full-population",
            "prompt_tokens": pct_block(SIZES["prompt"]),
            "completion_tokens": pct_block(SIZES["completion"]),
            "queue_ms": pct_block(LATENCY["queue_ms"]),
            "first_token_ms": pct_block(LATENCY["first_token_ms"]),
            "total_ms": pct_block(LATENCY["total_ms"]),
            "errors_total": COUNT["errors"],
        },
    }


def requests_payload(limit):
    with LOCK:
        rows = sorted(REQUESTS.values(), key=lambda r: r["queued_at"], reverse=True)[:limit]
        return {"requests": [{k: r[k] for k in
                              ("id", "model", "state", "queued_at", "prefill_started",
                               "generation_started", "finished_at", "prompt_tokens",
                               "completion_tokens", "cached_tokens", "tps", "error")}
                             for r in rows],
                "states": ["queued", "prefilling", "generating", "complete", "error"]}


def usage_payload(rng):
    now = time.time()
    days = {"today": 1, "yesterday": 1, "7d": 7, "30d": 30, "90d": 90}.get(rng, 1)
    heat = []
    for d in range(days):
        heat.append({"date": time.strftime("%Y-%m-%d", time.localtime(now - 86400 * (days - 1 - d))),
                     "tokens": [RNG.randrange(0, 4_000_000) if RNG.random() < .7 else 0
                                for _ in range(24)]})
    reqs = COUNT["requests"] or 10
    return {"range": rng, "start": None, "end": None, "timezone": "server local time",
            "retention_days": 400, "flush_seconds": 5, "enabled": True, "available": True,
            "dropped_requests": 0,
            "totals": {"requests": reqs, "prompt_tokens": COUNT["prompt"],
                       "completion_tokens": COUNT["completion"], "cached_tokens": COUNT["cached"],
                       "prefill_seconds": 1000.0, "generation_seconds": 5000.0,
                       "request_seconds": 6000.0, "timed_requests": reqs,
                       "total_tokens": COUNT["prompt"] + COUNT["completion"],
                       "cache_efficiency": 0.8},
            "models": [{"model_id": mid, "requests": RNG.randrange(10, max(reqs, 20)),
                        "prompt_tokens": COUNT["prompt"] // 4 or 1000,
                        "completion_tokens": COUNT["completion"] // 4 or 500,
                        "cached_tokens": COUNT["cached"] // 4 or 400}
                       for mid, m in MODELS.items() if m["loaded"]],
            "heatmap": heat}


SETTINGS_SCHEMA = {"temperature": (float, 0.0, 2.0), "max_tokens": (int, 1, 32768),
                   "ttl_seconds": (int, 30, 86400), "top_p": (float, 0.0, 1.0),
                   "reasoning_effort": (str, None, None)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002 - match base signature
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
            with LOCK:
                self._json(stats_payload())
        elif p == "/admin/api/requests":
            self._json(requests_payload(int(q.get("limit", ["40"])[0])))
        elif p == "/admin/api/requests/stream":
            self._sse()
        elif p == "/admin/api/models":
            with LOCK:
                self._json({"models": [{"id": mid, "loaded": m["loaded"],
                                        "loading": m.get("loading_until") is not None,
                                        "size_bytes": m["size"], "pinned": m["pinned"],
                                        "settings": dict(m["settings"])}
                                       for mid, m in MODELS.items()]})
        elif p.startswith("/admin/api/models/") and p.endswith("/settings"):
            mid = p[len("/admin/api/models/"):-len("/settings")]
            with LOCK:
                if mid not in MODELS:
                    self._json({"detail": "unknown model"}, 404)
                else:
                    self._json({"id": mid, "settings": dict(MODELS[mid]["settings"])})
        elif p == "/admin/api/usage":
            self._json(usage_payload(q.get("range", ["today"])[0]))
        elif p == "/admin/api/device-info":
            self._json({"chip_name": "M5", "chip_variant": "Max", "memory_gb": 128,
                        "gpu_cores": 40, "owner_hash": "mock"})
        elif p == "/admin/api/logs":
            ts = time.strftime("%Y-%m-%d %H:%M:%S") + ",000"
            lvl = RNG.choice(["DEBUG"] * 6 + ["INFO"] * 3 + ["WARNING", "ERROR"])
            self._json({"logs": "\n".join(
                f"{ts} - omlx.mock - {RNG.choice(['DEBUG']*5+['INFO','WARNING','ERROR'])} - [-] - "
                f"mock engine tick seq={i} active={len([r for r in REQUESTS.values() if r['state'] in ('generating','prefilling')])}"
                for i in range(60)), "total_lines": 60, "log_file": "mock.log",
                "available_files": ["mock.log"]})
        else:
            self._json({"detail": "not found"}, 404)

    def _sse(self):
        import queue as _q
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self._cors()
        # HTTP/1.1 keep-alive stream: signal end-of-body via connection close.
        self.close_connection = True
        self.send_header("Connection", "close")
        self.end_headers()
        q = _q.Queue()
        EVENT_SUBS.append(q)
        try:
            # Replay last minute, then live. (Simple blocking demo stream.)
            deadline = time.time() + 1800
            for ev in EVENTS[-20:]:
                self.wfile.write(f"data: {json.dumps(ev)}\n\n".encode())
            while time.time() < deadline:
                try:
                    ev = q.get(timeout=10)
                    self.wfile.write(f"data: {json.dumps(ev)}\n\n".encode())
                except _q.Empty:
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

    def do_PUT(self):
        p = urlparse(self.path).path
        if p.startswith("/admin/api/models/") and p.endswith("/settings"):
            mid = p[len("/admin/api/models/"):-len("/settings")]
            body = self._read_body()
            if body is None:
                return self._json({"detail": "invalid JSON"}, 400)
            with LOCK:
                if mid not in MODELS:
                    return self._json({"detail": "unknown model"}, 404)
                cur, errs = MODELS[mid]["settings"], {}
                for k, v in body.items():
                    if k == "pinned":
                        MODELS[mid]["pinned"] = bool(v)
                        continue
                    if k not in SETTINGS_SCHEMA:
                        errs[k] = "unknown field"
                        continue
                    typ, lo, hi = SETTINGS_SCHEMA[k]
                    if typ is str:
                        if not isinstance(v, str):
                            errs[k] = "must be string"
                        else:
                            cur[k] = v
                    elif not isinstance(v, (int, float)) or isinstance(v, bool):
                        errs[k] = "must be number"
                    elif lo is not None and not (lo <= float(v) <= hi):
                        errs[k] = f"out of range [{lo}, {hi}]"
                    else:
                        cur[k] = typ(v)
                if errs:
                    return self._json({"detail": errs, "settings": dict(cur)}, 422)
                emit({"type": "settings", "id": mid, "changed": list(body), "ts": time.time()})
                return self._json({"id": mid, "settings": dict(cur),
                                   "pinned": MODELS[mid]["pinned"]})
        self._json({"detail": "not found"}, 404)

    def do_POST(self):
        p = urlparse(self.path).path
        if p.startswith("/admin/api/models/") and p.rsplit("/", 1)[-1] in ("load", "unload"):
            parts = p.split("/")
            mid, action = parts[4], parts[-1]
            with LOCK:
                if mid not in MODELS:
                    return self._json({"detail": "unknown model"}, 404)
                m = MODELS[mid]
                if action == "load" and not m["loaded"]:
                    m["loaded"], m["loading_until"] = True, time.time() + 5
                    m["load_started"] = time.time()
                    emit({"type": "model-load", "id": mid, "ts": time.time()})
                elif action == "unload" and m["loaded"]:
                    busy = any(r["model"] == mid and r["state"] in
                               ("queued", "prefilling", "generating") for r in REQUESTS.values())
                    if busy:
                        return self._json({"detail": "model busy — active requests"}, 409)
                    m["loaded"], m["loading_until"] = False, None
                    emit({"type": "model-unload", "id": mid, "ts": time.time()})
                return self._json({"id": mid, "loaded": m["loaded"]})
        self._json({"detail": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=11437)
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()
    threading.Thread(target=request_sim, args=(args.speed,), daemon=True).start()
    threading.Thread(target=load_sim, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"mock oMLX API on http://127.0.0.1:{args.port} (speed {args.speed}x)")
    srv.serve_forever()


if __name__ == "__main__":
    main()
