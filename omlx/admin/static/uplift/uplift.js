/* Uplift UI controller. Reads via the mock gateway (default :11437), which
   proxies real oMLX and intercepts writes into a shadow layer. ?api= overrides. */
(function () {
'use strict';
const C = window.UpliftCore;
const $ = id => document.getElementById(id);

/* API base: the gateway is the single source for the UI. It reads real oMLX
   and layers simulated data. Override with ?api= (e.g. =http://127.0.0.1:11435
   to bypass, or empty when served by oMLX itself in future hosting). */
const qp = new URLSearchParams(location.search);
const API = qp.has('api') ? qp.get('api') : 'http://127.0.0.1:11437';

const prefs = C.loadPrefs(localStorage);
const layout = C.loadLayout(localStorage);
const tracker = C.createRequestTracker(2000);
let stats = null, prevStats = null, failCount = 0, timer = null;
let usageRange = qp.get('range') || 'today';
const PERCENTILES = { p50: 50, p90: 90, p95: 95, p99: 99 };
if (!(layout.percentile in PERCENTILES)) layout.percentile = 'p95';

/* ---------------- tabs (hash routing, like the classic dashboard) --------- */
const TABS = ['status', 'models', 'usage', 'logs', 'settings'];
function currentTab() {
    const t = (location.hash || '').replace('#', '');
    return TABS.includes(t) ? t : 'status';
}
function applyTab() {
    const tab = currentTab();
    document.documentElement.dataset.tab = tab;
    for (const a of $('tabs').children) a.classList.toggle('active', a.dataset.tab === tab);
    for (const card of cards) {
        const show = (card.dataset.tab || 'status') === tab;
        card.style.display = show ? '' : 'none';
    }
    requestAnimationFrame(resizeCharts);   // charts may have become visible
    if (tab === 'usage') pollUsage();
    if (tab === 'logs') pollLogs();
    if (tab === 'models') renderModelAdmin();
    if (tab === 'settings') pollGlobalSettings();
}
addEventListener('hashchange', applyTab);
// Keyboard: 1–5 jump to tabs (ignored while typing in inputs).
document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const i = ['1', '2', '3', '4', '5'].indexOf(e.key);
    if (i >= 0) location.hash = '#' + TABS[i];
});

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

/* ---------------- layout engine (popover + collapse + columns + DnD) ------ */
const cards = [...document.querySelectorAll('.card')];
const DEFAULT_ORDER = cards.map(c => c.dataset.id);   // markup document order = truth

function applyOrder() {
    const grid = $('grid');
    const known = new Set(DEFAULT_ORDER);
    const ordered = layout.order.filter(id => known.has(id));
    const rest = DEFAULT_ORDER.filter(id => !ordered.includes(id));
    // Sort within tab groups so cross-tab drags cannot interleave tabs.
    for (const id of [...ordered, ...rest]) {
        const card = grid.querySelector(`.card[data-id="${id}"]`);
        if (card) grid.append(card);
    }
}
function readOrder() {
    layout.order = [...$('grid').querySelectorAll('.card')].map(c => c.dataset.id);
}
for (const card of cards) {
    const grip = document.createElement('button');
    grip.className = 'grip'; grip.title = 'Drag to move'; grip.textContent = '⠿';
    card.querySelector('h2').prepend(grip);
    card.querySelector('.collapse').after(grip);   // order: collapse, grip, title
}

