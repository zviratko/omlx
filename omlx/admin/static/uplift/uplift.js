/* Uplift UI controller. Read-only: polls admin APIs, animates, never writes config. */
(function () {
'use strict';
const C = window.UpliftCore;
const $ = id => document.getElementById(id);

/* API base: same origin when hosted by omlx itself, else the local helper
   (page served on :11436 during testing; override with ?api=). */
const API = new URLSearchParams(location.search).get('api') ||
    (location.port === '11435' || location.port === '' ? '' : 'http://127.0.0.1:11435');

const prefs = C.loadPrefs(localStorage);
const layout = C.loadLayout(localStorage);
const tracker = C.createRequestTracker(2000);
let stats = null, prevStats = null, failCount = 0, timer = null;
let usageRange = 'today', usageTimer = null, logsTimer = null;
const PERCENTILES = { p50: 50, p90: 90, p95: 95, p99: 99 };
if (!(layout.percentile in PERCENTILES)) layout.percentile = 'p95';

/* ---------------- theme & motion ---------------- */
function applyPrefs() {
    const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' &&
        matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const motionOff = prefs.motion === 'off' ||
        matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.dataset.motion = motionOff ? 'off' : 'auto';
    $('btn-motion').style.opacity = motionOff ? 0.4 : 1;
    rerenderChartsTheme();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);

const motionOff = () => document.documentElement.dataset.motion === 'off';
$('btn-theme').onclick = () => {
    prefs.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    C.savePrefs(localStorage, prefs); applyPrefs();
};
$('btn-motion').onclick = () => {
    prefs.motion = document.documentElement.dataset.motion === 'off' ? 'auto' : 'off';
    C.savePrefs(localStorage, prefs); applyPrefs();
};

/* ---------------- layout engine (popover + collapse + columns) ---------------- */
const cards = [...document.querySelectorAll('.card')];
function fillSelect(sel, options, value) {
    sel.innerHTML = '';
    for (const [v, label] of options) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        if (String(v) === String(value)) o.selected = true;
        sel.append(o);
    }
}
function applyLayout() {
    document.documentElement.style.setProperty('--cols', layout.cols);
    for (const card of cards) {
        const id = card.dataset.id;
        const want = Number(card.dataset.cols) || 1;
        card.style.setProperty('--span', C.clampSpan(want, layout.cols));
        const collapsed = layout.collapsed[id] === true;
        card.classList.toggle('is-collapsed', collapsed);
        card.querySelector('.collapse').textContent = collapsed ? '+' : '–';
    }
    // Collapsed cards hide their charts; uPlot needs a resize when they return.
    requestAnimationFrame(resizeCharts);
    C.saveLayout(localStorage, layout);
}
for (const card of cards) {
    card.querySelector('.collapse').onclick = () => {
        const id = card.dataset.id;
        layout.collapsed[id] = !(layout.collapsed[id] === true);
        applyLayout();
    };
}
fillSelect($('opt-cols'), [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']], layout.cols);
$('opt-cols').onchange = e => { layout.cols = Number(e.target.value); applyLayout(); };
fillSelect($('opt-window'), C.LAYOUT_WINDOWS.map(s => [s, s >= 3600 ? '1 hour' : `${s / 60} min`]), layout.chartWindowSec);
$('opt-window').onchange = e => { layout.chartWindowSec = Number(e.target.value); redrawCharts(); C.saveLayout(localStorage, layout); };
fillSelect($('opt-interval'), C.LAYOUT_INTERVALS.map(ms => [ms, `${ms / 1000} s`]), layout.intervalMs);
$('opt-interval').onchange = e => { layout.intervalMs = Number(e.target.value); C.saveLayout(localStorage, layout); restartPolling(); };
$('opt-hide-debug').checked = layout.logsHideDebug;
$('opt-hide-debug').onchange = e => { layout.logsHideDebug = e.target.checked; C.saveLayout(localStorage, layout); pollLogs(); };
$('btn-layout-reset').onclick = () => {
    Object.assign(layout, C.LAYOUT_DEFAULTS, { collapsed: {} });
    applyLayout();
    fillSelect($('opt-cols'), [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']], layout.cols);
    fillSelect($('opt-window'), C.LAYOUT_WINDOWS.map(s => [s, s >= 3600 ? '1 hour' : `${s / 60} min`]), layout.chartWindowSec);
    fillSelect($('opt-interval'), C.LAYOUT_INTERVALS.map(ms => [ms, `${ms / 1000} s`]), layout.intervalMs);
    $('opt-hide-debug').checked = layout.logsHideDebug;
    restartPolling();
};
$('btn-expand-all').onclick = () => { layout.collapsed = {}; applyLayout(); };
$('btn-layout').onclick = e => {
    e.stopPropagation();
    $('layout-pop').hidden = !$('layout-pop').hidden;
};
document.addEventListener('click', e => {
    if (!$('layout-pop').hidden && !$('layout-pop').contains(e.target) && e.target !== $('btn-layout'))
        $('layout-pop').hidden = true;
});

/* ---------------- animated counters (lightweight rAF tween) ---------------- */
const counters = {};
function counter(elId, format) {
    counters[elId] = { el: $(elId), format, value: null, raf: 0 };
}
function setCounter(elId, target) {
    const c = counters[elId];
    if (!c) return;
    if (target === null) { c.el.textContent = '—'; c.value = null; return; }
    if (c.value === null || motionOff() || c.value === target) { c.value = target; c.el.textContent = c.format(target); return; }
    cancelAnimationFrame(c.raf);
    const from = c.value, start = performance.now(), dur = 600;
    const step = now => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - (1 - t) ** 3;               // easeOutCubic
        c.el.textContent = c.format(from + (target - from) * eased);
        if (t < 1) c.raf = requestAnimationFrame(step);
        else c.el.textContent = c.format(target);
    };
    c.value = target;
    c.raf = requestAnimationFrame(step);
}
counter('v-gentps',     v => v.toFixed(1));
counter('v-prefilltps', v => v.toFixed(0));
counter('v-requests',   v => C.fmtNumber(v));
counter('v-tokens',     v => C.fmtCompact(v));
counter('v-cacheeff',   v => v.toFixed(1) + '%');
counter('v-prompt-avg', v => C.fmtCompact(v));
counter('v-prompt-pct', v => C.fmtCompact(v));
counter('v-compl-avg',  v => C.fmtCompact(v));
counter('v-compl-pct',  v => C.fmtCompact(v));

/* ---------------- charts ---------------- */
const axisFont = '10px ui-monospace, SFMono-Regular, Menlo, monospace'; // uPlot 1.6.32: plain string only
const tpsData = [[], [], []];   // time, gen, prefill
const memData = [[], []];       // time, percent
const MAX_POINTS = 4000;        // covers 1h at 1s polls plus usage headroom

function chartColors() {
    const cs = getComputedStyle(document.documentElement);
    return { dim: cs.getPropertyValue('--text-dim').trim() || '#8b96ab',
             blue: cs.getPropertyValue('--accent').trim() || '#3d9df6',
             gold: cs.getPropertyValue('--accent-2').trim() || '#f0b429' };
}
function windowedData(data) {
    const cutoff = Date.now() - layout.chartWindowSec * 1000;
    let i = 0;
    while (i < data[0].length && data[0][i] < cutoff) i++;
    return data.map(col => col.slice(i));
}
function seriesValue(v) {
    return v === null || v === undefined ? '—' : C.fmtCompact(v);
}
function line(label, colorVar, fill) {
    const col = chartColors()[colorVar];
    return { label, stroke: col, width: 2, fill: fill ? col + '22' : undefined,
             points: { show: false }, value: seriesValue };
}
function baseOpts(yLabel, specs, legendHook) {
    const col = chartColors();
    return {
        width: 0, height: 240, padding: [6, 8, 0, 0],
        cursor: { drag: { x: false, y: false }, points: { show: true, size: 6, fill: col.dim } },
        // Values always visible: latest when idle, hovered point on mouse-over.
        legend: { show: true, top: true, live: false, labels: { fontSize: '10px' } },
        scales: { x: { time: true }, y: { auto: true } },
        axes: [
            { stroke: col.dim, width: 1, size: 42, font: axisFont,
              values: (s, t) => t.map(ts => new Date(ts).toLocaleTimeString('en-GB',
                  { hour: '2-digit', minute: '2-digit', ...(layout.chartWindowSec < 900 ? { second: '2-digit' } : {}) })) },
            { stroke: col.dim, size: 40, font: axisFont, grid: true, label: yLabel },
        ],
        // hooks must be present at construction for the cursor subscription to register.
        hooks: legendHook ? { cursor: { subscribe: [legendHook] } } : undefined,
        series: [{}, ...specs.map(s => line(s[0], s[1], s[2]))],
    };
}
/* Legend value updater: latest sample when idle, hovered sample on mouse-over.
   With live:false uPlot renders no value cells, so we append our own to each
   series row and fill them. Reads c.data — the windowed slice uPlot currently
   displays — so indices always match c.cursor.idx. */
function legendUpdater() {
    return c => {
        const rows = [...c.root.querySelectorAll('.u-legend .u-series')];
        if (!rows.length) return;
        // Row 0 is series 0; uPlot also prepends a cursor row when live — handle both.
        const hasTimeRow = rows[0] && rows[0].querySelector('.u-label')?.textContent === 'Time';
        const seriesRows = hasTimeRow ? rows.slice(1) : rows;
        const idx = c.cursor.idx;
        const src = c.data[0];
        const i = (idx === null || idx === undefined) ? src.length - 1 : Math.min(idx, src.length - 1);
        seriesRows.forEach((row, sIdx) => {
            let cell = row.querySelector('.u-value');
            if (!cell) {
                cell = document.createElement('td');
                cell.className = 'u-value';
                row.append(cell);
            }
            const col = c.data[sIdx + 1];
            const v = col && col.length ? col[i] : null;
            cell.textContent = (v === null || v === undefined) ? '—' : seriesValue(v);
        });
    };
}
let tpsChart = null, memChart = null;
function createCharts() {
    if (tpsChart) { tpsChart.destroy(); memChart.destroy(); }
    tpsChart = new uPlot(
        baseOpts('tok/s', [['generation', 'blue', true], ['prefill', 'gold', false]], legendUpdater()),
        windowedData(tpsData), $('chart-tps'));
    const memOpts = baseOpts('memory %', [['used', 'blue', true]], legendUpdater());
    memOpts.scales.y = { range: [0, 100] };
    memChart = new uPlot(memOpts, windowedData(memData), $('chart-mem'));
    resizeCharts();   // fresh uPlots start at width 0; size them to their boxes
    redrawCharts();
}
function redrawCharts() {
    if (!tpsChart) return;
    tpsChart.setData(windowedData(tpsData), false);
    memChart.setData(windowedData(memData), false);
    // setData does not fire the cursor hook: refresh legends explicitly.
    legendUpdater()(tpsChart); legendUpdater()(memChart);
    const shown = windowedData(tpsData)[0].length;
    $('chart-tps-window').textContent = shown > 1 ? `${layout.chartWindowSec >= 3600 ? '1h' : layout.chartWindowSec / 60 + 'm'} window` : '';
}
function rerenderChartsTheme() { createCharts(); }
function resizeCharts() {
    if (!tpsChart) return;
    const w1 = $('chart-tps').clientWidth, w2 = $('chart-mem').clientWidth;
    if (w1 > 0) tpsChart.setSize({ width: w1, height: 240 });
    if (w2 > 0) memChart.setSize({ width: w2, height: 240 });
}
new ResizeObserver(resizeCharts).observe($('grid'));

/* ---------------- event feed / reactions ---------------- */
const MAX_FEED = 40;
function pushFeed(events) {
    const feed = $('feed');
    const empty = feed.querySelector('.empty'); if (empty) empty.remove();
    for (const ev of events.slice().reverse()) {
        const row = document.createElement('div');
        row.className = `feed-item k-${ev.kind}`;
        const time = document.createElement('time');
        time.textContent = new Date().toLocaleTimeString('en-GB');
        const span = document.createElement('span');
        span.className = 'ev'; span.textContent = ev.text;
        row.append(time, span);
        feed.prepend(row);
    }
    while (feed.children.length > MAX_FEED) feed.lastChild.remove();
}
function toast(text, ms) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = text;
    $('toasts').append(t);
    setTimeout(() => t.remove(), ms || 3200);
}
function flashCard(id, tone) {
    const el = $(id); if (!el || motionOff()) return;
    const card = el.closest('.card'); if (!card) return;
    card.classList.add(`flash-${tone}`);
    setTimeout(() => card.classList.remove(`flash-${tone}`), 1200);
}
function celebrate(text) {
    toast(`🎉 ${text}`);
    if (motionOff() || typeof confetti !== 'function') return;
    confetti({ particleCount: 90, spread: 70, origin: { y: 0.7 },
               colors: ['#3d9df6', '#f0b429', '#34d399', '#e7ecf5'] });
}
function reactTo(events) {
    for (const ev of events) {
        pushFeed([ev]);
        if (ev.kind === 'model-add')   { toast(`Model loaded: ${ev.model}`); flashCard('v-requests', 'ok'); }
        if (ev.kind === 'model-remove') flashCard('v-requests', 'warn');
        if (ev.kind === 'restart')      flashCard('v-gentps', 'bad');
        if (ev.kind === 'pressure' && ev.text.includes('hard')) flashCard('mem-label', 'bad');
    }
}

/* ---------------- rendering ---------------- */
function render(s) {
    setCounter('v-gentps', s.genTps);
    setCounter('v-prefilltps', s.prefillTps);
    setCounter('v-requests', s.requests);
    setCounter('v-tokens', s.totalTokens);
    setCounter('v-cacheeff', s.cacheEfficiency);
    $('v-tokens-sub').textContent = s.completionTokens !== null
        ? `${C.fmtCompact(s.completionTokens)} generated · ${C.fmtCompact(s.cachedTokens)} cached` : '';
    $('chip-uptime').textContent = `up ${C.fmtDuration(s.uptime)}`;
    $('v-active2').textContent = s.active === null ? '—' : s.active;
    $('v-waiting2').textContent = s.waiting === null ? '—' : s.waiting;

    const dot = $('status-dot');
    dot.classList.toggle('bad', s.pressure === 'hard');

    const mem = $('meter-cache');
    mem.classList.toggle('warn', s.memPercent !== null && s.memPercent >= 70);
    mem.classList.toggle('bad', s.memPercent !== null && s.memPercent >= 90);
    $('cache-sub').textContent = s.memUsed !== null
        ? `models ${C.fmtBytes(s.memUsed)} / ${C.fmtBytes(s.memMax)} · disk cache ${C.fmtBytes(s.cacheBytes)}${s.cachePercent !== null ? ' (' + s.cachePercent.toFixed(0) + '%)' : ''}`
        : '';
    $('mem-label').textContent = s.memPercent !== null ? `${s.memPercent.toFixed(1)}% ${s.pressure || ''}` : '';

    renderModels(s);
    renderLive(s);
    renderRequestStats();

    // Chart buffers (window pruning happens at draw time).
    tpsData[0].push(s.time); tpsData[1].push(s.genTps); tpsData[2].push(s.prefillTps);
    while (tpsData[0].length > MAX_POINTS) { tpsData[0].shift(); tpsData[1].shift(); tpsData[2].shift(); }
    memData[0].push(s.time); memData[1].push(s.memPercent === null ? null : +s.memPercent.toFixed(2));
    while (memData[0].length > MAX_POINTS) { memData[0].shift(); memData[1].shift(); }
    redrawCharts();
}

function renderModels(s) {
    const list = $('model-list');
    $('models-count').textContent = s.models.length ? `${s.models.length} loaded` : '';
    if (!s.models.length) {
        if (!list.querySelector('.empty')) list.innerHTML = '<div class="empty">No models loaded</div>';
        return;
    }
    list.innerHTML = '';
    for (const m of s.models) {
        const row = document.createElement('div'); row.className = 'model-row';
        const badge = document.createElement('span');
        badge.className = `badge ${m.state}`; badge.textContent = m.state;
        const name = document.createElement('span');
        name.className = 'model-name'; name.title = m.id; name.textContent = (m.pinned ? '📌 ' : '') + m.id;
        const meta = document.createElement('span');
        meta.className = 'model-meta';
        meta.textContent = [m.sizeText, m.active ? `${m.active}a` : '', m.waiting ? `${m.waiting}w` : '']
            .filter(Boolean).join(' · ');
        row.append(badge, name, meta);
        list.append(row);
    }
}

function renderLive(s) {
    const list = $('live-list');
    const rows = [];
    for (const m of s.models) {
        for (const p of m.prefilling) rows.push({ model: m.id, kind: 'Prefilling', prompt: p.prompt });
        for (const g of m.generating) rows.push({ model: m.id, kind: 'Generating', prompt: g.prompt, generated: g.generated, tps: g.tps });
    }
    $('live-count').textContent = rows.length ? `${rows.length}` : '';
    if (!rows.length) {
        if (!list.querySelector('.empty')) list.innerHTML = '<div class="empty">Idle</div>';
        return;
    }
    list.innerHTML = '';
    for (const r of rows) {
        const row = document.createElement('div'); row.className = 'model-row';
        const badge = document.createElement('span');
        badge.className = `badge ${r.kind}`; badge.textContent = r.kind;
        const name = document.createElement('span');
        name.className = 'model-name'; name.textContent = r.model; name.title = r.model;
        const meta = document.createElement('span');
        meta.className = 'model-meta';
        const bits = [];
        if (r.prompt) bits.push(`in ${C.fmtCompact(r.prompt)}`);
        if (r.generated !== undefined) bits.push(`out ${C.fmtCompact(r.generated)}`);
        if (r.tps) bits.push(`${r.tps.toFixed(0)} t/s`);
        meta.textContent = bits.join(' · ');
        row.append(badge, name, meta);
        list.append(row);
    }
}

/* Request sizes: avg from server-side hourly usage aggregates,
   percentiles from the client-side tracker (page session only). */
function renderRequestStats() {
    fillSelectOnce();
    const p = PERCENTILES[layout.percentile];
    const promptSamples = tracker.samples.prompt, complSamples = tracker.samples.completion;
    const avgFromUsage = usageAvg;
    setCounter('v-prompt-avg', avgFromUsage ? avgFromUsage.prompt : (C.mean(promptSamples) ?? null));
    setCounter('v-compl-avg', avgFromUsage ? avgFromUsage.completion : (C.mean(complSamples) ?? null));
    setCounter('v-prompt-pct', C.percentile(promptSamples, p));
    setCounter('v-compl-pct', C.percentile(complSamples, p));
    $('lbl-prompt-pct').textContent = `${layout.percentile} prompt tok`;
    $('lbl-compl-pct').textContent = `${layout.percentile} completion tok`;
    const n = Math.max(promptSamples.length, complSamples.length);
    $('reqstats-note').textContent =
        `avg: usage aggregates (${usageRange}) · p: session samples (${n}, cap 2000)` +
        (n === 0 ? ' — waiting for requests to complete while this page is open' : '');
}
let fillSelectDone = false;
function fillSelectOnce() {
    if (fillSelectDone) return;
    fillSelectDone = true;
    fillSelect($('opt-percentile'), Object.keys(PERCENTILES).map(k => [k, k.toUpperCase()]), layout.percentile);
    $('opt-percentile').onchange = e => { layout.percentile = e.target.value; C.saveLayout(localStorage, layout); renderRequestStats(); };
}

/* ---------------- polling ---------------- */
async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}
async function pollStats() {
    if (document.hidden) return;
    try {
        const s = C.normalize(await fetchJson(`${API}/admin/api/stats`));
        failCount = 0;
        document.body.classList.remove('stale');
        $('banner').classList.remove('show');
        const events = C.eventsBetween(prevStats, s);
        const miles = C.milestonesBetween(prevStats, s);
        prevStats = stats; stats = s;
        tracker.observe(s);
        render(s);
        reactTo(events);
        for (const mi of miles) celebrate(`${C.fmtNumber(mi.value)} ${mi.label}`);
    } catch (err) {
        if (++failCount >= 2) {
            document.body.classList.add('stale');
            $('banner-text').textContent = `Cannot reach oMLX at ${API || location.origin}: ${err.message}`;
            $('banner').classList.add('show');
        }
    }
}
function restartPolling() {
    clearInterval(timer);
    pollStats();
    timer = setInterval(pollStats, layout.intervalMs);
}

/* ---------------- usage (heat strip + per-model table) ---------------- */
let usageAvg = null;
async function pollUsage() {
    if (document.hidden) return;
    try {
        const u = await fetchJson(`${API}/admin/api/usage?range=${usageRange}`);
        const hm = u.heatmap || [];
        const day = hm[usageRange === 'yesterday' ? 0 : hm.length - 1];
        const hours = day ? day.tokens : new Array(24).fill(0);
        const max = Math.max(1, ...hours);
        const heat = $('heat');
        if (heat.children.length !== 24) {
            heat.innerHTML = '';
            for (let i = 0; i < 24; i++) heat.append(document.createElement('i'));
        }
        [...heat.children].forEach((cell, i) => {
            const v = hours[i] || 0;
            const a = v > 0 ? 0.15 + 0.85 * Math.sqrt(v / max) : 0;
            cell.style.background = v > 0 ? `color-mix(in oklab, var(--accent) ${Math.round(a * 100)}%, transparent)` : '';
            cell.title = `${String(i).padStart(2, '0')}:00 — ${C.fmtCompact(v)} tokens`;
        });
        const tot = u.totals || {};
        $('usage-sub').textContent = tot.requests !== undefined
            ? `${C.fmtNumber(tot.requests)} req · ${C.fmtCompact(tot.total_tokens)} tok` : '';
        usageAvg = tot.requests > 0
            ? { prompt: tot.prompt_tokens / tot.requests, completion: tot.completion_tokens / tot.requests }
            : null;

        // Per-model mini table (top 6 by tokens).
        const table = $('usage-models');
        table.innerHTML = '';
        const models = (u.models || []).slice()
            .sort((a, b) => (b.prompt_tokens + b.completion_tokens) - (a.prompt_tokens + a.completion_tokens))
            .slice(0, 6);
        if (models.length) {
            const head = document.createElement('div'); head.className = 'urow head';
            for (const h of ['model', 'req', 'tokens', 'avg t/req']) {
                const s = document.createElement('span'); s.textContent = h; head.append(s);
            }
            table.append(head);
            for (const m of models) {
                const row = document.createElement('div'); row.className = 'urow';
                const name = document.createElement('span');
                name.className = 'uname'; name.textContent = m.model_id; name.title = m.model_id;
                const req = document.createElement('span'); req.textContent = C.fmtNumber(m.requests);
                const tok = document.createElement('span'); tok.textContent = C.fmtCompact(m.prompt_tokens + m.completion_tokens);
                const avg = document.createElement('span');
                avg.textContent = m.requests ? C.fmtCompact((m.prompt_tokens + m.completion_tokens) / m.requests) : '—';
                row.append(name, req, tok, avg);
                table.append(row);
            }
        }
        renderRequestStats();
    } catch (_) { /* usage tab may be disabled; keep last data */ }
}
fillSelect($('opt-usage-range'), [['today', 'today'], ['yesterday', 'yesterday'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']], usageRange);
$('opt-usage-range').onchange = e => { usageRange = e.target.value; pollUsage(); };

/* ---------------- logs (read-only tail) ---------------- */
async function pollLogs() {
    if (document.hidden) return;
    try {
        const d = await fetchJson(`${API}/admin/api/logs?lines=200`);
        let lines = String(d.logs || '').split('\n').filter(Boolean);
        const shownTotal = lines.length;
        if (layout.logsHideDebug) lines = lines.filter(l => !/ - DEBUG - /.test(l));
        const pre = $('logs');
        pre.innerHTML = '';
        for (const line of lines.slice(-150)) {
            const span = document.createElement('span');
            const level = / - (ERROR|WARNING) - /.exec(line);
            if (level) span.className = `lv-${level[1]}`;
            span.textContent = line + '\n';
            pre.append(span);
        }
        $('logs-sub').textContent = `${lines.length}${layout.logsHideDebug ? `/${shownTotal}` : ''} lines`;
    } catch (_) { /* logs endpoint requires admin session; silent when absent */ }
}

/* ---------------- boot ---------------- */
fetchJson(`${API}/admin/api/device-info`).then(d => {
    $('chip-device').textContent = `${d.chip_name}${d.chip_variant === 'Max' ? ' Max' : ''} · ${d.memory_gb} GB · ${d.gpu_cores}c`;
    $('chip-device').classList.add('state-ok');
}).catch(() => {});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    pollStats(); pollUsage(); pollLogs(); resizeCharts();
});

applyPrefs();
applyLayout();
createCharts();
resizeCharts();
restartPolling();
pollUsage(); pollLogs();
usageTimer = setInterval(pollUsage, 15000);
logsTimer = setInterval(pollLogs, 12000);
})();
