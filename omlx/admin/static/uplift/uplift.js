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
const THEME_CYCLE = ['auto', 'light', 'dark', 'enhanced'];
function applyPrefs() {
    const t = prefs.theme;
    let eff = t;
    if (t === 'auto') eff = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = eff;
    const motionOff = prefs.motion === 'off' ||
        matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.dataset.motion = motionOff ? 'off' : 'auto';
    $('btn-motion').style.opacity = motionOff ? 0.4 : 1;
    rerenderChartsTheme();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);

const motionOff = () => document.documentElement.dataset.motion === 'off';
$('btn-theme').onclick = () => {
    prefs.theme = THEME_CYCLE[(THEME_CYCLE.indexOf(prefs.theme) + 1) % THEME_CYCLE.length];
    C.savePrefs(localStorage, prefs); applyPrefs();
    toast('Theme: ' + prefs.theme);
};
$('btn-motion').onclick = () => {
    prefs.motion = document.documentElement.dataset.motion === 'off' ? 'auto' : 'off';
    C.savePrefs(localStorage, prefs); applyPrefs();
};

/* ---------------- layout engine (popover + collapse + columns + DnD) ---------------- */
const cards = [...document.querySelectorAll('.card')];
const DEFAULT_ORDER = cards.map(c => c.dataset.id);   // markup document order = truth

function applyOrder() {
    const grid = $('grid');
    const known = new Set(DEFAULT_ORDER);
    const ordered = layout.order.filter(id => known.has(id));
    const rest = DEFAULT_ORDER.filter(id => !ordered.includes(id));
    for (const id of [...ordered, ...rest]) {
        const card = grid.querySelector(`.card[data-id="${id}"]`);
        if (card) grid.append(card);
    }
}
function readOrder() {
    layout.order = [...$('grid').querySelectorAll('.card')].map(c => c.dataset.id);
}
for (const card of cards) {
    // Grip handle for dragging.
    const grip = document.createElement('button');
    grip.className = 'grip'; grip.title = 'Drag to move'; grip.textContent = '⠿';
    card.querySelector('h2').prepend(grip);
    card.querySelector('.collapse').after(grip);   // order: collapse, grip, title
}

/* Pointer-Events drag (NOT HTML5 DnD: unreliable in Safari/WebKit).
   Window-level move/up listeners survive DOM rearrangement; the source slot
   stays occupied by a marker; the node moves once on pointerup. */
(function enableDrag() {
    const DRAG_THRESHOLD = 4;
    let drag = null;   // {card, marker, offsetX, offsetY, startX, startY, active}
    const cleanup = () => {
        if (!drag) return;
        drag.card.classList.remove('dragging');
        drag.card.style.cssText = '';
        drag.marker?.remove();
        document.body.classList.remove('dragging-in-progress');
        drag = null;
    };

    document.addEventListener('pointerdown', e => {
        const grip = e.target.closest('.grip');
        if (!grip || e.button !== 0) return;
        const card = grip.closest('.card');
        const rect = card.getBoundingClientRect();
        drag = { card, marker: null, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
                 startX: e.clientX, startY: e.clientY, width: rect.width, height: rect.height, active: false };
        e.preventDefault();
    });

    window.addEventListener('pointermove', e => {
        if (!drag) return;
        if (!drag.active) {
            const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
            if (moved < DRAG_THRESHOLD) return;
            drag.active = true;
            document.body.classList.add('dragging-in-progress');
            drag.marker = document.createElement('div');
            drag.marker.className = 'drop-marker';
            drag.card.after(drag.marker);
            drag.card.classList.add('dragging');
            drag.card.style.width = drag.width + 'px';
            drag.card.style.height = drag.height + 'px';
        }
        drag.card.style.left = (e.clientX - drag.offsetX) + 'px';
        drag.card.style.top = (e.clientY - drag.offsetY) + 'px';
        // Insertion point: before the first card whose center is below/right of
        // the pointer; append at end when past all of them.
        const grid = $('grid');
        let target = null;
        for (const other of grid.querySelectorAll('.card:not(.dragging)')) {
            const r = other.getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2 ||
                (e.clientY < r.bottom && e.clientX < r.left + r.width / 2)) {
                target = other; break;
            }
        }
        grid.insertBefore(drag.marker, target);   // target null => append
        // Edge auto-scroll.
        const edge = 60;
        if (e.clientY < edge) window.scrollBy(0, -12);
        else if (e.clientY > innerHeight - edge) window.scrollBy(0, 12);
    }, true);

    const finish = e => {
        if (!drag) return;
        if (drag.active && drag.marker) {
            drag.card.classList.remove('dragging');
            drag.card.style.cssText = '';
            drag.marker.replaceWith(drag.card);   // land where the marker sits
            readOrder();
            C.saveLayout(localStorage, layout);
        }
        cleanup();
    };
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', () => cleanup(), true);
    window.addEventListener('blur', () => cleanup(), true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') cleanup(); });
    addEventListener('resize', () => { if (drag?.active) cleanup(); }, true);
})();

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
counter('v-ttft',       v => C.fmtNumber(v));
counter('v-errrate',    v => v.toFixed(2) + '%');