/* Pointer-Events drag (NOT HTML5 DnD: unreliable in Safari/WebKit). */
(function enableDrag() {
    const DRAG_THRESHOLD = 4;
    let drag = null;
    const cleanup = () => {
        if (!drag) return;
        drag.card.classList.remove('dragging');
        drag.card.style.cssText = '';
        drag.card.style.display = '';           // reflow safety after move
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
                 startX: e.clientX, startY: e.clientY, width: rect.width, height: rect.height,
                 tab: card.dataset.tab || 'status', active: false };
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
            drag.card.style.position = 'fixed';
            drag.card.style.width = drag.width + 'px';
            drag.card.style.height = drag.height + 'px';
            drag.card.style.zIndex = 50;
        }
        drag.card.style.left = (e.clientX - drag.offsetX) + 'px';
        drag.card.style.top = (e.clientY - drag.offsetY) + 'px';
        const grid = $('grid');
        let target = null;
        for (const other of grid.querySelectorAll('.card:not(.dragging)')) {
            if ((other.dataset.tab || 'status') !== drag.tab) continue;  // same tab only
            if (other.style.display === 'none') continue;
            const r = other.getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2 ||
                (e.clientY < r.bottom && e.clientX < r.left + r.width / 2)) {
                target = other; break;
            }
        }
        grid.insertBefore(drag.marker, target);
        const edge = 60;
        if (e.clientY < edge) window.scrollBy(0, -12);
        else if (e.clientY > innerHeight - edge) window.scrollBy(0, 12);
    }, true);
    const finish = () => {
        if (!drag) return;
        if (drag.active && drag.marker) {
            drag.card.classList.remove('dragging');
            drag.card.style.cssText = '';
            drag.marker.replaceWith(drag.card);
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
        card.style.setProperty('--span', card.dataset.full ? layout.cols : C.clampSpan(want, layout.cols));
        const collapsed = layout.collapsed[id] === true;
        card.classList.toggle('is-collapsed', collapsed);
        card.querySelector('.collapse').textContent = collapsed ? '+' : '–';
    }
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
$('opt-hide-debug').onchange = e => { layout.logsHideDebug = e.target.checked; C.saveLayout(localStorage, layout); };
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

/* ---------------- animated counters (lightweight rAF tween) --------------- */
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
counter('v-u-req',      v => C.fmtNumber(v));
counter('v-u-tok',      v => C.fmtCompact(v));
counter('v-u-prompt',   v => C.fmtCompact(v));
counter('v-u-compl',    v => C.fmtCompact(v));

/* ---------------- charts ---------------- */
const axisFont = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
/* Remember where the mouse is hovering, by TIMESTAMP not index: setData on a
   sliding window shifts indices, which made hovered values snap to the latest
   sample after the next poll (looked like hover only worked on data points). */
const hoverTs = new WeakMap();       // chart -> hovered timestamp (ms) | null
function rememberHover(c) {
    if (c.cursor.idx === null || c.cursor.idx === undefined) { hoverTs.set(c, null); return; }
    const ts = c.data[0][c.cursor.idx];
    if (typeof ts === 'number') hoverTs.set(c, ts);
}
function restoreCursor(c) {
    const t = hoverTs.get(c);
    if (t === null || t === undefined) return;
    const xs = c.data[0];
    if (!xs.length) return;
    let i = 0, best = Infinity;
    for (let k = 0; k < xs.length; k++) {
        const d = Math.abs(xs[k] - t);
        if (d < best) { best = d; i = k; }
    }
    c.setCursor({ idx: i }, false);  // fires hooks + moves the focus point
}
const tpsData = [[], [], []];        // time, generation tok/s, prefill tok/s
const memData = [[], [], [], [], [], []];  // time, memory %, cache GB, hot1, hot2, hot3
const MAX_POINTS = 4000;
let cacheSeriesIds = [];             // top-3 models currently drawn on mem chart

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
function line(label, colorVar, fill, scale) {
    const col = chartColors()[colorVar];
    return { label, scale: scale || 'y', stroke: col, width: 2,
             fill: fill ? col + '22' : undefined,
             points: { show: false }, value: seriesValue };
}
function xAxis(col) {
    return { stroke: col.dim, width: 1, size: 42, font: axisFont,
             values: (s, t) => t.map(ts => new Date(ts).toLocaleTimeString('en-GB',
                 { hour: '2-digit', minute: '2-digit', ...(layout.chartWindowSec < 900 ? { second: '2-digit' } : {}) })) };
}
function yAxis(col, opts) {
    // size includes tick labels AND the rotated axis label; 40 was too tight
    // for the right axes and the label overlapped the ticks.
    return Object.assign({ stroke: col.dim, size: 40, font: axisFont, grid: true, gap: 6 }, opts || {});
}
function baseOpts(specs, axes, legendHook) {
    const col = chartColors();
    return {
        width: 0, height: 240, padding: [6, 8, 0, 0],
        cursor: { drag: { x: false, y: false }, points: { show: true, size: 6, fill: col.dim } },
        legend: { show: true, top: true, live: false, labels: { fontSize: '10px' } },
        scales: Object.assign({ x: { time: true }, y: { auto: true } }, axes.scales || {}),
        axes: [xAxis(col), ...axes.yAxes],
        hooks: legendHook ? { cursor: { subscribe: [legendHook] } } : undefined,
        series: [{}, ...specs],
    };
}
/* Legend value updater: latest sample when idle, hovered sample on mouse-over.
   With live:false uPlot renders no value cells (vendor CSS hides them), so we
   append our own to each series row and fill them. Reads c.data — the windowed
   slice currently displayed — so indices always match c.cursor.idx. */
function legendUpdater() {
    return c => {
        rememberHover(c);
        const rows = [...c.root.querySelectorAll('.u-legend .u-series')];
        if (!rows.length) return;
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
            const colData = c.data[sIdx + 1];
            const v = colData && colData.length ? colData[i] : null;
            cell.textContent = (v === null || v === undefined) ? '—' : seriesValue(v);
        });
    };
}
let tpsChart = null, memChart = null, usageChart = null;
function createCharts() {
    if (tpsChart) { tpsChart.destroy(); memChart.destroy(); tpsChart = memChart = null; }
    const col = chartColors();
    // Dual Y: left = generation tok/s, right = prefill tok/s (prefill >> gen).
    const tpsOpts = baseOpts(
        [line('generation', 'blue', true, 'y'), line('prefill', 'gold', false, 'y2')],
        { scales: { y2: { auto: true } },
          yAxes: [Object.assign(yAxis(col, { grid: false, label: 'gen tok/s', stroke: col.blue }), { scale: 'y' }),
                  Object.assign(yAxis(col, { side: 1, grid: false, label: 'prefill tok/s', stroke: col.gold, size: 58 }), { scale: 'y2' })] },
        legendUpdater());
    // y2 axis sits on the right; uPlot axis 'side': 1=right of grid, 3=left.
    tpsChart = new uPlot(tpsOpts, windowedData(tpsData), $('chart-tps'));
    window.__uplotTps = tpsChart;   // debug handle
    // Memory % left; runtime cache GB (total + top-3 models' hot cache) right.
    const memSpecs = [line('model memory', 'blue', true, 'y'),
                      line('cache total', 'gold', false, 'y2')];
    for (let i = 0; i < cacheSeriesIds.length; i++) {
        const shortId = cacheSeriesIds[i].length > 14
            ? cacheSeriesIds[i].slice(0, 13) + '…' : cacheSeriesIds[i];
        const s = line('hot:' + shortId, ['gold', 'blue', 'dim'][i], false, 'y2');
        s.dash = [4, 4];
        memSpecs.push(s);
    }
    const memOpts = baseOpts(memSpecs,
        { scales: { y2: { auto: true } },
          yAxes: [Object.assign(yAxis(col, { label: 'memory %', stroke: col.blue }), { scale: 'y' }),
                  Object.assign(yAxis(col, { side: 1, grid: false, label: 'cache GB', stroke: col.gold, size: 58 }), { scale: 'y2' })] },
        legendUpdater());
    memOpts.scales.y = { range: [0, 100] };
    memChart = new uPlot(memOpts, windowedData(memData), $('chart-mem'));
    resizeCharts();
    redrawCharts();
}
function redrawCharts() {
    if (!tpsChart) return;
    tpsChart.setData(windowedData(tpsData));
    memChart.setData(windowedData(memData));
    // Keep the hovered position pinned across polls (index shifts otherwise);
    // when not hovering, show the latest samples.
    restoreCursor(tpsChart) || legendUpdater()(tpsChart);
    restoreCursor(memChart) || legendUpdater()(memChart);
    const shown = windowedData(tpsData)[0].length;
    $('chart-tps-window').textContent = shown > 1 ? `${layout.chartWindowSec >= 3600 ? '1h' : layout.chartWindowSec / 60 + 'm'} window` : '';
}
function rerenderChartsTheme() { createCharts(); if (usageChart) createUsageChart(); }
function resizeCharts() {
    if (!tpsChart) return;
    const w1 = $('chart-tps').clientWidth, w2 = $('chart-mem').clientWidth;
    if (w1 > 0) tpsChart.setSize({ width: w1, height: 240 });
    if (w2 > 0) memChart.setSize({ width: w2, height: 240 });
    const w3 = $('chart-usage')?.clientWidth;
    if (usageChart && w3 > 0) usageChart.setSize({ width: w3, height: 200 });
}
new ResizeObserver(resizeCharts).observe($('grid'));
/* Pointer left the plot: drop the pinned hover so legends show latest again. */
for (const sel of ['#chart-tps', '#chart-mem']) {
    const el = $(sel.slice(1));
    if (el) el.addEventListener('mouseleave', () => {
        hoverTs.set(sel === '#chart-tps' ? tpsChart : memChart, null);
        const c = sel === '#chart-tps' ? tpsChart : memChart;
        if (c) { c.setCursor({ idx: c.data[0].length - 1 }, false); }
    });
}

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
    const el = $(id); if (!el) return;
    const card = el.closest('.card'); if (!card || motionOff()) return;
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
/* Milestone gate: fire each round crossing at most once per page session,
   immune to overlapping polls comparing against a stale snapshot (that
   re-reported the same crossing and made toasts/confetti fire twice). */
