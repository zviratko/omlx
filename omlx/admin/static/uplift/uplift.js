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
const SUBS = {
    models: ['manager', 'downloader', 'quantizer', 'uploader'],
    settings: ['global', 'models', 'integrations'],
};
const SUB_LABELS = {
    manager: 'Manager', downloader: 'Downloader', quantizer: 'oQ Quantization',
    uploader: 'oQ Uploader', global: 'Global Settings', models: 'Model Settings',
    integrations: 'Integration Settings',
};
function currentTab() {
    const t = (location.hash || '').replace('#', '').split('/')[0];
    return TABS.includes(t) ? t : 'status';
}
function currentSub(tab) {
    const parts = (location.hash || '').replace('#', '').split('/');
    const list = SUBS[tab] || [];
    return list.includes(parts[1]) ? parts[1] : list[0];
}
function applyTab() {
    const tab = currentTab();
    const sub = currentSub(tab);
    document.documentElement.dataset.tab = tab;
    document.documentElement.dataset.sub = sub;
    for (const a of $('tabs').querySelectorAll('[data-tab]')) {
        const hit = a.dataset.tab === tab;
        a.classList.toggle('active', hit);
        if (a.classList.contains('dd-btn')) a.textContent = '';
    }
    // dropdown button labels get rebuilt (textContent above wiped them)
    for (const [dd, label] of [['dd-models-btn', 'Models'], ['dd-settings-btn', 'Settings']]) {
        $(dd).textContent = label + ' ';
        const caret = document.createElement('span');
        caret.className = 'dd-caret'; caret.textContent = '▾';
        $(dd).append(caret);
    }
    for (const card of cards) {
        const show = (card.dataset.tab || 'status') === tab &&
            (!card.dataset.sub || card.dataset.sub === sub);
        card.style.display = show ? '' : 'none';
    }
    // dropdown open state reset on navigation (dropdown click keeps its menu open)
    for (const m of ['dd-models-menu', 'dd-settings-menu'])
        if (ddForceOpen !== m) $(m).hidden = true;
    ddForceOpen = null;
    requestAnimationFrame(resizeCharts);   // charts may have become visible
    if (tab === 'usage') pollUsage();
    if (tab === 'logs') pollLogs();
    if (tab === 'models') {
        renderModelAdmin();
        if (sub === 'downloader') initDownloader();
        if (sub === 'quantizer') renderQuantizer();
        if (sub === 'uploader') renderUploader();
    }
    if (tab === 'settings') {
        pollGlobalSettings();
        if (sub === 'models') renderStoredSettings();
        if (sub === 'integrations') pollIntegrations();
    }
}
addEventListener('hashchange', applyTab);

/* dropdown menus: click opens, outside click / Escape closes */
let ddForceOpen = null;
function bindDropdown(btnId, menuId) {
    const btn = $(btnId), menu = $(menuId);
    btn.onclick = e => {
        e.preventDefault();
        const open = menu.hidden;
        for (const m of ['dd-models-menu', 'dd-settings-menu']) $(m).hidden = true;
        if (currentTab() !== btn.dataset.tab) {
            ddForceOpen = menuId;              // re-open after the tab switch
            location.hash = '#' + btn.dataset.tab;
        }
        menu.hidden = !open;
    };
    for (const a of menu.querySelectorAll('a'))
        a.addEventListener('click', e => {
            e.preventDefault();
            menu.hidden = true;
            location.hash = '#' + btn.dataset.tab + '/' + a.dataset.sub;
        });
}
bindDropdown('dd-models-btn', 'dd-models-menu');
bindDropdown('dd-settings-btn', 'dd-settings-menu');
document.addEventListener('click', e => {
    for (const [btnId, menuId] of [['dd-models-btn', 'dd-models-menu'],
                                    ['dd-settings-btn', 'dd-settings-menu']]) {
        if (!$(menuId).hidden && !$(menuId).contains(e.target) && !$(btnId).contains(e.target))
            $(menuId).hidden = true;
    }
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { $('dd-models-menu').hidden = true; $('dd-settings-menu').hidden = true; }
});

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
/* Nearest-sample lookup for the tooltip: computes the index from the mouse X
   via posToVal (fallback: pixel->timestamp scan of data[0]), so it works even
   if uPlot's own cursor bookkeeping is off. Values snap to the nearest
   collected sample, never interpolated. */
function nearestIndexByX(c, clientX) {
    const xs = c.data[0];
    if (!xs || !xs.length) return null;
    let t = null;
    try {
        // .u-over canvas spans the plot area exactly: its left edge is x-min.
        const r = c.over.getBoundingClientRect();
        t = c.posToVal(clientX - r.left, 'x');
    } catch (_) { /* fallback below */ }
    if (typeof t !== 'number' || !isFinite(t)) {
        const r = c.over.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
        t = xs[0] + frac * (xs[xs.length - 1] - xs[0]);
    }
    let i = 0, best = Infinity;
    for (let k = 0; k < xs.length; k++) {
        const d = Math.abs(xs[k] - t);
        if (d < best) { best = d; i = k; }
    }
    return i;
}
function chartStroke(c, s) {
    try { return typeof c.series[s].stroke === 'string' ? c.series[s].stroke : 'inherit'; }
    catch (_) { return 'inherit'; }
}
/* Floating value bubble at the cursor. The crosshair is already painted;
   the bubble rides beside it and shows the value(s) aligned with it: time
   plus every series at the nearest collected sample. HTML built with DOM
   nodes only (no innerHTML) so labels/values from data cannot inject. */
function tipEl(c) {
    if (!c._tip) {
        const d = document.createElement('div');
        d.className = 'u-tip';
        d.hidden = true;
        c.over.append(d);           // .u-over spans the plot area and is positioned
        c._tip = d;
    }
    return c._tip;
}
function showTip(c, ev, i) {
    const tip = tipEl(c);
    tip.textContent = '';
    const t = document.createElement('div');
    t.className = 'ut-time';
    t.textContent = new Date(c.data[0][i]).toLocaleTimeString('en-GB');
    tip.append(t);
    for (let s = 1; s < c.series.length; s++) {
        const v = c.data[s] ? c.data[s][i] : null;
        if (v === undefined) continue;
        const row = document.createElement('div');
        row.className = 'ut-row';
        const lab = document.createElement('b');
        lab.textContent = (c.series[s] && c.series[s].label) || ('s' + s);
        lab.style.color = chartStroke(c, s);
        const val = document.createElement('span');
        val.textContent = (v === null) ? '—' : seriesValue(v);
        row.append(lab, document.createTextNode(' '), val);
        tip.append(row);
    }
    tip.hidden = false;
    // Position beside the pointer; flip near plot edges so it stays visible.
    const r = c.over.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let lx = ev.clientX - r.left + 14;
    let ly = ev.clientY - r.top + 12;
    if (lx + tw > r.width - 4) lx = ev.clientX - r.left - tw - 14;
    if (ly + th > r.height - 4) ly = Math.max(2, ev.clientY - r.top - th - 12);
    tip.style.left = lx + 'px';
    tip.style.top = ly + 'px';
}
function bindCursorTip(c) {
    if (!c || !c.over) return;
    c.over.addEventListener('mousemove', ev => {
        const i = (c.cursor.idx != null) ? c.cursor.idx : nearestIndexByX(c, ev.clientX);
        hoverTs.set(c, c.data[0][i]);              // pin across poll re-windowing
        showTip(c, ev, i);
    });
    c.over.addEventListener('mouseleave', () => {
        hoverTs.set(c, null);
        if (c._tip) c._tip.hidden = true;
    });
}
/* The vendored uPlot build does not dispatch hooks.cursor.subscribe (no
   'subscribe' in the bundle) — a legend updater wired via hooks only ran on
   redraw, so hover never updated it. Bind the updater directly to the
   cursor overlay instead; uPlot's own mousemove handler is registered first
   (during init), so cursor.idx is already fresh when our listener runs. */
