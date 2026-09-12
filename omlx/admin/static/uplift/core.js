/* Uplift core: pure, testable functions. No DOM, no network.
   Dual-export: browser global `UpliftCore`, Node module for tests. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const num = x => (typeof x === 'number' && Number.isFinite(x) && x >= 0) ? x : null;
const r = (v, d) => v === null ? null : Math.round(v * 10 ** d) / 10 ** d;
const clampRatio = (a, b) => (a === null || !(b > 0)) ? null : Math.min(100, a / b * 100);

const PRESSURES = ['ok', 'soft', 'hard'];
const STATES = ['Idle', 'Loading', 'Prefilling', 'Generating', 'Active'];

function modelState(m) {
    if (m.is_loading) return 'Loading';
    if (Array.isArray(m.prefilling) && m.prefilling.length) return 'Prefilling';
    if (Array.isArray(m.generating) && m.generating.length) return 'Generating';
    if ((m.active_requests || 0) > 0) return 'Active';
    return 'Idle';
}

/* Normalize the raw /admin/api/stats payload into a flat snapshot.
   Every field is either a finite number/string or null — UI never has to guard. */
function normalize(raw) {
    raw = raw || {};
    const a = raw.active_models || {}, c = raw.runtime_cache || {}, p = a.memory_pressure || {};
    const memUsed = num(a.model_memory_used), memMax = num(a.model_memory_max);
    return {
        time: Date.now(),
        genTps: num(raw.avg_generation_tps),
        prefillTps: num(raw.avg_prefill_tps),
        requests: num(raw.total_requests),
        totalTokens: num(raw.total_tokens_served),
        completionTokens: num(raw.total_completion_tokens),
        cachedTokens: num(raw.total_cached_tokens),
        cacheEfficiency: num(raw.cache_efficiency),
        uptime: num(raw.uptime_seconds),
        active: num(a.total_active_requests),
        waiting: num(a.total_waiting_requests),
        memUsed: memUsed, memMax: memMax,
        memPercent: clampRatio(memUsed, memMax),
        pressure: PRESSURES.includes(p.pressure_level) ? p.pressure_level : null,
        cacheBytes: num(c.total_size_bytes), cacheMaxBytes: num(c.disk_max_bytes),
        cachePercent: clampRatio(num(c.total_size_bytes), num(c.disk_max_bytes)),
        models: (Array.isArray(a.models) ? a.models : []).map(m => ({
            id: String(m.id || 'Unnamed model'),
            size: num(m.actual_size),
            sizeText: typeof m.actual_size_formatted === 'string' ? m.actual_size_formatted : '',
            pinned: m.pinned === true,
            active: num(m.active_requests) || 0,
            waiting: num(m.waiting_requests) || 0,
            idleSeconds: num(m.idle_seconds),
            state: STATES.includes(modelState(m)) ? modelState(m) : 'Idle',
        })),
    };
}

/* Rolling time-window history of samples (ring semantics via splice). */
function appendSample(history, sample, max) {
    history.push(sample);
    if (history.length > (max || 120)) history.splice(0, history.length - (max || 120));
    return history;
}

/* Diff two snapshots into a list of {kind, text} events for UI reactions. */
function eventsBetween(prev, next) {
    if (!prev) return [];
    const events = [];
    // Counter regression => server (re)started.
    if ((next.uptime !== null && prev.uptime !== null && next.uptime < prev.uptime) ||
        (next.requests !== null && prev.requests !== null && next.requests < prev.requests)) {
        events.push({ kind: 'restart', text: 'Server counters reset — oMLX restarted' });
    }
    const old = new Map(prev.models.map(m => [m.id, m]));
    for (const m of next.models) {
        const before = old.get(m.id);
        if (!before) events.push({ kind: 'model-add', text: `${m.id} loaded`, model: m.id });
        else if (before.state !== m.state)
            events.push({ kind: 'model-state', text: `${m.id}: ${m.state}`, model: m.id, state: m.state });
        old.delete(m.id);
    }
    for (const id of old.keys()) events.push({ kind: 'model-remove', text: `${id} unloaded`, model: id });
    if (next.requests !== null && prev.requests !== null && next.requests > prev.requests)
        events.push({ kind: 'requests', delta: next.requests - prev.requests,
                      text: `${next.requests - prev.requests} request${next.requests - prev.requests === 1 ? '' : 's'} completed` });
    if (next.pressure && prev.pressure && next.pressure !== prev.pressure)
        events.push({ kind: 'pressure', text: `Memory pressure: ${next.pressure}` });
    return events;
}

/* Milestone events (confetti candidates) derived from counters crossing rounds. */
function milestonesBetween(prev, next) {
    const hits = [];
    if (!prev) return hits;
    for (const [key, label] of [['requests', 'requests served'], ['totalTokens', 'tokens served']]) {
        const a = prev[key], b = next[key];
        if (a === null || b === null || b <= a) continue;
        const step = key === 'requests' ? 1000 : 1000000;
        if (Math.floor(b / step) > Math.floor(a / step))
            hits.push({ key, label, value: b });
    }
    return hits;
}

/* Settings: validated against known-good values; corrupt/absent => defaults. */
const PREFS_KEY = '***';
const PREFS_DEFAULTS = { theme: 'auto', motion: 'auto', intervalMs: 1000, dense: false };
function loadPrefs(storage) {
    let p = {};
    try { p = JSON.parse(storage.getItem(PREFS_KEY)) || {}; } catch (_) { /* storage may be denied */ }
    return {
        theme: ['auto', 'dark', 'light'].includes(p.theme) ? p.theme : PREFS_DEFAULTS.theme,
        motion: ['auto', 'off'].includes(p.motion) ? p.motion : PREFS_DEFAULTS.motion,
        intervalMs: [500, 1000, 2000, 5000].includes(p.intervalMs) ? p.intervalMs : PREFS_DEFAULTS.intervalMs,
        dense: p.dense === true,
    };
}
function savePrefs(storage, prefs) {
    try { storage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ }
}

/* Formatting (metric, human). */
function fmtCompact(n) {
    if (n === null) return '—';
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n * 10) / 10);
}
function fmtBytes(n) {
    if (n === null) return '—';
    const g = n / 1e9;
    if (g >= 10) return g.toFixed(0) + ' GB';
    if (g >= 1) return g.toFixed(2) + ' GB';
    return (n / 1e6).toFixed(0) + ' MB';
}
function fmtDuration(s) {
    if (s === null) return '—';
    s = Math.floor(s);
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s % 60}s`;
    return `${s}s`;
}
function fmtNumber(n) { return n === null ? '—' : Math.round(n).toLocaleString('en-US'); }

return { num, r, normalize, modelState, appendSample, eventsBetween, milestonesBetween,
         PREFS_KEY, PREFS_DEFAULTS, loadPrefs, savePrefs,
         fmtCompact, fmtBytes, fmtDuration, fmtNumber };
});