const milestoneFloor = {};   // key -> highest multiple already celebrated
function milestoneStep(key) { return key === 'requests' ? 1000 : 1e6; }
function gateMilestones(hits) {
    const fresh = [];
    for (const h of hits) {
        const step = milestoneStep(h.key);
        const crossed = Math.floor(h.value / step);
        if (milestoneFloor[h.key] === undefined) {
            milestoneFloor[h.key] = crossed;   // baseline at page load; later crossings fire
            continue;
        }
        if (crossed > milestoneFloor[h.key]) {
            milestoneFloor[h.key] = crossed;
            fresh.push(h);
        } else if (crossed < milestoneFloor[h.key]) {
            milestoneFloor[h.key] = crossed;   // server restart: re-baseline silently
        }
    }
    return fresh;
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

    renderLive(s);
    renderRequestStats(s);

    // Chart buffers (window pruning happens at draw time).
    tpsData[0].push(s.time); tpsData[1].push(s.genTps); tpsData[2].push(s.prefillTps);
    while (tpsData[0].length > MAX_POINTS) { tpsData[0].shift(); tpsData[1].shift(); tpsData[2].shift(); }
    const cacheGB = s.cacheBytes === null ? null : +(s.cacheBytes / 1e9).toFixed(3);
    // Per-model hot cache (GB): keep a stable top-3 set; rebuild chart on change.
    const hotSorted = (s.cacheModels || []).slice()
        .sort((a, b) => (b.hotBytes || 0) - (a.hotBytes || 0)).slice(0, 3);
    const hotIds = hotSorted.map(m => m.id);
    if (hotIds.join('|') !== cacheSeriesIds.join('|')) {
        cacheSeriesIds = hotIds;
        // Reset per-model columns so old series values do not mislabel.
        for (let ci = 3; ci < memData.length; ci++) memData[ci] = memData[0].map(() => null);
        createCharts();
    }
    memData[0].push(s.time); memData[1].push(s.memPercent === null ? null : +s.memPercent.toFixed(2));
    memData[2].push(cacheGB);
    for (let i = 0; i < 3; i++) {
        const m = hotSorted[i];
        memData[3 + i].push(m && m.hotBytes !== null ? +(m.hotBytes / 1e9).toFixed(3) : null);
    }
    while (memData[0].length > MAX_POINTS) for (const col of memData) col.shift();
    redrawCharts();
}