/* ---------------- charts ---------------- */
const axisFont = '10px ui-monospace, SFMono-Regular, Menlo, monospace'; // uPlot 1.6.32: plain string only
const tpsData = [[], [], []];   // time, gen, prefill
const memData = [[], []];       // time, percent
const MAX_POINTS = 4000;        // covers 1h at 1s polls plus usage headroom

function chartColors() {
    const cs = getComputedStyle(document.documentElement);
    return { dim: cs.getPropertyValue('--dim').trim() || '#a5a096',
             grid: cs.getPropertyValue('--grid').trim() || '#3a3b40',
             blue: cs.getPropertyValue('--chart-1').trim() || '#f2f0ea',
             gold: cs.getPropertyValue('--chart-2').trim() || '#e8a020' };
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
    // resetScale=true (default): frozen auto-scales from the empty first draw
    // would otherwise pin the y-range at 0..1 forever and render blank charts.
    tpsChart.setData(windowedData(tpsData));
    memChart.setData(windowedData(memData));
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
               colors: ['#c9243b', '#e8a020', '#f2f0ea', '#767268'] });
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
    renderRequestStats(s);

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

/* Request sizes: prefer server-side full-population stats (mock endpoint or
   future real backend); fall back to client-side session tracker when absent. */
function renderRequestStats(s) {
    fillSelectOnce();
    const p = PERCENTILES[layout.percentile];
    const server = s && s.requestStats ? s.requestStats : null;
    const pick = (blk, key) => blk && blk[key] !== undefined && blk[key] !== null ? blk[key] : null;
    const pKey = { p50: 'p50', p90: 'p90', p95: 'p95', p99: 'p99' }[layout.percentile];

    if (server) {
        const pt = server.prompt_tokens || {}, ct = server.completion_tokens || {};
        setCounter('v-prompt-avg', pt.avg ?? null);
        setCounter('v-compl-avg', ct.avg ?? null);
        setCounter('v-prompt-pct', pick(pt, pKey));
        setCounter('v-compl-pct', pick(ct, pKey));
        const ft = server.first_token_ms || {};
        setCounter('v-ttft', pick(ft, pKey) ?? ft.avg ?? null);
        const n = (pt.n || 0), errs = server.errors_total || 0;
        setCounter('v-errrate', (n + errs) > 0 ? errs / (n + errs) * 100 : null);
        $('reqstats-note').textContent =
            `server full-population stats · ${n} samples` + (server.source ? ` (${server.source})` : '');
        return;
    }
    // Client-side fallback (session samples only).
    const promptSamples = tracker.samples.prompt, complSamples = tracker.samples.completion;
    setCounter('v-prompt-avg', usageAvg ? usageAvg.prompt : (C.mean(promptSamples) ?? null));
    setCounter('v-compl-avg', usageAvg ? usageAvg.completion : (C.mean(complSamples) ?? null));
    setCounter('v-prompt-pct', C.percentile(promptSamples, p));
    setCounter('v-compl-pct', C.percentile(complSamples, p));
    setCounter('v-ttft', null);
    setCounter('v-errrate', null);
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
async function fetchJson(url, opts) {
    const res = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}));
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}
/* Write helpers: mock backend (and future real backend) endpoints. */
async function putModelSettings(model, settings) {
    const res = await fetch(`${API}/admin/api/models/${encodeURIComponent(model)}/settings`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail ? JSON.stringify(body.detail) : res.status);
    return body;
}
async function postModelAction(model, action) {
    const res = await fetch(`${API}/admin/api/models/${encodeURIComponent(model)}/${action}`,
        { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || res.status);
    return body;
}
const canWrite = () => true;   // writes are attempted; failures surface in the UI toast
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

/* ---------------- request lifecycle feed (mock / future backend) ---------------- */
const REQ_STATES = ['queued', 'prefilling', 'generating', 'complete', 'error'];
const MAX_REQFEED = 30;
let reqFeedRows = new Map();   // id -> {state, model, prompt, completion, tps, error, ts}
let sseSource = null;

function renderReqFeed() {
    const list = $('reqfeed');
    const rows = [...reqFeedRows.values()];
    $('reqfeed-sub').textContent = rows.length
        ? `${rows.filter(r => ['queued','prefilling','generating'].includes(r.state)).length} active` : '';
    if (!rows.length) {
        if (!list.querySelector('.empty')) list.innerHTML = '<div class="empty">No requests yet</div>';
        return;
    }
    list.innerHTML = '';
    for (const r of rows.slice(0, MAX_REQFEED)) {
        const row = document.createElement('div'); row.className = 'model-row';
        const badge = document.createElement('span');
        badge.className = `badge ${r.state.charAt(0).toUpperCase() + r.state.slice(1)}`;
        badge.textContent = r.state;
        const name = document.createElement('span');
        name.className = 'model-name';
        name.textContent = r.error ? `${r.id} — ${r.error}` : r.id;
        name.title = `${r.model} · ${r.id}`;
        const meta = document.createElement('span');
        meta.className = 'model-meta';
        const bits = [`in ${C.fmtCompact(r.prompt)}`];
        if (r.completion) bits.push(`out ${C.fmtCompact(r.completion)}`);
        if (r.tps) bits.push(`${r.tps.toFixed(0)} t/s`);
        meta.textContent = bits.join(' · ');
        row.append(badge, name, meta);
        list.append(row);
    }
}
function upsertReq(id, patch) {
    const prev = reqFeedRows.get(id) || { prompt: 0, completion: 0 };
    reqFeedRows.set(id, Object.assign({}, prev, patch, { ts: Date.now() }));
    // Keep the newest MAX_REQFEED * 3 records, then trim finished ones first.
    if (reqFeedRows.size > MAX_REQFEED * 3) {
        const sorted = [...reqFeedRows.entries()]
            .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
        for (const [id2, r] of sorted.slice(MAX_REQFEED)) {
            if (['complete', 'error'].includes(r.state)) reqFeedRows.delete(id2);
        }
    }
    renderReqFeed();
}
function pushServerEvent(ev) {
    if (ev.type === 'request') {
        upsertReq(ev.id, { state: ev.state, model: ev.model });
        pushFeed([{ kind: 'requests', text: `${ev.id.slice(0, 6)} → ${ev.state}` }]);
        if (ev.state === 'error') flashCard('v-errrate', 'bad');
        if (ev.state === 'complete') flashCard('v-requests', 'ok');
    } else if (ev.type === 'model-load') {
        pushFeed([{ kind: 'model-add', model: ev.id, text: `${ev.id} load requested` }]);
    } else if (ev.type === 'model-unload') {
        pushFeed([{ kind: 'model-remove', model: ev.id, text: `${ev.id} unload` }]);
    } else if (ev.type === 'settings') {
        pushFeed([{ kind: 'requests', text: `${ev.id}: settings ${ev.changed.join(', ')}` }]);
    }
}
function connectEventStream() {
    if (sseSource || !window.EventSource) return;
    try {
        sseSource = new EventSource(`${API}/admin/api/requests/stream`);
        sseSource.onmessage = e => { try { pushServerEvent(JSON.parse(e.data)); } catch (_) {} };
        sseSource.onerror = () => { /* keep EventSource's own retry */ };
    } catch (_) { sseSource = null; }
}
async function pollRequests() {
    if (document.hidden) return;
    try {
        const d = await fetchJson(`${API}/admin/api/requests?limit=30`);
        for (const r of d.requests)
            upsertReq(r.id, { state: r.state, model: r.model, prompt: r.prompt_tokens,
                              completion: r.completion_tokens, tps: r.tps, error: r.error });
    } catch (_) { /* endpoint absent on real backend; feed stays as-is */ }
}

/* ---------------- model admin (settings editor, load/unload) ---------------- */
const SE_FIELDS = [
    ['temperature', 'num', 0, 2, 0.05],
    ['top_p', 'num', 0, 1, 0.05],
    ['max_tokens', 'num', 1, 32768, 1],
    ['ttl_seconds', 'num', 30, 86400, 30],
    ['reasoning_effort', 'select', ['auto', 'none', 'low', 'medium', 'high']],
];
let seModel = null, seValues = {};
function closeEditor() { $('settings-editor').hidden = true; seModel = null; }
async function openEditor(model) {
    seModel = model;
    $('se-model').textContent = model;
    const fields = $('se-fields');
    fields.innerHTML = '';
    try {
        const d = await fetchJson(`${API}/admin/api/models/${encodeURIComponent(model)}/settings`);
        seValues = d.settings || {};
    } catch (_) { seValues = {}; }
    for (const [key, kind, a, b, step] of SE_FIELDS) {
        const label = document.createElement('label');
        label.className = 'se-row';
        const name = document.createElement('span');
        name.textContent = key;
        let input;
        if (kind === 'select') {
            input = document.createElement('select');
            for (const opt of a) {
                const o = document.createElement('option');
                o.value = opt; o.textContent = opt;
                if (seValues[key] === opt) o.selected = true;
                input.append(o);
            }
        } else {
            input = document.createElement('input');
            input.type = 'number';
            input.min = a; input.max = b; input.step = step;
            input.value = seValues[key] ?? '';
        }
        input.dataset.key = key;
        label.append(name, input);
        fields.append(label);
    }
    $('se-msg').textContent = '';
    $('settings-editor').hidden = false;
}
async function saveEditor() {
    if (!seModel) return;
    const payload = {};
    for (const input of $('se-fields').querySelectorAll('[data-key]')) {
        const v = input.value;
        if (v === '') continue;
        payload[input.dataset.key] = input.type === 'number' ? Number(v) : v;
    }
    $('se-msg').textContent = 'saving…';
    try {
        await putModelSettings(seModel, payload);
        $('se-msg').textContent = 'saved ✓';
        toast(`Settings saved: ${seModel}`);
        setTimeout(closeEditor, 900);
    } catch (err) {
        $('se-msg').textContent = `error: ${err.message}`;
        toast(`Save failed: ${err.message}`);
    }
}
$('se-save').onclick = saveEditor;
$('se-cancel').onclick = closeEditor;

async function renderModelAdmin() {
    let models;
    try { models = (await fetchJson(`${API}/admin/api/models`)).models; }
    catch (_) { $('model-admin').innerHTML = ''; return; }
    const table = $('model-admin');
    table.innerHTML = '';
    if (!models.length) return;
    const head = document.createElement('div'); head.className = 'urow head';
    for (const h of ['model', 'state', 'settings', '']) {
        const s = document.createElement('span'); s.textContent = h; head.append(s);
    }
    table.append(head);
    for (const m of models) {
        const row = document.createElement('div'); row.className = 'urow';
        const name = document.createElement('span');
        name.className = 'uname'; name.textContent = (m.pinned ? '📌 ' : '') + m.id; name.title = m.id;
        const state = document.createElement('span');
        state.textContent = m.loading ? 'loading' : m.loaded ? 'loaded' : 'unloaded';
        const settings = document.createElement('span');
        const s = m.settings || {};
        settings.textContent = `T${s.temperature ?? '—'} · ${s.max_tokens ?? '—'}`;
        const actions = document.createElement('span');
        actions.style.display = 'flex'; actions.style.gap = '4px'; actions.style.justifyContent = 'flex-end';
        const btn = (label, fn, title) => {
            const b = document.createElement('button');
            b.className = 'se-btn'; b.textContent = label; b.title = title || label;
            b.onclick = async () => {
                try { await fn(); } catch (err) { toast(`${label} failed: ${err.message}`); }
                renderModelAdmin();
            };
            return b;
        };
        actions.append(btn('⚙', () => openEditor(m.id), 'Edit settings'));
        if (m.loaded) actions.append(btn('unload', () => postModelAction(m.id, 'unload')));
        else actions.append(btn('load', () => postModelAction(m.id, 'load')));
        row.append(name, state, settings, actions);
        table.append(row);
    }
}
renderModelAdmin();
setInterval(() => { if (!document.hidden) renderModelAdmin(); }, 15000);
connectEventStream();
setInterval(() => { if (!document.hidden) pollRequests(); }, 2000);

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
            cell.style.background = v > 0 ? `color-mix(in oklab, var(--heat) ${Math.round(a * 100)}%, transparent)` : '';
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
applyOrder();
applyLayout();
createCharts();
resizeCharts();
restartPolling();
pollUsage(); pollLogs();
usageTimer = setInterval(pollUsage, 15000);
logsTimer = setInterval(pollLogs, 12000);
})();