function bindCursorUpdater(c) {
    if (!c || !c.over) return;
    c.over.addEventListener('mousemove', () => legendUpdater()(c));
    c.over.addEventListener('mouseleave', () => {
        hoverTs.set(c, null);
        if (c.data[0].length) c.setCursor({ idx: c.data[0].length - 1 }, false);
        legendUpdater()(c);
    });
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
    bindCursorUpdater(tpsChart); bindCursorUpdater(memChart);
    bindCursorTip(tpsChart); bindCursorTip(memChart);
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
let seModel = null, seValues = {};   // seValues = live form state (modelspec shape)

/* ---- spec-driven settings form (parity with classic _modal_model_settings) ---- */
/* seValues holds the modelspec form state (UpliftModelSpec.buildState shape).
   Widgets write straight into seValues and re-run renderEditorFields() so the
   same conditional visibility the classic modal uses (x-show rules) applies. */
let seFormModel = null;      // the /admin/api/models entry this editor is for

function seBind(kind, key, opts) {
    /* one labeled field bound to seValues[key]; matches classic addRow() but
       writes the modelspec state shape and supports selects/options/text */
    const label = document.createElement('label');
    label.className = 'se-row';
    const name = document.createElement('span');
    name.textContent = opts && opts.label ? opts.label : key;
    let input;
    if (kind === 'select') {
        input = document.createElement('select');
        for (const o of (opts.options || [])) {
            const el = document.createElement('option');
            el.value = o.value; el.textContent = o.label != null ? o.label : o.value;
            if (String(seValues[key]) === String(o.value)) el.selected = true;
            input.append(el);
        }
        if (opts.picker) {              // draft-model picker: selected value may not be in pool
            const cur = seValues[key];
            if (cur && ![...input.options].some(el => el.value === cur)) {
                const el = document.createElement('option');
                el.value = cur; el.textContent = cur + ' (current)'; el.selected = true;
                input.prepend(el);
            }
        }
    } else if (kind === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = seValues[key] === true;
    } else if (kind === 'text') {
        input = document.createElement('input');
        input.type = 'text';
        input.value = seValues[key] == null ? '' : seValues[key];
    } else if (kind === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
        input.value = seValues[key] == null ? '' : seValues[key];
    } else {
        input = document.createElement('input');
        input.type = 'number';
        if (opts) { if (opts.min != null) input.min = opts.min;
                    if (opts.max != null) input.max = opts.max;
                    if (opts.step != null) input.step = opts.step; }
        const cur = seValues[key];
        input.value = (cur === null || cur === undefined) ? '' : cur;
    }
    if (opts && opts.disabled) input.disabled = true;
    const evt = (kind === 'textarea' || kind === 'text' || kind === 'number') ? 'input' : 'change';
    input.addEventListener(evt, () => {
        if (kind === 'bool') seValues[key] = input.checked;
        else if (kind === 'number') seValues[key] = input.value === '' ? null : Number(input.value);
        else if (kind === 'select') seValues[key] = input.value;
        else seValues[key] = input.value;
        if (opts && opts.onChange) opts.onChange(seValues);
    });
    label.append(name, input);
    if (opts && opts.hint) {
        const h = document.createElement('small');
        h.className = 'se-hint'; h.textContent = opts.hint;
        label.append(h);
    }
    return label;
}

function seSection(title) {
    const h = document.createElement('h5');
    h.className = 'se-section'; h.textContent = title;
    return h;
}

function renderEditorFields(container) {
    const S = window.UpliftModelSpec;
    const m = seFormModel || {};
    container.textContent = '';
    const grid = () => { const g = document.createElement('div'); g.className = 'pair'; container.append(g); return g; };

    /* ---- basic ---- */
    container.append(seSection('Basic Settings'));
    let g = grid();
    g.append(seBind('text', 'model_alias', { label: 'Model Alias' }));
    g.append(seBind('select', 'model_type_override', {
        label: 'Model Type',
        options: [{ value: '', label: 'Auto-detect' },
                  ...S.MODEL_TYPE_OPTIONS.map(v => ({ value: v }))] }));
    g.append(seBind('number', 'max_context_window', { label: 'Ctx Window', step: 1 }));
    g.append(seBind('number', 'max_tokens', { label: 'Max Tokens', step: 1 }));
    const sampling = [
        ['temperature', 0, 2, 0.05, 'Temperature'], ['top_p', 0, 1, 0.05, 'Top P'],
        ['top_k', 0, null, 1, 'Top K'], ['repetition_penalty', 0.5, 2, 0.01, 'Repetition Penalty'],
        ['min_p', 0, 1, 0.01, 'Min P'], ['presence_penalty', -2, 2, 0.05, 'Presence Penalty']];
    if (!S.isDiffusion(m)) for (const [k, mn, mx, st, lab] of sampling)
        g.append(seBind('number', k, { label: lab, min: mn, max: mx, step: st }));
    g.append(seBind('bool', 'force_sampling', { label: 'Force Sampling',
        hint: 'Override request sampling parameters with configured values' }));
    g.append(seBind('number', 'ttl_seconds', { label: 'TTL (Seconds)', step: 1 }));

    /* ---- advanced ---- */
    container.append(seSection('Advanced Settings'));
    g = grid();
    if (!S.isDiffusion(m)) {
        if (m.thinking_default !== undefined && m.thinking_default !== null || seValues.enable_thinking != null) {
            const tv = seValues.enable_thinking;
            g.append(seBind('select', 'enable_thinking', {
                label: 'Enable Thinking', disabled: !!m.thinking_forced,
                hint: 'Enable reasoning/thinking mode for this model.',
                options: [{ value: '', label: m.thinking_default === true
                               ? 'Using model default (on)' : 'Using model default (off)' },
                          { value: 'true', label: 'On' }, { value: 'false', label: 'Off' }],
            }));
            // select needs string values; store real bool/null back
            const sel = g.lastChild.querySelector('select');
            sel.value = tv === true ? 'true' : tv === false ? 'false' : '';
            sel.addEventListener('change', () => {
                seValues.enable_thinking = sel.value === '' ? null : sel.value === 'true'; });
        }
        // NOTE: preserve_thinking has NO widget in the classic modal (it only
        // appears in the diffusion unsupported-field lists) — parity: none here.
        if (seValues.reasoning_parser !== undefined || m.reasoning_parsers) {
            const rp = (m.reasoning_parsers || ['']).map(v => ({ value: v }));
            if (!rp.some(o => o.value === (seValues.reasoning_parser || '')))
                rp.push({ value: seValues.reasoning_parser || '' });
            g.append(seBind('select', 'reasoning_parser', { label: 'Reasoning Parser', options: rp }));
        }
        g.append(seBind('bool', 'enableThinkingBudget', { label: 'Thinking Budget',
            hint: 'Limit thinking tokens for reasoning models.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.enableThinkingBudget)
            g.append(seBind('number', 'thinking_budget_tokens',
                { label: 'Thinking budget (tokens)', min: 1, step: 1 }));
        g.append(seBind('bool', 'enableToolResultLimit', { label: 'Limit Tool Result Tokens',
            hint: 'Truncate large tool results (e.g. file reads) to a token limit.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.enableToolResultLimit)
            g.append(seBind('number', 'max_tool_result_tokens',
                { label: 'Tool result token limit', min: 1, step: 1 }));
        g.append(seBind('bool', 'guided_grammar_enabled', { label: 'Guided Grammar',
            hint: 'Apply an EBNF grammar by default for this model.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.guided_grammar_enabled) {
            const gg = seBind('textarea', 'guided_grammar');
            gg.classList.add('se-wide');
            g.append(gg);
        }
        g.append(seBind('bool', 'enableIndexCache', { label: 'Index Cache',
            hint: 'Skip redundant indexer computation in DSA layers (DeepSeek V3/GLM-5).',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.enableIndexCache)
            g.append(seBind('number', 'index_cache_freq',
                { label: 'Frequency (every Nth layer keeps indexer)', min: 1, step: 1 }));
    }
    g.append(seBind('bool', 'trust_remote_code', { label: 'Trust Remote Code',
            hint: 'Lets the model repo run arbitrary Python at load. Only enable for trusted repos.' }));

    /* chat-template kwargs (subset: key/value rows, add/remove) */
    if (!S.isDiffusion(m)) renderCtKwargs(container);

    /* ---- acceleration ---- */
    container.append(seSection('Acceleration'));
    g = grid();
    if (seValues.turboquant_kv_enabled !== undefined && !S.isDiffusion(m)) {
        g.append(seBind('bool', 'turboquant_kv_enabled', { label: 'TurboQuant KV Cache',
            hint: 'Compress KV cache using vector quantization. Lower bits = more compression.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.turboquant_kv_enabled)
            g.append(seBind('number', 'turboquant_kv_bits',
                { label: 'Bits per channel', min: 2, max: 8, step: 0.25 }));
    }
    if (m.qwen4_ple_ssd_offload_supported || seValues.qwen4_ple_ssd_offload)
        g.append(seBind('bool', 'qwen4_ple_ssd_offload', { label: 'SSD N-gram Offload (Qwen4 only)',
            hint: m.qwen4_ple_ssd_offload_forced
                ? 'Required because resident loading exceeds the configured model-memory limit.'
                : 'Keep the large PLE N-gram table on SSD and read only the required rows.',
            disabled: !!m.qwen4_ple_ssd_offload_forced }));
    if (seValues.deepseek_v41_ced_prefill_supported)
        g.append(seBind('bool', 'deepseek_v41_ced_prefill_enabled',
            { label: 'CED Prefill Acceleration (DeepSeek V4.1)',
              hint: 'Improves prefill speed by approximately 74-79% in tested configuration.' }));
    if (m.deepseek_v41_engram_ssd_offload_supported)
        g.append(seBind('bool', 'deepseek_v41_engram_ssd_offload', {
            label: 'SSD N-gram Offload (DeepSeek V4.1)',
            hint: m.deepseek_v41_engram_ssd_offload_forced
                ? 'Required because resident loading exceeds the configured model-memory limit.'
                : 'Keep Engram tables on SSD and prefetch required rows. Saves memory; speed depends on storage.',
            disabled: !!m.deepseek_v41_engram_ssd_offload_forced }));
    if (m.moe_expert_offload_supported && !S.isDiffusion(m)) {
        g.append(seBind('bool', 'moe_expert_offload_enabled', { label: 'MoE Expert Offload',
            hint: 'Stream Mixture-of-Experts weights from the checkpoint on demand, keeping only part resident.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.moe_expert_offload_enabled)
            g.append(seBind('number', 'moe_expert_offload_resident_fraction',
                { label: 'Resident experts (fraction)', min: 0.01, max: 1, step: 0.01 }));
    }
    if (S.isQwenOqA8(m)) {
        g.append(seBind('bool', 'qwen35_oq_a8_enabled', { label: 'Qwen INT8 Activation Prefill',
            hint: 'Experimental GPU INT8 activation quantization for supported Q4/Q5 prefill.',
            onChange: renderEditorFields.bind(null, container) }));
        if (seValues.qwen35_oq_a8_enabled)
            g.append(seBind('number', 'qwen35_oq_a8_min_tokens',
                { label: 'Minimum prompt tokens', min: 1, step: 1 }));
    }
    if (m.ane_prefill_backend && !S.isDiffusion(m)) renderAne(container, g);

    /* ---- experimental (spec decode) ---- */
    container.append(seSection('Experimental Features'));
    g = grid();
    const models = adminModels.length ? adminModels : [];
    const S_ = window.UpliftModelSpec;
    if (!S_.isDiffusion(m)) {
        if (seValues.specprefill_enabled !== undefined) {
            g.append(seBind('bool', 'specprefill_enabled', { label: 'SpecPrefill',
                onChange: renderEditorFields.bind(null, container) }));
            if (seValues.specprefill_enabled) {
                const pool = S_.specprefillCandidates(models, m.id).map(x => ({ value: x.id }));
                g.append(seBind('select', 'specprefill_draft_model',
                    { label: 'Draft Model', options: [{ value: '', label: 'Select draft model...' }, ...pool], picker: true }));
                g.append(seBind('select', 'specprefill_keep_pct', { label: 'Keep Rate', options: [
                    { value: '0.1', label: '10% — Aggressive (~5-7x, some quality loss)' },
                    { value: '0.2', label: '20% — Balanced (~3x, recommended)' },
                    { value: '0.25', label: '25% — Conservative+ (~2.5x)' },
                    { value: '0.3', label: '30% — Conservative (~2.2x)' },
                    { value: '0.4', label: '40% — Mild (~1.8x)' },
                    { value: '0.5', label: '50% — Minimal (~1.5x)' }], picker: true }));
                g.append(seBind('number', 'specprefill_threshold',
                    { label: 'Threshold (tokens)', min: 1024, max: 131072, step: 1024 }));
            }
        }
        if (seValues.dflash_enabled !== undefined) {
            g.append(seBind('bool', 'dflash_enabled', { label: 'DFlash',
                hint: m.dflash_compatible === false ? (m.dflash_compatibility_reason || 'not compatible') : '',
                onChange: renderEditorFields.bind(null, container) }));
            if (seValues.dflash_enabled) {
                const pool = S_.dflashCandidates(models, m.id).map(x => ({ value: x.id }));
                g.append(seBind('select', 'dflash_draft_model',
                    { label: 'Draft Model', options: [{ value: '', label: 'Select draft model...' }, ...pool], picker: true }));
                g.append(seBind('bool', 'dflash_draft_quant_enabled', { label: 'Quantization',
                    onChange: renderEditorFields.bind(null, container) }));
                if (seValues.dflash_draft_quant_enabled) {
                    g.append(seBind('select', 'dflash_draft_quant_weight_bits', { label: 'Weight Bits', options: [
                        { value: 2, label: '2-bit' }, { value: 4, label: '4-bit' }, { value: 8, label: '8-bit' }], picker: true }));
                    g.append(seBind('select', 'dflash_draft_quant_activation_bits', { label: 'Activation Bits', options: [
                        { value: 16, label: '16-bit' }, { value: 32, label: '32-bit' }], picker: true }));
                    g.append(seBind('number', 'dflash_draft_quant_group_size', { label: 'Group Size', min: 16, max: 256, step: 16 }));
                }
                g.append(seBind('number', 'dflash_max_ctx', { label: 'Max Context (fallback threshold)', step: 1 }));
                g.append(seBind('bool', 'dflash_in_memory_cache', { label: 'In-memory cache',
                    onChange: renderEditorFields.bind(null, container) }));
                if (seValues.dflash_in_memory_cache) {
                    g.append(seBind('number', 'dflash_in_memory_cache_max_entries',
                        { label: 'In-memory cache max entries', min: 1, step: 1 }));
                    g.append(seBind('number', 'dflash_in_memory_cache_max_gib',
                        { label: 'In-memory cache size (GiB)', min: 1, step: 1,
                          hint: 'Byte budget for L1 snapshots; LRU evicts when exceeded.' }));
                    if (seValues.dflash_ssd_cache_available) {
                        g.append(seBind('bool', 'dflash_ssd_cache', { label: 'SSD cache',
                            hint: 'Requires in-memory cache to be enabled.' }));
                        if (seValues.dflash_ssd_cache)
                            g.append(seBind('number', 'dflash_ssd_cache_max_gib',
                                { label: 'SSD cache size (GiB)', min: 1, step: 1 }));
                    }
                }
                g.append(seBind('number', 'dflash_draft_window_size', { label: 'Draft window size' }));
                g.append(seBind('number', 'dflash_draft_sink_size', { label: 'Draft sink size', min: 0, step: 1 }));
                g.append(seBind('number', 'dflash_block_size', { label: 'Runtime block size', step: 1 }));
                g.append(seBind('select', 'dflash_verify_mode', { label: 'Verify mode', options: [
                    { value: 'adaptive', label: 'adaptive (default)' },
                    { value: 'dflash', label: 'dflash' },
                    { value: 'ddtree', label: 'ddtree' }], picker: true }));
            }
        }
        if (seValues.mtp_enabled !== undefined) {
            g.append(seBind('bool', 'mtp_enabled', { label: 'Lightning MTP',
                hint: m.mtp_compatible
                    ? "Drafts several tokens per step with the model's built-in MTP head."
                    : (m.mtp_compatibility_reason || 'Not compatible with this model'),
                onChange: renderEditorFields.bind(null, container) }));
        }
        const drafterType = (m.config_model_type || '').toLowerCase().replace(/-/g, '_');
        if (seValues.vlm_mtp_enabled !== undefined &&
            S_.VLM_MTP_DRAFTER_CONFIG_MODEL_TYPES.has(drafterType)) {
            g.append(seBind('bool', 'vlm_mtp_enabled', { label: 'VLM MTP',
                hint: 'Speculative decoding via an external MTP drafter model.',
                onChange: renderEditorFields.bind(null, container) }));
            if (seValues.vlm_mtp_enabled) {
                const pool = S_.vlmMtpDrafters(models, m.id).map(x => ({ value: x.id }));
                g.append(seBind('select', 'vlm_mtp_draft_model', { label: 'Drafter model', options: [
                    { value: '', label: 'Select an assistant or MTP drafter…' }, ...pool], picker: true }));
                g.append(seBind('number', 'vlm_mtp_draft_block_size',
                    { label: 'Draft block size (tokens per round, blank = 4)', step: 1 }));
            }
        }
    }
}

/* ANE prompt processing (classic modal renders a Qwen variant and, for
   ane_prefill_backend === 'k2', a K2 variant with different labels). */
function renderAne(container, g) {
    const k2 = (seFormModel && seFormModel.ane_prefill_backend) === 'k2';
    g.append(seBind('bool', 'qwen35_ane_prefill_enabled', {
        label: k2 ? 'K2 ANE Prompt Processing' : 'Qwen ANE Prompt Processing',
        hint: k2 ? 'Use ANE for K2 prompt processing, including MoVA. Decode stays on GPU.'
                 : 'Split eligible Qwen 3.5/3.6/3.8 prompt-processing work across both ANEs and the GPU.',
        onChange: renderEditorFields.bind(null, container) }));
    if (!seValues.qwen35_ane_prefill_enabled) return;
    g.append(seBind('number', 'qwen35_ane_prefill_sequence_length',
        { label: 'Prompt block', min: 1024, step: 64 }));
    if (!k2) g.append(seBind('number', 'qwen35_ane_prefill_tail_padding_min_tokens',
        { label: 'Pad tails from', min: 0, step: 1 }));
    g.append(seBind('number', 'qwen35_ane_prefill_fraction',
        { label: 'MLP on ANE', min: 0, max: 1, step: 0.01 }));
    g.append(seBind('number', 'qwen35_ane_prefill_shared_fraction',
        { label: 'Shared MLP on ANE', min: 0, max: 1, step: 0.01 }));
    if (!k2) {
        g.append(seBind('number', 'qwen35_ane_prefill_max_layers',
            { label: 'MLP layer limit', min: 1, step: 1 }));
        g.append(seBind('bool', 'qwen35_ane_prefill_dual_ane',
            { label: 'Use both ANEs', hint: 'Pin one resident program to each physical ANE instance.' }));
    }
    g.append(seBind('bool', 'qwen35_ane_prefill_gdn',
        { label: 'Accelerate GDN', hint: 'Also split eligible GDN input projections across the ANEs and GPU.',
          onChange: renderEditorFields.bind(null, container) }));
    if (seValues.qwen35_ane_prefill_gdn) {
        g.append(seBind('number', 'qwen35_ane_prefill_gdn_fraction',
            { label: 'GDN on ANE (fraction)', min: 0, max: 1, step: 0.01 }));
        g.append(seBind('number', 'qwen35_ane_prefill_gdn_max_layers',
            { label: 'GDN layer limit', min: 0, step: 1 }));
    }
    g.append(seBind('bool', 'qwen35_ane_prefill_cpu_enabled',
        { label: 'Share MLP work with CPU',
          hint: 'Requires a separate Qwen q4 checkpoint clone with floating tensors converted.',
          onChange: renderEditorFields.bind(null, container) }));
    if (seValues.qwen35_ane_prefill_cpu_enabled) {
        g.append(seBind('number', 'qwen35_ane_prefill_cpu_fraction',
            { label: 'MLP on CPU (fraction)', min: 0, max: 1, step: 0.001 }));
        g.append(seBind('number', 'qwen35_ane_prefill_cpu_down_fraction',
            { label: 'Down projection on CPU (fraction, 0 = disabled)', min: 0, max: 1, step: 0.001 }));
        g.append(seBind('number', 'qwen35_ane_prefill_cpu_gdn_fraction',
            { label: 'GDN on CPU (fraction)', min: 0, max: 1, step: 0.001 }));
        g.append(seBind('number', 'qwen35_ane_prefill_cpu_threads',
            { label: 'CPU workers (0 = automatic)', min: 0, step: 1 }));
        g.append(seBind('bool', 'qwen35_ane_prefill_cpu_shared_resource',
            { label: 'Performance-aware scheduling',
              hint: "Uses Apple's shared-resource scheduler hint and falls back automatically." }));
    }
}

/* chat_template_kwargs editor: value kinds per classic modal */
function renderCtKwargs(container) {
    const S = window.UpliftModelSpec;
    container.append(seSection('Chat Template Kwargs'));
    const hint = document.createElement('div');
    hint.className = 'se-hint';
    hint.textContent = 'Parameters passed to chat template. Force: API requests cannot override this value.';
    container.append(hint);
    const g = document.createElement('div');
    g.className = 'pair'; container.append(g);
    const entries = seValues.ctKwargEntries || [];
    entries.forEach((e, idx) => {
        if (e.force) {
            const l = document.createElement('label'); l.className = 'se-row';
            const fk = document.createElement('span'); fk.textContent = `${e.key} (forced)`;
            const fv = document.createElement('span'); fv.className = 'stat-sub'; fv.textContent = String(e.value);
            l.append(fk, fv);
            g.append(l); return;
        }
        const row = document.createElement('div');
        row.className = 'se-row se-kwarg';
        const key = document.createElement('input');
        key.type = 'text'; key.value = e.key || ''; key.placeholder = 'key';
        key.addEventListener('input', () => { e.key = key.value; });
        let val;
        if (e.type === 'enable_thinking') {
            val = document.createElement('select');
            ['true', 'false'].forEach(v => { const o = document.createElement('option'); o.value = v; val.append(o); });
            val.value = String(e.value);
            val.addEventListener('change', () => { e.value = val.value; });
        } else if (e.type === 'reasoning_effort') {
            val = document.createElement('select');
            ['low', 'medium', 'high', 'xhigh', 'max', '__custom__'].forEach(v => {
                const o = document.createElement('option'); o.value = v; o.textContent = v; val.append(o); });
            val.value = e.custom ? '__custom__' : e.value;
            val.addEventListener('change', () => {
                if (val.value === '__custom__') { e.custom = true; } else { e.custom = false; e.value = val.value; }
                renderEditorFields(container);
            });
            if (e.custom) {
                const cv = document.createElement('input');
                cv.type = 'text'; cv.value = e.customValue || '';
                cv.addEventListener('input', () => { e.customValue = cv.value; });
                row.append(key, val, cv);
            }
        } else {
            val = document.createElement('input');
            val.type = 'text'; val.placeholder = 'value';
            val.value = String(e.value == null ? '' : e.value);
            val.addEventListener('input', () => { e.value = val.value; });
        }
        const rm = document.createElement('button');
        rm.className = 'se-btn'; rm.textContent = '×';
        rm.addEventListener('click', () => {
            seValues.ctKwargEntries.splice(idx, 1);
            renderEditorFields(container);
        });
        if (!row.children.length) row.append(key, val);
        row.append(rm);
        g.append(row);
    });
    if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'se-hint'; empty.textContent = 'No kwargs configured';
        g.append(empty);
    }
    const add = document.createElement('button');
    add.className = 'se-btn'; add.textContent = '+ Add';
    add.addEventListener('click', () => {
        seValues.ctKwargEntries.push({ type: 'custom', key: '', value: '', force: false });
        renderEditorFields(container);
    });
    g.append(add);
}

function editorNode() {
    const panel = document.createElement('div');
    panel.className = 'row-editor';
    const head = document.createElement('div');
    head.className = 'editor-head';
    head.textContent = seModel + (seFormModel && seFormModel.model_alias ? ` · ${seFormModel.model_alias}` : '');
    const profilesHost = document.createElement('div');
    profilesHost.className = 'se-profiles';
    const fields = document.createElement('div');
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
    panel.append(head, profilesHost, fields, bar);
    save.onclick = saveEditor;
    close.onclick = () => closeEditor();
    return panel;
}
function closeEditor() {
    seModel = null; seFormModel = null;
    renderModelAdmin(); // rows were frozen while the editor was open
    document.querySelectorAll('.row-editor').forEach(n => n.remove());
    document.querySelectorAll('.urow.expanded').forEach(r => r.classList.remove('expanded'));
    const fb = $('model-editor-fallback');
    if (fb) { fb.hidden = true; fb.querySelector('.row-editor')?.remove(); }
}
async function openEditor(model) {
    closeEditor();
    seModel = model;
    let row = [...document.querySelectorAll('#model-admin .urow:not(.head)')]
        .find(r => r.dataset.mid === model);
    if (!row) { await renderModelAdmin(true);
        row = [...document.querySelectorAll('#model-admin .urow:not(.head)')]
            .find(r => r.dataset.mid === model); }
    let settings = {}, entry = null;
    try {
        const d = await fetchJson(`${API}/admin/api/models/${encodeURIComponent(model)}/settings`);
        settings = d.settings || {};
    } catch (_) { settings = {}; }
    try {
        const list = adminModels.length ? adminModels
            : (await fetchJson(`${API}/admin/api/models`)).models;
        entry = list.find(x => x.id === model) || null;
    } catch (_) { entry = null; }
    seFormModel = entry || { id: model };
    seValues = window.UpliftModelSpec.buildState(seFormModel, settings);
    // is_hidden/is_favorite/is_default/pinned are toggled from the models ROW
    // (classic _models.html), never in the settings modal — parity: not here.
    const panel = editorNode();
    renderEditorFields(panel.querySelector('#se-fields'));
    seLoadProfiles(model, panel.querySelector('.se-profiles'));
    if (row) {
        row.classList.add('expanded');
        row.after(panel);
        panel.scrollIntoView({ block: 'nearest' });
    } else {
        $('se-orphan').textContent = `Model ${model} not listed`;
        $('model-editor-fallback').hidden = false;
        $('model-editor-fallback').querySelector('.card-body').append(panel);
    }
}

/* ---- per-model profiles (sidebar of the classic editor) ---- */
async function seLoadProfiles(model, host) {
    let profs = [];
    try { profs = (await fetchJson(`${API}/admin/api/models/${encodeURIComponent(model)}/profiles`)).profiles || []; } catch (_) {}
    host.textContent = '';
    const pt = document.createElement('div');
    pt.className = 'se-hint'; pt.textContent = 'Profiles (this model)';
    host.append(pt);
    const row = document.createElement('div');
    row.className = 'se-prof-row';
    const sel = document.createElement('select');
    const none = document.createElement('option'); none.value = ''; none.textContent = 'profiles…';
    sel.append(none, ...profs.map(p => { const o = document.createElement('option');
        o.value = p.name; o.textContent = p.display_name || p.name; return o; }));
    const applyB = document.createElement('button'); applyB.className = 'se-btn'; applyB.textContent = 'Apply';
    const delB = document.createElement('button'); delB.className = 'se-btn'; delB.textContent = 'Delete';
    const saveAs = document.createElement('input');
    saveAs.type = 'text'; saveAs.placeholder = 'save current as…'; saveAs.className = 'se-prof-name';
    const saveB = document.createElement('button'); saveB.className = 'se-btn'; saveB.textContent = 'Save';
    const write = async (path, opts) => {          // detail-aware JSON call
        const res = await fetch(path, Object.assign({ cache: 'no-store' }, opts));
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail || body.error || String(res.status));
        return body;
    };
    applyB.onclick = async () => {
        if (!sel.value) return;
        try {
            await write(`${API}/admin/api/models/${encodeURIComponent(model)}/profiles/${encodeURIComponent(sel.value)}/apply`,
                { method: 'POST' });
            toast(`Applied profile ${sel.value}`);
            openEditor(model);
        } catch (e) { toast(`Apply failed: ${e.message}`); }
    };
    delB.onclick = async () => {
        if (!sel.value) return;
        try {
            await write(`${API}/admin/api/models/${encodeURIComponent(model)}/profiles/${encodeURIComponent(sel.value)}`,
                { method: 'DELETE' });
            toast(`Deleted profile ${sel.value}`);
            seLoadProfiles(model, host);
        } catch (e) { toast(`Delete failed: ${e.message}`); }
    };
    saveB.onclick = async () => {
        const name = saveAs.value.trim();
        if (!name) { toast('profile name required'); return; }
        const payload = window.UpliftModelSpec.buildPayload(seValues, seFormModel);
        try {
            await write(`${API}/admin/api/models/${encodeURIComponent(model)}/profiles`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name, settings: payload }) });
            toast(`Saved profile ${name}`);
            seLoadProfiles(model, host);
        } catch (e) { toast(`Profile: ${e.message}`); }
    };
    row.append(sel, applyB, delB, saveAs, saveB);
    host.append(row);
    // Global templates (global_templates.json): apply or snapshot into a template.
    let tpls = [];
    try { tpls = (await fetchJson(`${API}/admin/api/profile-templates`)).templates || []; } catch (_) {}
    if (tpls.length || true) {
        const trow = document.createElement('div');
        trow.className = 'se-prof-row';
        const tsel = document.createElement('select');
        const tnone = document.createElement('option'); tnone.value = ''; tnone.textContent = 'templates…';
        tsel.append(tnone, ...tpls.map(t => { const o = document.createElement('option');
            o.value = t.name; o.textContent = t.display_name || t.name; return o; }));
        const tApply = document.createElement('button'); tApply.className = 'se-btn'; tApply.textContent = 'Apply';
        const tSnap = document.createElement('button'); tSnap.className = 'se-btn'; tSnap.textContent = 'Snapshot as';
        const uniFields = async () => {
            try { return (await fetchJson(`${API}/admin/api/profile-fields`)).universal || []; } catch (_) { return []; }
        };
        tApply.onclick = async () => {
            if (!tsel.value) return;
            try {
                // Classic applyTemplateToForm: template is source of truth —
                // upsert the model profile from it, then apply the profile.
                const tpl = tpls.find(t => t.name === tsel.value) || {};
                const prof = `${API}/admin/api/models/${encodeURIComponent(model)}/profiles`;
                let pname = tpl.name;
                await write(prof, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: pname, display_name: tpl.display_name || tpl.name,
                                           description: tpl.description || null,
                                           settings: tpl.settings || {}, source_template: tpl.name }) });
                await write(`${prof}/${encodeURIComponent(pname)}/apply`, { method: 'POST' });
                toast(`Applied template ${pname}`);
                openEditor(model);
            } catch (e) { toast(`Template apply failed: ${e.message}`); }
        };
        tSnap.onclick = async () => {
            const name = saveAs.value.trim() || tsel.value;
            if (!name) { toast('type a name in “save current as…” first'); return; }
            const full = window.UpliftModelSpec.buildPayload(seValues, seFormModel);
            const uni = new Set(await uniFields());
            const settings = {};
            for (const [k, v] of Object.entries(full)) if (uni.has(k)) settings[k] = v;
            try {
                await write(`${API}/admin/api/profile-templates`,
                    { method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name, settings }) });
                toast(`Saved template ${name}`);
                seLoadProfiles(model, host);
            } catch (e) { toast(`Template: ${e.message}`); }
        };
        const tt = document.createElement('div');
        tt.className = 'se-hint'; tt.textContent = 'Templates (global)';
        host.append(tt);
        trow.append(tsel, tApply, tSnap);
        host.append(trow);
    }
}

async function saveEditor() {
    if (!seModel) return;
    const panel = document.querySelector('.row-editor');
    if (!panel) return;
    const msg = panel.querySelector('#se-msg');
    const errors = window.UpliftModelSpec.validate(seValues);
    if (errors.length) {
        msg.textContent = errors[0];
        toast(errors[0]);
        return;
    }
    const payload = window.UpliftModelSpec.buildPayload(seValues, seFormModel);
    // boolean management flags ride the same PUT (real API accepts them too)
    if ('is_hidden' in seValues) payload.is_hidden = !!seValues.is_hidden;
    if ('is_favorite' in seValues) payload.is_favorite = !!seValues.is_favorite;
    msg.textContent = 'saving…';
    try {
        const r = await putModelSettings(seModel, payload);
        const note = r.requires_reload ? 'saved ✓ reload required' : 'saved ✓ (shadow)';
        msg.textContent = note;
        toast(`Settings saved: ${seModel}`);
        setTimeout(closeEditor, 1200);
    } catch (err) {
        msg.textContent = `error: ${err.message}`;
        toast(`Save failed: ${err.message}`);
    }
}

let adminModels = [];
/* ---------------- model manager table (sorting, filters, row chips) ------ */
let sortKey = (prefs.tableSort && prefs.tableSort.key) || 'name';
let sortDir = (prefs.tableSort && prefs.tableSort.dir) || 1;      // 1 asc, -1 desc

function saveTableSort() {
    prefs.tableSort = { key: sortKey, dir: sortDir };
    localStorage.setItem('omlx-uplift-prefs-v1', JSON.stringify(prefs));
}

function stateRank(m) { return m.loaded ? 0 : (m.is_loading ? 1 : 2); }
function sortModels(rows) {
    const cmp = {
        name: (a, b) => a.id.localeCompare(b.id),
        type: (a, b) => (a.model_type || '').localeCompare(b.model_type || '') || a.id.localeCompare(b.id),
        state: (a, b) => stateRank(a) - stateRank(b) || a.id.localeCompare(b.id),
        size: (a, b) => ((a.actual_size || a.estimated_size || 0) - (b.actual_size || b.estimated_size || 0)),
    }[sortKey] || ((a, b) => a.id.localeCompare(b.id));
    return rows.sort((a, b) => (cmp(a, b) || 0) * sortDir || a.id.localeCompare(b.id));
}

async function renderModelAdmin(force) {
    let models;
    try { models = (await fetchJson(`${API}/admin/api/models`)).models; }
    catch (_) { $('model-admin').innerHTML = '<div class="empty">API unreachable</div>'; return; }
    adminModels = models;
    if (seModel && !force) return;   // editor open: don't re-render rows over a live form
    const filter = ($('ma-filter').value || '').toLowerCase().trim();
    const typeSel = $('ma-type');
    const type = typeSel.value || '';
    const onlyLoaded = $('ma-only-loaded').checked;
    let shown = models.filter(m =>
        (!filter || m.id.toLowerCase().includes(filter) ||
         (m.display_name || '').toLowerCase().includes(filter) ||
         (m.settings && m.settings.model_alias || '').toLowerCase().includes(filter)) &&
        (!type || (m.model_type || '') === type) &&
        (!onlyLoaded || m.loaded || m.is_loading));
    shown = sortModels(shown);
    const loadedN = models.filter(m => m.loaded).length;
    $('models-admin-sub').textContent = `${loadedN}/${models.length} loaded \u00b7 ${shown.length} shown`;
    const memUsed = stats ? stats.memUsed : null;
    $('ma-mem').textContent = memUsed !== null
        ? `memory ${C.fmtBytes(memUsed)} / ${C.fmtBytes(stats.memMax)}` : '';
    if (typeSel.dataset.built !== '1') {
        const types = [...new Set(models.map(m => m.model_type).filter(Boolean))].sort();
        for (const t of types) {
            const o = document.createElement('option');
            o.value = t; o.textContent = t;
            typeSel.append(o);
        }
        typeSel.dataset.built = '1';
    }

    const table = $('model-admin');
    table.innerHTML = '';
    if (!shown.length) { table.innerHTML = '<div class="empty">No match</div>'; return; }
    const head = document.createElement('div'); head.className = 'urow head admin';
    for (const [label, key] of [['model', 'name'], ['type', 'type'], ['state', 'state'],
                                 ['size', 'size'], ['', null]]) {
        const c = cell(label + (sortKey === key ? (sortDir === 1 ? ' \u25b2' : ' \u25bc') : ''));
        if (key) {
            c.classList.add('sortable');
            c.onclick = () => {
                if (sortKey === key) sortDir = -sortDir;
                else { sortKey = key; sortDir = key === 'size' ? -1 : 1; }
                saveTableSort();
                renderModelAdmin(true);
            };
        }
        head.append(c);
    }
    table.append(head);
    for (const m of shown) {
        const row = document.createElement('div'); row.className = 'urow admin';
        row.dataset.mid = m.id;
        const name = cell(m.id);
        name.className = 'uname'; name.title = m.model_path || m.id;
        if (m.pinned) name.prepend(cell('PIN \u00b7 '));
        const typeC = cell(m.model_type || '\u2014'); typeC.className = 'dim';
        // State: fixed-size text pill, uniform width across the three states
        const state = document.createElement('span');
        state.className = 'spill ' + (m.loaded ? 'on' : (m.is_loading ? 'load' : 'off'));
        state.textContent = m.is_loading ? 'LOADING' : (m.loaded ? 'LOADED' : 'IDLE');
        const size = cell(m.loaded ? (m.actual_size_formatted || C.fmtBytes(m.actual_size || m.estimated_size))
                        : C.fmtBytes(m.estimated_size));
        size.className = 'usize';
        // right group: settings chips + actions, separate shaded box
        const box = document.createElement('span');
        box.className = 'settings-box';
        const s = m.settings || {};
        const bits = [];
        if (s.temperature !== null && s.temperature !== undefined) bits.push(['TEMP ' + s.temperature, '']);
        if (s.max_tokens) bits.push(['MAX ' + s.max_tokens, '']);
        if (s.dflash_enabled) bits.push(['DFLASH', 'on']);
        if (s.mtp_enabled) bits.push(['MTP', 'on']);
        if (s.turboquant_kv_enabled) bits.push(['TQ', 'on']);
        if (s.reasoning_effort && s.reasoning_effort !== 'auto') bits.push(['R:' + s.reasoning_effort, '']);
        if (m.is_favorite) bits.push(['FAV', 'on']);
        if (m.is_default) bits.push(['DEFAULT', 'on']);
        if (m.is_hidden) bits.push(['HIDDEN', '']);
        for (const [txt, cls] of bits) {
            const chip = document.createElement('span');
            chip.className = 'schip ' + cls; chip.textContent = txt;
            box.append(chip);
        }
        const actions = document.createElement('span');
        actions.className = 'rowacts';
        const btn = (label, fn, title, noRerender) => {
            const b = document.createElement('button');
            b.className = 'se-btn act'; b.textContent = label; b.title = title || label;
            b.onclick = async () => {
                try { await fn(); } catch (err) { toast(`${label} failed: ${err.message}`); }
                if (!noRerender) renderModelAdmin(true);
            };
            return b;
        };
        actions.append(btn(m.pinned ? 'unpin' : 'pin',
            () => postModelAction(m.id, m.pinned ? 'unpin' : 'pin'),
            m.pinned ? 'Unpin from top' : 'Pin to top'));
        actions.append(btn(m.is_favorite ? 'unfav' : 'fav',
            () => putModelSettings(m.id, { is_favorite: !m.is_favorite }),
            m.is_favorite ? 'Unfavorite' : 'Favorite'));
        actions.append(btn(m.is_hidden ? 'show' : 'hide',
            () => putModelSettings(m.id, { is_hidden: !m.is_hidden }),
            m.is_hidden ? 'Unhide' : 'Hide from pickers'));
        if (!m.is_default) actions.append(btn('def', () => putModelSettings(m.id, { is_default: true }),
                                             'Make default model'));
        actions.append(btn('edit', () => openEditor(m.id), 'Edit settings', true));
        if (m.loaded) actions.append(btn('unload', () => postModelAction(m.id, 'unload')));
        else actions.append(btn('load', () => postModelAction(m.id, 'load')));
        box.append(actions);
        row.append(name, typeC, state, size, box);
        table.append(row);
    }
}
function cell(text) { const s = document.createElement('span'); s.textContent = text; return s; }
function emptyMsg(host, msg) {   // error text goes through textContent, never innerHTML
    host.textContent = '';
    const d = document.createElement('div'); d.className = 'empty';
    d.textContent = msg; host.append(d);
}
$('ma-filter').oninput = () => {
    // the filter felt dead while the editor was open: close the editor on filter
    if (seModel) closeEditor();
    renderModelAdmin(true);
};
$('ma-type').onchange = () => { if (seModel) closeEditor(); renderModelAdmin(true); };
$('ma-only-loaded').onchange = () => { if (seModel) closeEditor(); renderModelAdmin(true); };

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
        cursor: { drag: { x: false, y: false }, points: { show: true, size: 6, fill: col.dim } },
        legend: { show: false },
    }, [[], []], el);
    bindCursorTip(usageChart);
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
        emptyMsg($('gs-body'), 'global-settings not served by gateway yet (' + err.message + ')');
    }
}

/* ---------------- models sub-pages: downloader / quantizer / uploader ---- */
async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || r.status + ' ' + r.statusText);
    return d;
}
function taskRow(t) {
    const row = document.createElement('div'); row.className = 'urow usage';
    const st = (t.status || 'unknown').toUpperCase();
    const pct = Math.round((t.progress ?? 0) * 100);
    row.append(cell(t.name || t.repo_id || t.model || '—'),
               cell(t.dest || t.target_repo || ''),
               cell(st + (t.status === 'downloading' || t.status === 'quantizing' || t.status === 'uploading'
                   ? ` ${pct}%` : '')),
               cell(t.error || (t.size_formatted || C.fmtBytes(t.size || 0))));
    return row;
}
function renderTasks(hostId, kind) {
    fetchJson(`${API}/admin/api/${kind}/tasks`).then(d => {
        const host = $(hostId);
        host.innerHTML = '';
        const tasks = d.tasks || [];
        if (!tasks.length) { host.innerHTML = '<div class="empty">No tasks</div>'; return; }
        let active = false;
        for (const t of tasks) {
            const r = taskRow(t);
            if (['downloading', 'quantizing', 'uploading', 'queued'].includes(t.status)) {
                active = true;
                const x = cell('cancel');
                x.className = 'sortable';
                x.onclick = () => postJson(`${API}/admin/api/${kind}/cancel/${t.id}`, {})
                    .then(() => renderTasks(hostId, kind)).catch(e => toast('cancel: ' + e.message));
                r.append(x);
            }
            host.append(r);
        }
        if (active) {   // gentle live progress while an entry is still running
            setTimeout(() => {
                const card = host.closest('section');
                if (card && card.style.display !== 'none' && !document.hidden)
                    renderTasks(hostId, kind);
            }, 2000);
        }
    }).catch(e => emptyMsg($(hostId), e.message));
}

let dlInit = false;
function initDownloader() {
    if (!dlInit) {
        dlInit = true;
        const go = () => {
            const q = $('dl-q').value.trim();
            if (!q) return;
            $('dl-sub').textContent = 'searching…';
            fetchJson(`${API}/admin/api/hf/search?q=${encodeURIComponent(q)}&limit=30`).then(d => {
                $('dl-sub').textContent = `${(d.models || []).length} results`;
                const host = $('dl-results'); host.innerHTML = '';
                if (!d.models || !d.models.length) { host.innerHTML = '<div class="empty">No results</div>'; return; }
                for (const m of d.models) {
                    const row = document.createElement('div'); row.className = 'urow usage';
                    const name = cell(m.repo_id); name.className = 'uname';
                    row.append(name, cell(m.downloads != null ? `${m.downloads} dl` : ''),
                               cell(m.size_formatted || ''));
                    const act = document.createElement('span'); act.className = 'rowacts';
                    const b = document.createElement('button');
                    b.className = 'se-btn act'; b.textContent = 'download';
                    b.onclick = () => postJson(`${API}/admin/api/hf/download`,
                        { repo_id: m.repo_id }).then(r => {
                            toast('download queued (shadow): ' + (r.task_id || r.id || ''));
                            renderTasks('dl-tasks', 'hf');
                        }).catch(e => toast('download: ' + e.message));
                    act.append(b); row.append(act);
                    host.append(row);
                }
            }).catch(e => { $('dl-sub').textContent = e.message; });
        };
        $('dl-go').onclick = go;
        $('dl-q').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    }
    renderTasks('dl-tasks', 'hf');
}

function renderQuantizer() {
    // Same payload shape as the classic page: oq/start {model_path, oq_level,
    // group_size, dtype, text_only, preserve_mtp, enhanced, ...} + live estimate.
    const host = $('qz-form');
    if (!host.dataset.built) {
        host.dataset.built = '1';
        host.innerHTML = '';
        const g = document.createElement('div');
        g.className = 'qz-form';
        const mk = (label, ctl, hint) => {
            const row = document.createElement('label');
            row.className = 'field';
            const t = document.createElement('span'); t.textContent = label;
            row.append(t, ctl);
            if (hint) { const h = document.createElement('small'); h.textContent = hint; row.append(h); }
            g.append(row); return ctl;
        };
        const sel = mk('Model', document.createElement('select'));
        const lvl = mk('oQ level', (() => {
            const s = document.createElement('select');
            for (const l of [2, 2.5, 2.7, 3, 3.5, 4, 5, 6, 8]) {
                const o = document.createElement('option');
                o.value = l; o.textContent = 'oQ' + l; s.append(o);
            }
            s.value = '4'; return s;
        })());
        const dtype = mk('Dtype', (() => {
            const s = document.createElement('select');
            for (const d of ['bfloat16', 'float16']) {
                const o = document.createElement('option');
                o.value = d; o.textContent = d; s.append(o);
            }
            return s;
        })());
        const textOnly = mk('Text only', (() => {
            const w = document.createElement('input'); w.type = 'checkbox'; return w;
        })(), 'skip vision tower for VLMs');
        const preserveMtp = mk('Preserve MTP', (() => {
            const w = document.createElement('input'); w.type = 'checkbox'; return w;
        })(), 'keep multi-token-prediction heads');
        const est = document.createElement('div');
        est.className = 'qz-est dim'; est.textContent = '—';
        const start = document.createElement('button');
        start.className = 'se-btn'; start.textContent = 'Start quantization';
        g.append(est, start);
        host.append(g);

        let models = [];
        fetchJson(`${API}/admin/api/oq/models`).then(d => {
            models = (d.all_models || d.models || []).filter(m => !m.is_quantized);
            sel.innerHTML = '';
            for (const m of models) {
                const o = document.createElement('option');
                o.value = m.path;
                o.textContent = `${m.name} (${m.size_formatted || C.fmtBytes(m.size)})`;
                sel.append(o);
            }
            $('qz-sub').textContent = `${models.length} quantizable models`;
            refreshEst();
        }).catch(e => emptyMsg(host, e.message));

        function refreshEst() {
            if (!sel.value) return;
            fetchJson(`${API}/admin/api/oq/estimate?model_path=${encodeURIComponent(sel.value)}&oq_level=${lvl.value}`)
                .then(e => {
                    const suffix = (dtype.value === 'float16' ? 'f16' : '');
                    est.textContent = `est: ${e.output_size_formatted || C.fmtBytes(e.output_size_bytes)} · ` +
                        `${e.effective_bpw} bpw · stream ${e.memory_streaming_formatted || ''}${suffix}`;
                })
                .catch(e => { est.textContent = 'estimate: ' + e.message; });
        }
        sel.onchange = refreshEst; lvl.onchange = refreshEst;

        start.onclick = () => {
            const m = models.find(x => x.path === sel.value);
            if (!m) { toast('Pick a model'); return; }
            start.disabled = true;
            postJson(`${API}/admin/api/oq/start`, {
                model_path: m.path,
                oq_level: parseFloat(lvl.value),
                group_size: 64,
                dtype: dtype.value,
                text_only: textOnly.checked,
                preserve_mtp: preserveMtp.checked && m.has_mtp_heads,
                sensitivity_model_path: '',
            }).then(r => {
                toast('quantize queued (shadow): ' + m.name);
                renderTasks('qz-tasks', 'oq');
            }).catch(e => toast('quantize: ' + e.message))
              .finally(() => { start.disabled = false; });
        };
    }
    renderTasks('qz-tasks', 'oq');
}

function renderUploader() {
    // Classic payload: upload/start {model_path, repo_id, hf_token, private}
    const host = $('up-form');
    if (!host.dataset.built) {
        host.dataset.built = '1';
        host.innerHTML = '';
        const g = document.createElement('div');
        g.className = 'qz-form';
        const mk = (label, ctl) => {
            const row = document.createElement('label');
            row.className = 'field';
            const t = document.createElement('span'); t.textContent = label;
            row.append(t, ctl); g.append(row); return ctl;
        };
        const sel = mk('Model', document.createElement('select'));
        const repo = mk('Repo id', (() => {
            const i = document.createElement('input');
            i.type = 'text'; i.placeholder = 'username/model-name'; return i;
        })());
        const tok = mk('HF token', (() => {
            const i = document.createElement('input');
            i.type = 'password'; i.placeholder = 'hf_… (stored in shadow only)'; return i;
        })());
        const priv = mk('Private', (() => {
            const w = document.createElement('input'); w.type = 'checkbox'; return w;
        })());
        const start = document.createElement('button');
        start.className = 'se-btn'; start.textContent = 'Upload';
        g.append(start);
        host.append(g);

        let models = [];
        fetchJson(`${API}/admin/api/oq/models`).then(d => {
            models = d.all_models || d.models || [];
            sel.innerHTML = '';
            for (const m of models) {
                const o = document.createElement('option');
                o.value = m.path;
                o.textContent = `${m.name} (${m.size_formatted || C.fmtBytes(m.size)})`;
                sel.append(o);
            }
            $('up-sub').textContent = `${models.length} local models`;
        }).catch(e => emptyMsg(host, e.message));

        start.onclick = () => {
            const m = models.find(x => x.path === sel.value);
            if (!m) { toast('Pick a model'); return; }
            if (!repo.value.trim()) { toast('repo id required'); return; }
            start.disabled = true;
            postJson(`${API}/admin/api/upload/start`, {
                model_path: m.path,
                repo_id: repo.value.trim(),
                hf_token: tok.value,
                private: priv.checked,
            }).then(() => {
                toast('upload queued (shadow): ' + repo.value.trim());
                renderTasks('up-tasks', 'upload');
            }).catch(e => toast('upload: ' + e.message))
              .finally(() => { start.disabled = false; });
        };
    }
    renderTasks('up-tasks', 'upload');
}


/* ---------------- settings sub-pages: stored model settings + prune ----- */
let storedIndex = null;
async function renderStoredSettings() {
    let idx, templates = [];
    try {
        idx = await fetchJson(`${API}/admin/api/model-settings-index`);
        try { templates = (await fetchJson(`${API}/admin/api/profile-templates`)).templates; } catch (_) {}
    } catch (err) { emptyMsg($('ms-body'), err.message); return; }
    storedIndex = idx;
    const known = new Set(adminModels.map(m => m.id));
    const orphan = new Set(idx.orphans || []);
    const f = ($('ms-filter').value || '').toLowerCase();
    $('ms-sub').textContent = `${idx.stored} stored · ${idx.orphans.length} orphaned`;
    const host = $('ms-body'); host.innerHTML = '';
    const rows = (idx.entries || []).filter(e => !f || e.id.toLowerCase().includes(f));
    for (const e of rows) {
        const row = document.createElement('div'); row.className = 'urow usage';
        const name = cell(e.id); name.className = 'uname';
        row.append(name, cell(e.alias || ''),
                   cell(orphan.has(e.id) ? 'ORPHANED' : (known.has(e.id) ? 'KNOWN' : 'EXTERNAL')));
        host.append(row);
    }
    if (!rows.length) host.innerHTML = '<div class="empty">No match</div>';
    const th = $('ms-templates'); th.innerHTML = '';
    if (!templates.length) th.innerHTML = '<div class="empty">No global templates</div>';
    for (const t of templates) {
        const row = document.createElement('div'); row.className = 'urow usage';
        const name = cell(t.display_name || t.name); name.className = 'uname';
        row.append(name, cell(t.description || ''), cell((t.updated_at || '').slice(0, 10)));
        th.append(row);
    }
}
$('ms-filter').oninput = () => renderStoredSettings();

async function openPruneDialog() {
    let orphans = [];
    try {
        const idx = await fetchJson(`${API}/admin/api/model-settings-index`);
        orphans = idx.orphans || [];
    } catch (err) { toast('prune check failed: ' + err.message); return; }
    if (!orphans.length) { toast('Nothing to prune — every stored id maps to a model on disk.'); return; }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal nasa';
    const h = document.createElement('h3');
    h.textContent = `Prune model settings (${orphans.length})`;
    const sub = document.createElement('div');
    sub.className = 'se-hint';
    sub.textContent = 'Stored configuration for models that no longer exist on disk. '
        + 'Removed entries are deleted from the sandbox model_settings.json.';
    const list = document.createElement('div');
    list.className = 'prune-list';
    const checks = orphans.map(id => {
        const lbl = document.createElement('label');
        lbl.className = 'row';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = true; cb.value = id;
        lbl.append(cb, cell(id));
        list.append(lbl);
        return cb;
    });
    const bar = document.createElement('div');
    bar.className = 'row buttons';
    const all = document.createElement('button');
    all.textContent = 'Select all';
    all.onclick = () => checks.forEach(c => c.checked = true);
    const none = document.createElement('button');
    none.textContent = 'Select none';
    none.onclick = () => checks.forEach(c => c.checked = false);
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => overlay.remove();
    const doIt = document.createElement('button');
    doIt.className = 'danger';
    doIt.textContent = 'Prune selected';
    doIt.onclick = async () => {
        const ids = checks.filter(c => c.checked).map(c => c.value);
        if (!ids.length) { toast('Nothing selected'); return; }
        try {
            const r = await postJson(`${API}/admin/api/prune-model-settings`, { ids });
            toast(`Pruned ${r.removed.length} setting record(s)` +
                (r.removed_templates && r.removed_templates.length
                    ? `, ${r.removed_templates.length} template(s)` : ''));
            overlay.remove();
            renderStoredSettings();
            renderModelAdmin(true);
        } catch (err) { toast('prune failed: ' + err.message); }
    };
    bar.append(all, none, document.createElement('span'), cancel, doIt);
    box.append(h, sub, list, bar);
    overlay.append(box);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.append(overlay);
}
$('btn-prune').onclick = openPruneDialog;

function pollIntegrations() {
    fetchJson(`${API}/admin/api/global-settings`).then(d => {
        const body = $('is-body'); body.innerHTML = '';
        const secs = [];
        const walk = (obj, prefix) => {
            for (const [k, v] of Object.entries(obj || {})) {
                if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, prefix ? prefix + '.' + k : k);
                else secs.push([prefix ? prefix + '.' + k : k, Array.isArray(v) ? v.join(', ') : String(v)]);
            }
        };
        walk(d.integrations || {}, '');
        walk(d.claude_code || {}, 'claude_code.');
        walk(d.mcp || {}, 'mcp.');
        $('is-sub').textContent = `${secs.length} keys · read-only via gateway`;
        if (!secs.length) { body.innerHTML = '<div class="empty">No integration settings exposed</div>'; return; }
        for (const [k, v] of secs) {
            const row = document.createElement('div'); row.className = 'urow settings';
            const kc = cell(k); kc.className = 'uname';
            const vc = cell(v.length > 120 ? v.slice(0, 117) + '…' : v); vc.className = 'dim';
            row.append(kc, vc); body.append(row);
        }
    }).catch(e => { emptyMsg($('is-body'), e.message); });
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