function renderLive(s) {
    const list = $('live-list');
    const rows = [];
    for (const m of s.models) {
        for (const p of m.prefilling) rows.push({ model: m.id, kind: 'Prefilling', prompt: p.prompt, progress: p.progress });
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
        row.style.flexWrap = 'wrap';
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
        if (r.progress !== undefined && r.progress !== null) bits.push(`${Math.round(r.progress * 100)}%`);
        meta.textContent = bits.join(' · ');
        row.append(badge, name, meta);
        if (r.progress !== undefined && r.progress !== null) {
            const bar = document.createElement('div');
            bar.className = 'meter'; bar.style.flex = '1 0 100%'; bar.style.marginTop = '4px';
            const fill = document.createElement('div');
            fill.style.width = Math.round(r.progress * 100) + '%';
            bar.append(fill);
            row.append(bar);
        }
        list.append(row);
    }
}

/* Request sizes: prefer server-side full-population stats (gateway overlay);
   fall back to client-side session tracker when absent. */
let usageAvg = null;
function renderRequestStats(s) {
    fillSelectOnce();
    const p = PERCENTILES[layout.percentile];
    const server = s && s.requestStats ? s.requestStats : null;
    const pick = (blk, key) => blk && blk[key] !== undefined && blk[key] !== null ? blk[key] : null;
    const pKey = layout.percentile;

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
            `server stats · ${n} samples` +
            (server.observed_real !== undefined ? ` (${server.observed_real} real, ${server.simulated} simulated)` : '') +
            (server.source ? ` · ${server.source}` : '');
        return;
    }
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
    $('opt-percentile').onchange = e => { layout.percentile = e.target.value; C.saveLayout(localStorage, layout); renderRequestStats(stats); };
}

/* ---------------- polling ---------------- */
async function fetchJson(url, opts) {
    const res = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}));
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}
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
        if (milestoneFloor.requests === undefined && s.requests !== null)
            milestoneFloor.requests = Math.floor(s.requests / milestoneStep('requests'));
        if (milestoneFloor.totalTokens === undefined && s.totalTokens !== null)
            milestoneFloor.totalTokens = Math.floor(s.totalTokens / milestoneStep('totalTokens'));
        tracker.observe(s);
        render(s);
        reactTo(events);
        for (const mi of gateMilestones(miles)) celebrate(`${C.fmtNumber(mi.value)} ${mi.label}`);
    } catch (err) {
        if (++failCount >= 2) {
            document.body.classList.add('stale');
            $('banner-text').textContent = `Cannot reach API at ${API || location.origin}: ${err.message}`;
            $('banner').classList.add('show');
        }
    }
}
function restartPolling() {
    clearInterval(timer);
    pollStats();
    timer = setInterval(pollStats, layout.intervalMs);
}

/* ---------------- gateway status chip ---------------- */
async function pollGatewayInfo() {
    const chip = $('chip-gateway');
    if (API !== 'http://127.0.0.1:11437') { chip.textContent = 'direct'; chip.title = 'API ' + (API || location.origin); return; }
    try {
        const d = await fetchJson(`${API}/admin/api/mock/info`);
        chip.textContent = d.ok
            ? `gw↑ok · r${d.observed_real}/s${d.simulated}`
            : 'gw↑down';
        chip.classList.toggle('state-ok', !!d.ok);
        chip.title = `gateway → ${d.upstream}: ${d.ok ? 'reachable' : (d.last_error || 'unreachable')}\n` +
                     `shadow overrides: ${Object.keys(d.overrides || {}).length} · sim ${d.sim_rate}/s`;
    } catch (_) { chip.textContent = 'gw?'; chip.classList.remove('state-ok'); }
}

