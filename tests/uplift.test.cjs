/* Node unit tests for uplift core: node --test tests/uplift.test.cjs */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../omlx/admin/static/uplift/core.js');

const snap = o => C.normalize(o);
const raw = extra => Object.assign({
    avg_generation_tps: 50, avg_prefill_tps: 3000, total_requests: 10,
    total_tokens_served: 1000, total_completion_tokens: 20, total_cached_tokens: 5,
    cache_efficiency: 55.5, uptime_seconds: 100,
    active_models: { models: [], model_memory_used: 8e9, model_memory_max: 16e9,
        memory_pressure: { pressure_level: 'ok' }, total_active_requests: 0, total_waiting_requests: 0 },
    runtime_cache: { total_size_bytes: 1e9, disk_max_bytes: 1e10 },
}, extra);

test('normalize: happy path', () => {
    const s = snap(raw());
    assert.strictEqual(s.genTps, 50);
    assert.strictEqual(s.requests, 10);
    assert.strictEqual(s.memPercent, 50);
    assert.strictEqual(s.pressure, 'ok');
    assert.strictEqual(s.cachePercent, 10);
});
test('normalize: garbage in, nulls out', () => {
    const s = snap({ avg_generation_tps: 'x', total_requests: -5, active_models: null });
    assert.strictEqual(s.genTps, null);
    assert.strictEqual(s.requests, null);
    assert.strictEqual(s.memPercent, null);
    assert.deepStrictEqual(s.models, []);
});
test('normalize: undefined payload does not throw', () => {
    assert.strictEqual(snap().requests, null);
});

test('modelState precedence', () => {
    assert.strictEqual(C.modelState({ is_loading: true, active_requests: 2 }), 'Loading');
    assert.strictEqual(C.modelState({ prefilling: [1] }), 'Prefilling');
    assert.strictEqual(C.modelState({ generating: [1] }), 'Generating');
    assert.strictEqual(C.modelState({ active_requests: 1 }), 'Active');
    assert.strictEqual(C.modelState({}), 'Idle');
});

const m = (id, state) => {
    const s = snap(raw({ active_models: { models: [{ id, actual_size: 1e9, active_requests: 0 }],
        model_memory_used: 0, model_memory_max: 1e9, memory_pressure: {} } }));
    s.models[0].state = state;
    return s;
};

test('eventsBetween: first snapshot is silent', () => {
    assert.deepStrictEqual(C.eventsBetween(null, m('a', 'Idle')), []);
});
test('eventsBetween: model appear / state change / disappear', () => {
    const evs = C.eventsBetween(m('a', 'Idle'), m('b', 'Generating'));
    const kinds = evs.map(e => e.kind).sort();
    assert.deepStrictEqual(kinds, ['model-add', 'model-remove']);
});
test('eventsBetween: request delta', () => {
    const a = snap(raw({ total_requests: 5 })), b = snap(raw({ total_requests: 8 }));
    const evs = C.eventsBetween(a, b);
    assert.strictEqual(evs.length, 1);
    assert.strictEqual(evs[0].delta, 3);
});
test('eventsBetween: counter regression => restart', () => {
    const a = snap(raw({ total_requests: 50 })), b = snap(raw({ total_requests: 2 }));
    const evs = C.eventsBetween(a, b);
    assert.ok(evs.some(e => e.kind === 'restart'));
});
test('eventsBetween: pressure change', () => {
    const a = snap(raw()), b = snap(raw());
    b.pressure = 'hard';
    assert.ok(C.eventsBetween(a, b).some(e => e.kind === 'pressure'));
});

test('milestonesBetween: crossings only', () => {
    const a = snap(raw({ total_requests: 999 })), b = snap(raw({ total_requests: 1001 }));
    assert.strictEqual(C.milestonesBetween(a, b).length, 1);
    const c = snap(raw({ total_requests: 1002 }));
    assert.strictEqual(C.milestonesBetween(b, c).length, 0);
    assert.strictEqual(C.milestonesBetween(null, b).length, 0);
});

test('appendSample bounds history', () => {
    const h = [];
    for (let i = 0; i < 150; i++) C.appendSample(h, { t: i }, 120);
    assert.strictEqual(h.length, 120);
    assert.strictEqual(h[0].t, 30);
});

test('prefs: corrupt storage falls back to defaults', () => {
    const items = {};
    const store = { getItem: k => items[k], setItem: (k, v) => items[k] = v };
    assert.deepStrictEqual(C.loadPrefs(store), C.PREFS_DEFAULTS);
    items[C.PREFS_KEY] = '{oops';
    assert.deepStrictEqual(C.loadPrefs(store), C.PREFS_DEFAULTS);
    items[C.PREFS_KEY] = JSON.stringify({ theme: 'neon', intervalMs: 7 });
    assert.deepStrictEqual(C.loadPrefs(store), C.PREFS_DEFAULTS);
    C.savePrefs(store, { theme: 'light', motion: 'off', intervalMs: 2000, dense: true });
    assert.deepStrictEqual(C.loadPrefs(store), { theme: 'light', motion: 'off', intervalMs: 2000, dense: true });
});

test('formatters', () => {
    assert.strictEqual(C.fmtCompact(1234567), '1.23M');
    assert.strictEqual(C.fmtCompact(999), '999');
    assert.strictEqual(C.fmtCompact(null), '—');
    assert.strictEqual(C.fmtBytes(8.34e9), '8.34 GB');
    assert.strictEqual(C.fmtBytes(500e6), '500 MB');
    assert.strictEqual(C.fmtDuration(3725), '1h 2m');
    assert.strictEqual(C.fmtDuration(75), '1m 15s');
    assert.strictEqual(C.fmtNumber(1234567), '1,234,567');
});