/* ---------------- request lifecycle feed ---------------- */
const MAX_REQFEED = 30;
let reqFeedRows = new Map();
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
        if (r.origin === 'real') { badge.title = 'real traffic'; }
        const name = document.createElement('span');
        name.className = 'model-name';
        name.textContent = r.error ? `${r.id} — ${r.error}` : (r.origin === 'real' ? '◆ ' : '') + r.id;
        name.title = `${r.model} · ${r.id}`;
        const meta = document.createElement('span');
        meta.className = 'model-meta';
        const bits = [];
        if (r.prompt) bits.push(`in ${C.fmtCompact(r.prompt)}`);
        if (r.completion) bits.push(`out ${C.fmtCompact(r.completion)}`);
        if (r.tps) bits.push(`${r.tps.toFixed(0)} t/s`);
        meta.textContent = bits.join(' · ');
        row.append(badge, name, meta);
        if (['queued', 'prefilling', 'generating'].includes(r.state)) {
            const x = document.createElement('button');
            x.className = 'se-btn'; x.textContent = '✕'; x.title = 'Cancel request';
            x.onclick = async () => {
                try {
                    const res = await fetch(`${API}/admin/api/requests/${encodeURIComponent(r.id)}/cancel`, { method: 'POST' });
                    if (res.status === 501) { toast('Real request — oMLX has no cancel route yet'); return; }
                    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.status);
                    toast(`Cancelled ${r.id.slice(0, 6)}`);
                } catch (err) { toast(`Cancel failed: ${err.message}`); }
                pollRequests();
            };
            row.append(x);
        }
        list.append(row);
    }
}
function upsertReq(id, patch) {
    const prev = reqFeedRows.get(id) || { prompt: 0, completion: 0 };
    reqFeedRows.set(id, Object.assign({}, prev, patch, { id, ts: Date.now() }));
    if (reqFeedRows.size > MAX_REQFEED * 3) {
        const sorted = [...reqFeedRows.entries()].sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
        for (const [id2, r] of sorted.slice(MAX_REQFEED)) {
            if (['complete', 'error'].includes(r.state)) reqFeedRows.delete(id2);
        }
    }
    renderReqFeed();
}
function pushServerEvent(ev) {
    if (ev.type === 'request') {
        upsertReq(ev.id, { state: ev.state, model: ev.model, origin: ev.origin });
        pushFeed([{ kind: 'requests', text: `${ev.origin === 'real' ? '◆ ' : ''}${ev.id.slice(0, 6)} → ${ev.state}` }]);
        if (ev.state === 'error') flashCard('v-errrate', 'bad');
        if (ev.state === 'complete') flashCard('v-requests', 'ok');
    } else if (ev.type === 'model-load') {
        pushFeed([{ kind: 'model-add', model: ev.id, text: `${ev.id} load requested` }]);
    } else if (ev.type === 'model-unload') {
        pushFeed([{ kind: 'model-remove', model: ev.id, text: `${ev.id} unload` }]);
    } else if (ev.type === 'model-ready') {
        pushFeed([{ kind: 'model-add', model: ev.id, text: `${ev.id} ready` }]);
    } else if (ev.type === 'settings') {
        pushFeed([{ kind: 'requests', text: `${ev.id}: settings ${ev.changed.join(', ')}` }]);
    } else if (ev.type === 'mock-reset') {
        pushFeed([{ kind: 'requests', text: 'gateway shadow state reset' }]);
    }
}
function connectEventStream() {
    if (sseSource || !window.EventSource) return;
    try {
        sseSource = new EventSource(`${API}/admin/api/requests/stream`);
        sseSource.onmessage = e => { try { pushServerEvent(JSON.parse(e.data)); } catch (_) {} };
        sseSource.onerror = () => { /* EventSource retries on its own */ };
    } catch (_) { sseSource = null; }
}
async function pollRequests() {
    if (document.hidden) return;
    try {
        const d = await fetchJson(`${API}/admin/api/requests?limit=30`);
        for (const r of d.requests)
            upsertReq(r.id, { state: r.state, model: r.model, origin: r.origin,
                              prompt: r.prompt_tokens, completion: r.completion_tokens,
                              tps: r.tps, error: r.error });
    } catch (_) { /* gateway offline; feed keeps last state */ }
}

/* ---------------- model manager (Models tab) ---------------- */
const SE_BASIC = [
    ['temperature', 'num', 0, 2, 0.05],
    ['top_p', 'num', 0, 1, 0.05],
    ['max_tokens', 'num', 1, 262144, 1],
    ['ttl_seconds', 'num', 30, 86400, 30],
];
const SE_ENUM = { reasoning_effort: ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'] };
const SE_FEATURE = ['dflash_enabled', 'mtp_enabled', 'turboquant_kv_enabled',
                    'specprefill_enabled', 'qwen35_ane_prefill_enabled',
                    'moe_expert_offload_enabled', 'guided_grammar_enabled',
                    'trust_remote_code', 'is_favorite', 'is_hidden'];
let seModel = null, seValues = {};

function editorNode() {
    const panel = document.createElement('div');
    panel.className = 'row-editor';
    const fields = document.createElement('div');
    fields.className = 'pair';
    fields.id = 'se-fields';
    const bar = document.createElement('div');
    bar.className = 'editor-bar';
    const save = document.createElement('button');
    save.className = 'se-btn'; save.textContent = 'Save'; save.id = 'se-save';
    const close = document.createElement('button');
    close.className = 'se-btn'; close.textContent = 'Close'; close.id = 'se-cancel';
    const msg = document.createElement('span');
    msg.className = 'stat-sub'; msg.id = 'se-msg';
    bar.append(save, close, msg);
    panel.append(fields, bar);
    save.onclick = saveEditor;
    close.onclick = () => closeEditor();
    return panel;
}
function closeEditor() {
    seModel = null;
    document.querySelectorAll('.row-editor').forEach(n => n.remove());
    document.querySelectorAll('.urow.expanded').forEach(r => r.classList.remove('expanded'));
    const fb = $('model-editor-fallback');
    if (fb) { fb.hidden = true; fb.querySelector('.row-editor')?.remove(); }
}
async function openEditor(model) {
    closeEditor();
    seModel = model;
    // Find (or wait for) the model's table row; fall back to a detached panel.
    let row = [...document.querySelectorAll('#model-admin .urow:not(.head)')]
        .find(r => r.dataset.mid === model);
    if (!row) { await renderModelAdmin(); 
        row = [...document.querySelectorAll('#model-admin .urow:not(.head)')]
            .find(r => r.dataset.mid === model); }
    try {
        const d = await fetchJson(`${API}/admin/api/models/${encodeURIComponent(model)}/settings`);
        seValues = d.settings || {};
    } catch (_) { seValues = {}; }
    const panel = editorNode();
    const fields = panel.querySelector('#se-fields');
    const addRow = (key, kind, a, b, step) => {
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
        } else if (kind === 'bool') {
            input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = seValues[key] === true;
        } else {
            input = document.createElement('input');
            input.type = 'number';
            input.min = a; input.max = b; input.step = step;
            const cur = seValues[key];
            input.value = (cur === null || cur === undefined) ? '' : cur;
        }
        input.dataset.key = key;
        label.append(name, input);
        fields.append(label);
    };
    for (const f of SE_BASIC) addRow(...f);
    for (const [k, opts] of Object.entries(SE_ENUM)) addRow(k, 'select', opts);
    for (const k of SE_FEATURE) if (k in seValues) addRow(k, 'bool');
    if (row) {
        // Expand downward: insert below the row, spanning the full table width.
        row.classList.add('expanded');
        row.after(panel);
        panel.scrollIntoView({ block: 'nearest' });
    } else {
        $('se-orphan').textContent = `Model ${model} not listed`;
        $('model-editor-fallback').hidden = false;
        $('model-editor-fallback').querySelector('.card-body').append(panel);
    }
}
async function saveEditor() {
    if (!seModel) return;
    const panel = document.querySelector('.row-editor');
    if (!panel) return;
    const payload = {};
    for (const input of panel.querySelectorAll('[data-key]')) {
        const key = input.dataset.key;
        if (input.type === 'checkbox') { payload[key] = input.checked; continue; }
        const v = input.value;
        if (v === '') continue;
        payload[key] = input.type === 'number' ? Number(v) : v;
    }
    panel.querySelector('#se-msg').textContent = 'saving…';
    try {
        await putModelSettings(seModel, payload);
        panel.querySelector('#se-msg').textContent = 'saved ✓ (shadow)';
        toast(`Settings saved: ${seModel}`);
        renderModelAdmin();
        setTimeout(closeEditor, 900);
    } catch (err) {
        panel.querySelector('#se-msg').textContent = `error: ${err.message}`;
        toast(`Save failed: ${err.message}`);
    }
}

let adminModels = [];
async function renderModelAdmin() {
    let models;
    try { models = (await fetchJson(`${API}/admin/api/models`)).models; }
    catch (_) { $('model-admin').innerHTML = '<div class="empty">API unreachable</div>'; return; }
    adminModels = models;
    const filter = ($('ma-filter').value || '').toLowerCase();
    const onlyLoaded = $('ma-only-loaded').checked;
    const shown = models.filter(m =>
        (!filter || m.id.toLowerCase().includes(filter)) &&
        (!onlyLoaded || m.loaded || m.is_loading));
    const loadedN = models.filter(m => m.loaded).length;
    $('models-admin-sub').textContent = `${loadedN}/${models.length} loaded`;
    const memUsed = stats ? stats.memUsed : null;
    $('ma-mem').textContent = memUsed !== null
        ? `memory ${C.fmtBytes(memUsed)} / ${C.fmtBytes(stats.memMax)}` : '';

    const table = $('model-admin');
    table.innerHTML = '';
    if (!shown.length) { table.innerHTML = '<div class="empty">No match</div>'; return; }
    const head = document.createElement('div'); head.className = 'urow head admin';
    for (const h of ['model', 'state', 'size', 'settings', '']) head.append(cell(h));
    table.append(head);
    for (const m of shown) {
        const row = document.createElement('div'); row.className = 'urow admin';
        row.dataset.mid = m.id;
        const name = cell((m.pinned ? '📌 ' : '') + m.id);
        name.className = 'uname'; name.title = m.model_path || m.id;
        const state = cell(m.is_loading ? `loading ${m.loading_elapsed_seconds ?? ''}s`
                        : m.loaded ? 'loaded' : 'unloaded');
        state.className = m.loaded ? 'state-ok' : (m.is_loading ? 't2' : 'dim');
        const size = cell(m.loaded ? (m.actual_size_formatted || C.fmtBytes(m.actual_size || m.estimated_size))
                        : C.fmtBytes(m.estimated_size));
        const s = m.settings || {};
        const bits = [];
        if (s.temperature !== null && s.temperature !== undefined) bits.push(`T${s.temperature}`);
        if (s.max_tokens) bits.push(s.max_tokens);
        if (s.dflash_enabled) bits.push('dflash');
        if (s.mtp_enabled) bits.push('mtp');
        if (s.turboquant_kv_enabled) bits.push('tq4');
        if (s.reasoning_effort && s.reasoning_effort !== 'auto') bits.push('R:' + s.reasoning_effort);
        const settings = cell(bits.join(' · ') || '—');
        settings.className = 'dim';
        const actions = document.createElement('span');
        actions.className = 'rowacts';
        const btn = (label, fn, title, noRerender) => {
            const b = document.createElement('button');
            b.className = 'se-btn'; b.textContent = label; b.title = title || label;
            b.onclick = async () => {
                try { await fn(); } catch (err) { toast(`${label} failed: ${err.message}`); }
                if (!noRerender) renderModelAdmin();
            };
            return b;
        };
        actions.append(btn(m.pinned ? '📌' : '📍', () => postModelAction(m.id, m.pinned ? 'unpin' : 'pin'),
                           m.pinned ? 'Unpin' : 'Pin'));
        actions.append(btn('⚙', () => openEditor(m.id), 'Edit settings', true));
        if (m.loaded) actions.append(btn('unload', () => postModelAction(m.id, 'unload')));
        else actions.append(btn('load', () => postModelAction(m.id, 'load')));
        row.append(name, state, size, settings, actions);
        table.append(row);
    }
}
function cell(text) { const s = document.createElement('span'); s.textContent = text; return s; }
$('ma-filter').oninput = () => renderModelAdmin();
$('ma-only-loaded').onchange = () => renderModelAdmin();

/* ---------------- usage (Usage tab) ---------------- */
function createUsageChart() {
    const el = $('chart-usage');
    if (!el) return;
    if (usageChart) usageChart.destroy();
    const col = chartColors();
    usageChart = new uPlot({
        width: el.clientWidth || 600, height: 200,
        scales: { x: { time: true }, y: { auto: true } },
        axes: [{ stroke: col.dim, size: 36, font: axisFont,
                 values: (s, t) => t.map(ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })) },
               yAxis(col, { grid: true })],
        series: [{ label: 'tokens' }, line('tokens', 'blue', true)],
        cursor: { drag: { x: false, y: false } },
        legend: { show: false },
    }, [[], []], el);
}
async function pollUsage() {
    if (document.hidden) return;
    try {
        const u = await fetchJson(`${API}/admin/api/usage?range=${usageRange}`);
        const tot = u.totals || {};
        setCounter('v-u-req', tot.requests ?? null);
        setCounter('v-u-tok', tot.total_tokens ?? null);
        setCounter('v-u-prompt', tot.prompt_tokens ?? null);
        setCounter('v-u-compl', tot.completion_tokens ?? null);
        usageAvg = tot.requests > 0
            ? { prompt: tot.prompt_tokens / tot.requests, completion: tot.completion_tokens / tot.requests }
            : null;
        usageRange = u.range || usageRange;

        // Heatmap: single row for day ranges, full day×hour grid for 7d+.
        const hm = u.heatmap || [];
        const heat = $('heat');
        const multi = hm.length > 1;
        heat.classList.toggle('multi', multi);
        heat.style.gridTemplateRows = multi ? `repeat(${hm.length}, auto)` : '';
        const want = hm.length * 24;
        if (heat.children.length !== want) {
            heat.innerHTML = '';
            for (let i = 0; i < want; i++) heat.append(document.createElement('i'));
        }
        const allMax = Math.max(1, ...hm.flatMap(d => d.tokens || [0]));
        let cells = [...heat.children];
        hm.forEach((day, dIdx) => {
            (day.tokens || []).slice(0, 24).forEach((v, hIdx) => {
                const c = cells[dIdx * 24 + hIdx];
                if (!c) return;
                const a = v > 0 ? 0.15 + 0.85 * Math.sqrt(v / allMax) : 0;
                c.style.background = v > 0 ? `color-mix(in oklab, var(--heat) ${Math.round(a * 100)}%, transparent)` : '';
                c.title = `${day.date || ''} ${String(hIdx).padStart(2, '0')}:00 — ${C.fmtCompact(v)} tokens`;
            });
        });
        $('usage-sub').textContent = tot.requests !== undefined
            ? `${C.fmtNumber(tot.requests)} req · ${C.fmtCompact(tot.total_tokens)} tok · cached ${C.fmtCompact(tot.cached_tokens)}` : '';

        // Hourly tokens chart (last day of the range).
        if (!usageChart) createUsageChart();
        const lastDay = hm[hm.length - 1];
        const hours = lastDay ? (lastDay.tokens || []).slice(0, 24) : [];
        if (usageChart && hours.length === 24) {
            const base = new Date(); base.setHours(0, 0, 0, 0);
            const ts = hours.map((_, i) => base.getTime() + i * 3600e3);
            usageChart.setData([ts, hours.slice()]);
        }

        // Per-model table (all, sorted by tokens).
        const table = $('usage-models');
        table.innerHTML = '';
        const models = (u.models || []).slice()
            .sort((a, b) => (b.prompt_tokens + b.completion_tokens) - (a.prompt_tokens + a.completion_tokens));
        if (models.length) {
            const head = document.createElement('div'); head.className = 'urow head admin';
            for (const h of ['model', 'req', 'prompt', 'completion', 'cached', 'avg t/req']) head.append(cell(h));
            table.append(head);
            for (const m of models) {
                const row = document.createElement('div'); row.className = 'urow admin';
                const name = cell(m.model_id); name.className = 'uname'; name.title = m.model_id;
                row.append(name, cell(C.fmtNumber(m.requests)), cell(C.fmtCompact(m.prompt_tokens)),
                           cell(C.fmtCompact(m.completion_tokens)), cell(C.fmtCompact(m.cached_tokens)),
                           cell(m.requests ? C.fmtCompact((m.prompt_tokens + m.completion_tokens) / m.requests) : '—'));
                table.append(row);
            }
        }
        if (currentTab() === 'status') renderRequestStats(stats);
    } catch (_) { /* usage may be disabled; keep last data */ }
}
fillSelect($('opt-usage-range'), [['today', 'today'], ['yesterday', 'yesterday'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']], usageRange);
$('opt-usage-range').onchange = e => { usageRange = e.target.value; pollUsage(); };

/* ---------------- logs (Logs tab) ---------------- */
let logsFilesLoaded = false, logsFollow = true;
async function pollLogs() {
    if (document.hidden && !logsFollow) return;
    try {
        const lines = Number($('logs-lines').value || 300);
        const file = $('logs-file').value;
        let url = `${API}/admin/api/logs?lines=${lines}`;
        if (file) url += `&file=${encodeURIComponent(file)}`;
        const d = await fetchJson(url);
        if (!logsFilesLoaded && Array.isArray(d.available_files)) {
            fillSelect($('logs-file'), d.available_files.map(f => [f, f]), d.log_file || d.available_files[0]);
            logsFilesLoaded = true;
        }
        let rows = String(d.logs || '').split('\n').filter(Boolean);
        const level = $('logs-level').value;
        const grep = ($('logs-grep').value || '').toLowerCase();
        rows = rows.filter(l => {
            if (level && !l.includes(` - ${level} - `)) return false;
            if (!level && layout.logsHideDebug && / - (DEBUG|TRACE) - /.test(l)) return false;
            if (grep && !l.toLowerCase().includes(grep)) return false;
            return true;
        });
        const pre = $('logs');
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
        pre.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (const line of rows.slice(-800)) {
            const span = document.createElement('span');
            const lv = / - (ERROR|WARNING|TRACE|DEBUG) - /.exec(line);
            if (lv) span.className = `lv-${lv[1]}`;
            span.textContent = line + '\n';
            frag.append(span);
        }
        pre.append(frag);
        if (logsFollow || atBottom) pre.scrollTop = pre.scrollHeight;
        $('logs-sub').textContent = `${rows.length} lines${d.log_file ? ' · ' + d.log_file : ''}`;
    } catch (_) { /* keep tail */ }
}
$('logs-level').onchange = () => pollLogs();
$('logs-lines').onchange = () => pollLogs();
$('logs-file').onchange = () => pollLogs();
$('logs-grep').oninput = C.debounce ? C.debounce(pollLogs, 300) : (() => { let t; return () => { clearTimeout(t); t = setTimeout(pollLogs, 300); }; })();
$('logs-follow').onchange = e => { logsFollow = e.target.checked; };
$('logs-dl').onclick = () => {
    const blob = new Blob([$('logs').textContent], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `uplift-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
};

/* ---------------- settings (Settings tab: read-only server preview) ------ */
async function pollGlobalSettings() {
    try {
        const d = await fetchJson(`${API}/admin/api/global-settings`);
        const body = $('gs-body');
        body.innerHTML = '';
        const flat = [];
        const walk = (obj, prefix) => {
            for (const [k, v] of Object.entries(obj || {})) {
                if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, prefix ? prefix + '.' + k : k);
                else flat.push([prefix ? prefix + '.' + k : k, Array.isArray(v) ? v.join(', ') : String(v)]);
            }
        };
        walk(d.settings || d, '');
        $('gs-sub').textContent = `${flat.length} keys · read-only via gateway`;
        if (!flat.length) { body.innerHTML = '<div class="empty">No settings exposed by this API</div>'; return; }
        const head = document.createElement('div'); head.className = 'urow head settings';
        head.append(cell('key'), cell('value'));
        body.append(head);
        for (const [k, v] of flat.slice(0, 400)) {
            const row = document.createElement('div'); row.className = 'urow settings';
            const kc = cell(k); kc.className = 'uname';
            const vc = cell(v.length > 120 ? v.slice(0, 117) + '…' : v);
            vc.className = 'dim';
            row.append(kc, vc);
            body.append(row);
        }
    } catch (err) {
        $('gs-body').innerHTML = `<div class="empty">global-settings not served by gateway yet (${err.message})</div>`;
    }
}

/* ---------------- boot ---------------- */
fetchJson(`${API}/admin/api/device-info`).then(d => {
    $('chip-device').textContent = `${d.chip_name}${d.chip_variant === 'Max' ? ' Max' : ''} · ${d.memory_gb} GB · ${d.gpu_cores}c`;
    $('chip-device').classList.add('state-ok');
}).catch(() => {});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    pollStats(); pollGatewayInfo();
    if (currentTab() === 'usage') pollUsage();
    if (currentTab() === 'logs') pollLogs();
    resizeCharts();
});

applyPrefs();
applyOrder();
applyLayout();
createCharts();
resizeCharts();
applyTab();
restartPolling();
pollGatewayInfo();
pollUsage(); pollLogs();
connectEventStream();
setInterval(pollGatewayInfo, 10000);
setInterval(() => { if (!document.hidden) pollRequests(); }, 2000);
setInterval(() => { if (!document.hidden && !seModel) renderModelAdmin(); }, 8000);
setInterval(() => { if (!document.hidden && currentTab() === 'usage') pollUsage(); }, 15000);
setInterval(() => { if (!document.hidden && currentTab() === 'logs' && logsFollow) pollLogs(); }, 5000);
})();
