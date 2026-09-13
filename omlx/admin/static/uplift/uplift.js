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
const API_DEFAULT = location.protocol + '//' + location.hostname + ':11437';
const API = qp.has('api') ? qp.get('api') : API_DEFAULT;

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
    models: ['settings', 'helper', 'manager', 'downloader', 'uploader', 'quantizer'],
    settings: ['global'],
};
const SUB_LABELS = {
    manager: 'Manager', downloader: 'Downloader', quantizer: 'oQ(e) Quantization',
    uploader: 'Uploader', helper: 'Helper Models', settings: 'Model Settings',
    global: 'Server Settings',
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
    // dropdown button label gets rebuilt (textContent above wiped it)
    {
        const dd = 'dd-models-btn';
        $(dd).textContent = 'Models ';
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
    if (ddForceOpen !== 'dd-models-menu') $('dd-models-menu').hidden = true;
    ddForceOpen = null;
    requestAnimationFrame(resizeCharts);   // charts may have become visible
    if (tab === 'usage') pollUsage();
    if (tab === 'logs') pollLogs();
    if (tab === 'models') {
        renderModelAdmin();
        if (sub === 'downloader') initDownloader();
        if (sub === 'quantizer') renderQuantizer();
        if (sub === 'uploader') renderUploader();
        if (sub === 'helper') renderHelperModels();
        if (sub === 'settings') renderStoredSettings();
    }
    if (tab === 'settings') pollGlobalSettings();
}
addEventListener('hashchange', applyTab);

/* dropdown menus: hover opens, click toggles, outside click / Escape closes */
let ddForceOpen = null;
const ddTimers = {};
function ddOpen(menuId, open) { $(menuId).hidden = !open; }
function bindDropdown(btnId, menuId) {
    const btn = $(btnId), menu = $(menuId);
    const wrap = btn.closest('.dd');
    btn.onclick = e => {
        e.preventDefault();
        clearTimeout(ddTimers[menuId]);
        const open = menu.hidden;
        if (currentTab() !== btn.dataset.tab) {
            ddForceOpen = menuId;              // re-open after the tab switch
            location.hash = '#' + btn.dataset.tab;
        }
        ddOpen(menuId, open);
    };
    // hover behaviour (like the classic navbar)
    wrap.addEventListener('mouseenter', () => {
        clearTimeout(ddTimers[menuId]);
        ddOpen(menuId, true);
    });
    wrap.addEventListener('mouseleave', () => {
        clearTimeout(ddTimers[menuId]);
        ddTimers[menuId] = setTimeout(() => { menu.hidden = true; }, 250);
    });
    for (const a of menu.querySelectorAll('a'))
        a.addEventListener('click', e => {
            e.preventDefault();
            menu.hidden = true;
            location.hash = '#' + btn.dataset.tab + '/' + a.dataset.sub;
        });
}
bindDropdown('dd-models-btn', 'dd-models-menu');
document.addEventListener('click', e => {
    const menu = $('dd-models-menu');
    if (!menu.hidden && !menu.contains(e.target) && !$('dd-models-btn').contains(e.target))
        menu.hidden = true;
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $('dd-models-menu').hidden = true;
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
    if (API !== API_DEFAULT) { chip.textContent = 'direct'; chip.title = 'API ' + (API || location.origin); return; }
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
/* ---- Server settings: editable form mirroring the classic Settings page.
   Same 11 sections, same fields, labels, hints, restart badges and
   conditional visibility (i18n strings copied from the original catalog).
   Saves replicate classic saveGlobalSettings(): full flat payload POSTed to
   global-settings — the gateway shadows it, real oMLX is never modified. */
const GS_LABELS = {
    lang: { en: 'English', zh: '中文（简体）', 'zh-TW': '中文（繁體）', ko: '한국어',
            ja: '日本語', ru: 'Русский', es: 'Español', fr: 'Français',
            'pt-BR': 'Português (Brasil)' },
    auth: { api_key: 'API Key',
        api_key_hint: 'Clients must send this key in the Authorization header.',
        api_key_placeholder: 'Enter new API key',
        base_path: 'Base Path',
        base_path_hint: 'URL prefix when served behind a reverse proxy (e.g. /omlx).',
        skip: 'Skip API key verification',
        skip_hint: 'Disable authentication for local development.',
        skip_warning: 'Anyone on the network can call this server.' },
    server: { host: 'Host', host_placeholder: '127.0.0.1',
        port: 'Port', log_level: 'Log level',
        levels: [['error','Error'],['warning','Warning'],['info','Info'],
                 ['debug','Debug'],['trace','Trace']] },
    model: { dirs: 'Model Directories', ph_primary: '/path/to/models',
        ph_additional: 'Additional directory…',
        fallback: 'Model Fallback', fallback_desc: 'Alias to use when the requested model is unavailable.',
        hide_helper: 'Hide helper models', hide_helper_desc: 'Keep drafters and assistants out of model lists.',
        hf_cache: 'Hugging Face cache', hf_cache_desc: 'Reuse downloaded models from the local HF cache.',
        idle: 'Idle Timeout', idle_desc: 'Unload a model after it has been unused for this long.',
        idle_opts: [['','Never'],['900','15 minutes'],['1800','30 minutes'],
                    ['3600','1 hour'],['7200','2 hours'],['28800','8 hours'],
                    ['86400','24 hours']] },
    res: { max_conc: 'Max Concurrent Requests',
        max_conc_hint: 'Requests admitted at once; others queue.',
        batch: 'Embedding Batch Size',
        batch_hint: 'Texts encoded per embedding forward pass.',
        chunked: 'Chunked Prefill', chunked_desc: 'Split long prompts to interleave with decode.',
        fairness: 'Decode Fairness', fairness_desc: 'Round-robin decode slots across requests.',
        prio: 'Prefill Priority', prio_speed: 'Speed', prio_context: 'Max Context',
        guard: 'Prefill Memory Guard',
        guard_desc: 'Refuse prefill when free memory is below the guard.',
        tier: 'Memory Guard Tier',
        tiers: [['safe','Safe'],['balanced','Balanced'],['aggressive','Aggressive'],
                ['custom','Custom']],
        custom: 'Custom Ceiling (GB)',
        custom_ph: 'e.g. 48',
        cold: 'Cold Cache Limit',
        cold_desc: 'Cap on non-hot KV cache blocks.',
        hot: 'Hot Cache Limit' },
    cache: { enabled: 'KV Cache', enabled_hint: 'Keep KV blocks between requests.',
        hot_only: 'Hot Cache Only',
        hot_only_hint: 'Never spill cached KV to SSD.',
        ssd_dir: 'SSD Cache Directory' },
    gen: { max_ctx: 'Max Context Window',
        max_ctx_hint: 'Largest context a request may claim.',
        max_policy: 'Max Context Policy',
        max_policy_hint: 'Override applied to model default (blank = model decides).',
        max_tokens: 'Max Tokens',
        temperature: 'Temperature', temperature_hint: 'Sampling randomness (0 = greedy).',
        top_p: 'Top-P (Nucleus)', top_p_hint: 'Cumulative probability mass kept.',
        top_k: 'Top-K', top_k_hint: '0 disables top-K.',
        rep_pen: 'Repetition Penalty', rep_pen_hint: 'Penalty for reusing recent tokens (1 = off).' },
    mcp: { path: 'MCP Config Path',
        ph: '~/.mcp.json',
        expose: 'Expose MCP Tools',
        expose_hint: 'Serve built-in tools over Model Context Protocol.' },
    usage: { history: 'Usage History',
        history_hint: 'Record per-model token usage for the Usage tab.' },
    net: { http_proxy: 'HTTP Proxy', proxy_hint: 'Example: http://proxy.company.com:8080',
        https_proxy: 'HTTPS Proxy',
        no_proxy: 'No Proxy', no_proxy_hint: 'Comma-separated hosts to bypass proxy',
        ca_bundle: 'CA Bundle',
        ca_hint: 'Path to PEM file for corporate TLS interception' },
    adv: { distributed: 'Distributed Inference',
        distributed_enabled: 'Enable distributed inference',
        distributed_hint: 'Split layers across multiple machines (experimental).',
        perf: 'Performance', streaming: 'Streaming', uploads: 'Uploads',
        burst: 'Burst Decode',
        burst_hint: 'Speculative decode aggressiveness for burst throughput.',
        burst_opts: [['off','Off'],['light','Light'],['balanced','Balanced'],
                     ['aggressive','Aggressive']],
        sse: 'SSE Keepalive Mode',
        sse_hint: 'How keepalives are emitted on streaming responses.',
        sse_opts: [['chunk','Chunk'],['comment','Comment'],['off','Off']],
        mid_sys: 'Preserve Mid-System Cache',
        mid_sys_hint: 'Keep cached KV for system prompts placed mid-conversation.',
        audio: 'Maximum Audio Upload Size (MB)',
        audio_hint: 'Reject audio attachments above this size.',
        ane: 'ANE Compile Cache',
        ane_hint: 'Cache CoreML compiled graphs on the Neural Engine.',
        wt: 'Hot Cache Write-Through',
        wt_hint: 'Write hot blocks to SSD immediately.',
        blocks: 'Initial Cache Blocks',
        blocks_hint: 'KV blocks allocated at startup.',
        gdn_store: 'GDN Snapshot Storage',
        gdn_store_hint: 'Where Gated-DeltaNet state snapshots go.',
        gdn_store_opts: [['auto','Auto'],['ssd_sidecar','SSD Sidecar'],
                         ['embedded','Embedded']],
        gdn_pend: 'GDN Pending Write Limit',
        gdn_pend_hint: 'Max queued SSD writes before backpressure.',
        gdn_prec: 'GDN Sidecar State Precision',
        gdn_prec_hint: 'Quantisation of sidecar-held recurrent state.',
        gdn_prec_opts: [['fp32','FP32'],['rht_int16','RHT INT16'],['bf16','BF16'],
                        ['int8','INT8'],['rht_int8','RHT INT8']],
        gdn_prec_warning: 'INT8/RHT INT8 state precision may degrade long-context quality.' },
    badge: 'RESTART REQUIRED',
    restart_notice: 'Host and port changes take effect after a restart.',
};

// shadow key -> nested [section, field] map (mirrors GlobalSettingsRequest)
const GS_MAP = {
    host: ['server','host'], port: ['server','port'],
    log_level: ['server','log_level'],
    sse_keepalive_mode: ['server','sse_keepalive_mode'],
    burst_decode_mode: ['server','burst_decode_mode'],
    preserve_mid_system_cache: ['server','preserve_mid_system_cache'],
    distributed_inference_enabled: ['server','distributed_inference_enabled'],
    max_audio_upload_size: ['server','max_audio_upload_size'],
    model_dirs: ['model','model_dirs'], model_fallback: ['model','model_fallback'],
    hide_helper_models: ['model','hide_helper_models'],
    idle_timeout_seconds: ['idle_timeout','idle_timeout_seconds'],
    hf_cache_enabled: ['huggingface','hf_cache_enabled'],
    memory_prefill_memory_guard: ['memory','prefill_memory_guard'],
    memory_guard_tier: ['memory','memory_guard_tier'],
    memory_guard_custom_ceiling_gb: ['memory','memory_guard_custom_ceiling_gb'],
    max_concurrent_requests: ['scheduler','max_concurrent_requests'],
    embedding_batch_size: ['scheduler','embedding_batch_size'],
    chunked_prefill: ['scheduler','chunked_prefill'],
    prefill_priority: ['scheduler','prefill_priority'],
    decode_fairness: ['scheduler','decode_fairness'],
    cache_enabled: ['cache','enabled'],
    ssd_cache_dir: ['cache','ssd_cache_dir'],
    hot_cache_only: ['cache','hot_cache_only'],
    hot_cache_write_through: ['cache','hot_cache_write_through'],
    ane_compile_cache: ['cache','ane_compile_cache'],
    initial_cache_blocks: ['cache','initial_cache_blocks'],
    gdn_snapshot_storage: ['cache','gdn_snapshot_storage'],
    gdn_ssd_pending_max_size: ['cache','gdn_ssd_pending_max_size'],
    gdn_sidecar_precision: ['cache','gdn_sidecar_precision'],
    sampling_max_context_window: ['sampling','max_context_window'],
    sampling_max_context_window_policy: ['sampling','max_context_window_policy'],
    sampling_max_tokens: ['sampling','max_tokens'],
    sampling_temperature: ['sampling','temperature'],
    sampling_top_p: ['sampling','top_p'], sampling_top_k: ['sampling','top_k'],
    sampling_repetition_penalty: ['sampling','repetition_penalty'],
    mcp_config: ['mcp','config_path'], mcp_expose_tools: ['mcp','expose_tools'],
    usage_history: ['usage','usage_history'],
    network_http_proxy: ['network','http_proxy'],
    network_https_proxy: ['network','https_proxy'],
    network_no_proxy: ['network','no_proxy'],
    network_ca_bundle: ['network','ca_bundle'],
    ui_language: ['ui','language'],
    api_key: ['auth','api_key'],
    skip_api_key_verification: ['auth','skip_api_key_verification'],
};

let GS = null;   // merged working copy (upstream + shadow)

function gsGet(sec, field) {
    const sh = GS._shadow || {};
    const flat = Object.keys(GS_MAP).find(k =>
        GS_MAP[k][0] === sec && GS_MAP[k][1] === field);
    if (flat && flat in sh) return sh[flat];
    const v = (GS[sec] || {})[field];
    return v;
}

async function gsSave(fields) {
    // classic saveGlobalSettings(): every mapped field of the working copy,
    // plus the changed ones; server applies what's present, ignores nulls
    const body = Object.assign({}, GS._shadow || {});
    Object.assign(body, fields);
    try {
        const r = await fetch(`${API}/admin/api/global-settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!r.ok) { toast('save failed: HTTP ' + r.status); return false; }
        GS._shadow = body;
        $('gs-sub').textContent = 'saved ✓ (shadow — real oMLX untouched)';
        return true;
    } catch (err) { toast('save failed: ' + err.message); return false; }
}

function gsBadge() {
    const b = document.createElement('span');
    b.className = 'spill load'; b.textContent = GS_LABELS.badge;
    b.title = 'Applied after oMLX restart';
    return b;
}

function gsRow(sec, labelTxt, hint, control, opts) {
    opts = opts || {};
    const row = document.createElement('div');
    row.className = 'urow settings';
    const lab = cell(labelTxt); lab.className = 'uname';
    if (hint) {
        const h = document.createElement('small');
        h.className = 'dim'; h.textContent = hint;
        lab.append(document.createElement('br'), h);
    }
    if (opts.badge) lab.append(gsBadge());
    const ctl = cell(''); ctl.className = 'gctl';
    ctl.append(control);
    row.append(lab, ctl);
    return row;
}

function gsText(sec, field, flat, L, extra) {
    const inp = document.createElement('input');
    inp.type = (extra && extra.type) || 'text';
    if (extra && extra.placeholder) inp.placeholder = extra.placeholder;
    if (extra && extra.min !== undefined) inp.min = extra.min;
    if (extra && extra.max !== undefined) inp.max = extra.max;
    if (extra && extra.step !== undefined) inp.step = extra.step;
    const v = gsGet(sec, field);
    inp.value = v == null ? '' : v;
    if (extra && extra.range) {
        const out = document.createElement('span');
        out.className = 'gval'; out.textContent = String(v);
        inp.oninput = () => { out.textContent = inp.value; };
        inp.onchange = async () => { await gsSave({ [flat]: Number(inp.value) }); };
        const wrap = document.createElement('span');
        wrap.className = 'grange'; wrap.append(inp, out);
        return wrap;
    }
    inp.onchange = async () => {
        let val = inp.value;
        if (extra && extra.number) val = val === '' ? null : Number(val);
        if (extra && extra.bool) val = inp.checked;
        if (await gsSave({ [flat]: val })) {
            if (extra && extra.reload) renderGlobalSettings();
        }
    };
    return inp;
}

function gsToggle(flat, on) {
    const t = document.createElement('input');
    t.type = 'checkbox'; t.checked = !!on;
    t.onchange = () => gsSave({ [flat]: t.checked });
    return t;
}

function gsSelect(flat, options, cur) {
    const sel = document.createElement('select');
    for (const [v, t] of options) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t; sel.append(o);
    }
    sel.value = cur == null ? '' : String(cur);
    sel.onchange = async () => {
        if (await gsSave({ [flat]: sel.value === '' ? null : sel.value }))
            renderGlobalSettings();   // refresh conditional rows (x-show parity)
    };
    return sel;
}

function gsTitle(t) {
    const h = document.createElement('div');
    h.className = 'gs-title'; h.textContent = t;
    return h;
}

async function pollGlobalSettings() {
    let d;
    try { d = await fetchJson(`${API}/admin/api/global-settings`); }
    catch (err) { emptyMsg($('gs-body'), 'global-settings not served (' + err.message + ')'); return; }
    GS = d;   // gateway already overlaid the shadow; resave accumulates
    renderGlobalSettings();
}

function renderGlobalSettings() {
    const body = document.createElement('div');   // staged; grouped into boxes below
    body.textContent = '';
    const L = GS_LABELS;

    // ---- Global
    body.append(gsTitle('Global'));
    const notice = cell(L.restart_notice + ' ' + L.badge);
    notice.className = 'dim warn-line';
    body.append(notice);

    // ---- Language
    body.append(gsTitle('Language'));
    body.append(gsRow('ui', 'Interface language', '',
        gsSelect('ui_language', Object.entries(L.lang), gsGet('ui','language'))));

    // ---- Auth
    body.append(gsTitle('Auth'));
    body.append(gsRow('auth', L.auth.api_key, L.auth.api_key_hint,
        gsText('auth','api_key','api_key', L, { type: 'password',
            placeholder: L.auth.api_key_placeholder, reload: true })));
    const bpIn = document.createElement('input');
    bpIn.type = 'text'; bpIn.value = GS.base_path || '';
    bpIn.disabled = true;
    bpIn.title = 'Set at launch (--base-path); read-only';
    body.append(gsRow('auth', L.auth.base_path, L.auth.base_path_hint, bpIn));
    body.append(gsRow('auth', L.auth.skip, L.auth.skip_hint + ' ' + L.auth.skip_warning,
        gsToggle('skip_api_key_verification', gsGet('auth','skip_api_key_verification'))));

    // ---- Server
    body.append(gsTitle('Server'));
    body.append(gsRow('server', L.server.host, '',
        gsText('server','host','host', L, { placeholder: L.server.host_placeholder }),
        { badge: true }));
    body.append(gsRow('server', L.server.port, '',
        gsText('server','port','port', L, { number: true }), { badge: true }));
    body.append(gsRow('server', L.server.log_level, '',
        gsSelect('log_level', L.server.levels, gsGet('server','log_level'))));

    // ---- Model
    body.append(gsTitle('Model'));
    const dirs = gsGet('model','model_dirs') || [];
    const dl = document.createElement('div');
    dl.className = 'gs-dirs';
    dirs.forEach((d, i) => {
        const one = document.createElement('div');
        one.className = 'gs-dir';
        const inp = document.createElement('input');
        inp.type = 'text'; inp.value = d;
        inp.placeholder = i === 0 ? L.model.ph_primary : L.model.ph_additional;
        const rm = document.createElement('button');
        rm.className = 'se-btn act'; rm.textContent = '×';
        rm.style.display = dirs.length > 1 ? '' : 'none';
        rm.onclick = async () => {
            const nd = dirs.filter((_, j) => j !== i);
            if (await gsSave({ model_dirs: nd })) renderGlobalSettings();
        };
        inp.onchange = async () => {
            const nd = dirs.slice(); nd[i] = inp.value;
            if (await gsSave({ model_dirs: nd })) renderGlobalSettings();
        };
        one.append(inp, rm);
        dl.append(one);
    });
    const add = document.createElement('button');
    add.className = 'se-btn act'; add.textContent = '+ add directory';
    add.onclick = async () => {
        if (await gsSave({ model_dirs: dirs.concat('') })) renderGlobalSettings();
    };
    dl.append(add);
    body.append(gsRow('model', L.model.dirs, '', dl));
    body.append(gsRow('model', L.model.fallback, L.model.fallback_desc,
        gsText('model','model_fallback','model_fallback', L)));
    body.append(gsRow('model', L.model.hide_helper, L.model.hide_helper_desc,
        gsToggle('hide_helper_models', gsGet('model','hide_helper_models'))));
    body.append(gsRow('model', L.model.hf_cache, L.model.hf_cache_desc,
        gsToggle('hf_cache_enabled', gsGet('huggingface','hf_cache_enabled'))));
    const hfp = cell((GS.huggingface || {}).hf_cache_path || '—');
    hfp.className = 'dim';
    body.append(gsRow('model', 'HF cache path', '', hfp));
    body.append(gsRow('model', L.model.idle, L.model.idle_desc,
        gsSelect('idle_timeout_seconds', L.model.idle_opts,
                 gsGet('idle_timeout','idle_timeout_seconds') ?? '')));

    // ---- Resource Management
    body.append(gsTitle('Resource Management'));
    body.append(gsRow('res', L.res.max_conc, L.res.max_conc_hint,
        gsText('scheduler','max_concurrent_requests','max_concurrent_requests', L,
               { number: true, min: 1 })));
    body.append(gsRow('res', L.res.batch, L.res.batch_hint,
        gsText('scheduler','embedding_batch_size','embedding_batch_size', L,
               { number: true, min: 1 })));
    body.append(gsRow('res', L.res.chunked, L.res.chunked_desc,
        gsToggle('chunked_prefill', gsGet('scheduler','chunked_prefill'))));
    body.append(gsRow('res', L.res.prio, '',
        gsSelect('prefill_priority', [['speed', L.res.prio_speed],
                                      ['context', L.res.prio_context]],
                 gsGet('scheduler','prefill_priority'))));
    body.append(gsRow('res', L.res.fairness, L.res.fairness_desc,
        gsToggle('decode_fairness', gsGet('scheduler','decode_fairness'))));
    body.append(gsRow('res', L.res.guard, L.res.guard_desc,
        gsToggle('memory_prefill_memory_guard', gsGet('memory','prefill_memory_guard'))));
    const tierSel = gsSelect('memory_guard_tier', L.res.tiers,
                             gsGet('memory','memory_guard_tier'));
    body.append(gsRow('res', L.res.tier, '', tierSel));
    if (gsGet('memory','memory_guard_tier') === 'custom') {
        body.append(gsRow('res', L.res.custom, '',
            gsText('memory','memory_guard_custom_ceiling_gb',
                   'memory_guard_custom_ceiling_gb', L,
                   { number: true, min: 1, step: 1, placeholder: L.res.custom_ph })));
    }

    // ---- Cache
    body.append(gsTitle('Cache'));
    body.append(gsRow('cache', L.cache.enabled, L.cache.enabled_hint,
        gsToggle('cache_enabled', gsGet('cache','enabled'))));
    body.append(gsRow('cache', L.cache.hot_only, L.cache.hot_only_hint,
        gsToggle('hot_cache_only', gsGet('cache','hot_cache_only'))));
    body.append(gsRow('cache', L.cache.ssd_dir, '',
        gsText('cache','ssd_cache_dir','ssd_cache_dir', L)));

    // ---- Generation Defaults
    body.append(gsTitle('Generation Defaults'));
    const temp = gsText('sampling','temperature','sampling_temperature', L,
        { range: true, min: 0, max: 2, step: 0.1 });
    body.append(gsRow('gen', L.gen.temperature, L.gen.temperature_hint, temp));
    const topp = gsText('sampling','top_p','sampling_top_p', L,
        { range: true, min: 0, max: 1, step: 0.05 });
    body.append(gsRow('gen', L.gen.top_p, L.gen.top_p_hint, topp));
    body.append(gsRow('gen', L.gen.top_k, L.gen.top_k_hint,
        gsText('sampling','top_k','sampling_top_k', L, { number: true, min: 0 })));
    body.append(gsRow('gen', L.gen.max_tokens, '',
        gsText('sampling','max_tokens','sampling_max_tokens', L,
               { number: true, min: 1, max: 131072 })));
    body.append(gsRow('gen', L.gen.max_ctx, L.gen.max_ctx_hint,
        gsText('sampling','max_context_window','sampling_max_context_window', L,
               { number: true, min: 1, max: 2097152 })));
    body.append(gsRow('gen', L.gen.max_policy, L.gen.max_policy_hint,
        gsText('sampling','max_context_window_policy',
               'sampling_max_context_window_policy', L,
               { number: true, min: 1, max: 2097152, placeholder: 'None' })));
    body.append(gsRow('gen', L.gen.rep_pen, L.gen.rep_pen_hint,
        gsText('sampling','repetition_penalty','sampling_repetition_penalty', L,
               { number: true, min: 1, step: 0.05 })));

    // ---- MCP
    body.append(gsTitle('MCP'));
    body.append(gsRow('mcp', L.mcp.path, '',
        gsText('mcp','config_path','mcp_config', L, { placeholder: L.mcp.ph }),
        { badge: true }));
    body.append(gsRow('mcp', L.mcp.expose, L.mcp.expose_hint,
        gsToggle('mcp_expose_tools', gsGet('mcp','expose_tools'))));

    // ---- Usage & Network
    body.append(gsTitle('Usage & Network'));
    body.append(gsRow('usage', L.usage.history, L.usage.history_hint,
        gsToggle('usage_history', gsGet('usage','usage_history'))));
    body.append(gsRow('net', L.net.http_proxy, L.net.proxy_hint,
        gsText('network','http_proxy','network_http_proxy', L)));
    body.append(gsRow('net', L.net.https_proxy, L.net.proxy_hint,
        gsText('network','https_proxy','network_https_proxy', L)));
    body.append(gsRow('net', L.net.no_proxy, L.net.no_proxy_hint,
        gsText('network','no_proxy','network_no_proxy', L)));
    body.append(gsRow('net', L.net.ca_bundle, L.net.ca_hint,
        gsText('network','ca_bundle','network_ca_bundle', L)));

    // ---- Advanced
    body.append(gsTitle('Advanced'));
    body.append(gsRow('adv', L.adv.distributed_enabled, L.adv.distributed_hint,
        gsToggle('distributed_inference_enabled',
                 gsGet('server','distributed_inference_enabled'))));
    body.append(gsRow('adv', L.adv.burst, L.adv.burst_hint,
        gsSelect('burst_decode_mode', L.adv.burst_opts,
                 gsGet('server','burst_decode_mode'))));
    body.append(gsRow('adv', L.adv.sse, L.adv.sse_hint,
        gsSelect('sse_keepalive_mode', L.adv.sse_opts,
                 gsGet('server','sse_keepalive_mode'))));
    body.append(gsRow('adv', L.adv.mid_sys, L.adv.mid_sys_hint,
        gsToggle('preserve_mid_system_cache', gsGet('server','preserve_mid_system_cache'))));
    body.append(gsRow('adv', L.adv.audio, L.adv.audio_hint,
        gsText('server','max_audio_upload_size','max_audio_upload_size', L,
               { number: true, min: 1 })));
    body.append(gsRow('adv', L.adv.ane, L.adv.ane_hint,
        gsToggle('ane_compile_cache', gsGet('cache','ane_compile_cache'))));
    body.append(gsRow('adv', L.adv.wt, L.adv.wt_hint,
        gsToggle('hot_cache_write_through', gsGet('cache','hot_cache_write_through'))));
    body.append(gsRow('adv', L.adv.blocks, L.adv.blocks_hint,
        gsText('cache','initial_cache_blocks','initial_cache_blocks', L,
               { number: true, min: 1 })));
    const gsel = gsSelect('gdn_snapshot_storage', L.adv.gdn_store_opts,
                          gsGet('cache','gdn_snapshot_storage'));
    body.append(gsRow('adv', L.adv.gdn_store, L.adv.gdn_store_hint, gsel));
    if (gsGet('cache','gdn_snapshot_storage') === 'ssd_sidecar') {
        body.append(gsRow('adv', L.adv.gdn_pend, L.adv.gdn_pend_hint,
            gsText('cache','gdn_ssd_pending_max_size','gdn_ssd_pending_max_size', L,
                   { placeholder: '512MB' })));
        const prow = gsRow('adv', L.adv.gdn_prec, L.adv.gdn_prec_hint,
            gsSelect('gdn_sidecar_precision', L.adv.gdn_prec_opts,
                     gsGet('cache','gdn_sidecar_precision')));
        if (['int8','rht_int8'].includes(gsGet('cache','gdn_sidecar_precision'))) {
            const w = document.createElement('small');
            w.className = 'fhint warn'; w.textContent = L.adv.gdn_prec_warning;
            prow.querySelector('.uname').append(w);
        }
        body.append(prow);
    }

    // group staged children into bordered section boxes inside a capped
    // multi-column flow (gs-wrap); each gs-title starts a new box
    const wrap = $('gs-body');
    wrap.textContent = '';
    wrap.classList.add('gs-wrap');
    let box = null;
    for (const n of Array.from(body.childNodes)) {
        if (n.nodeType === 1 && n.classList.contains('gs-title')) {
            box = document.createElement('div');
            box.className = 'gs-box';
            const h = document.createElement('div');
            h.className = 'gs-box-title';
            h.textContent = n.textContent;
            box.append(h);
            wrap.append(box);
        } else if (box) {
            box.append(n);
        } else {
            wrap.append(n);
        }
    }
}

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

/* ---- oQ quantizer: faithful port of the classic page's form.
   All option lists come from the server (/oq/models); the candidate
   filters mirror oqSensitivityModelCandidates / oqMtpAssistantCandidates
   in dashboard.js; estimate mirrors oqRefreshEstimate (300 ms debounce,
   preserve_mtp param) including the client-side sensitivity-model memory
   approximation (size x 1.5 + 5 GB). Labels from models.oq.* in i18n. -- */
const OQ_LEVELS = [2, 2.5, 2.7, 3, 3.5, 4, 5, 6, 8];
function oqMtpFamily(t) {
    if (!t) return null;
    if (t.startsWith('qwen3_6')) return 'qwen3_6';
    if (t.startsWith('qwen3_5')) return 'qwen3_5';
    return null;
}
function qzField(host, label, ctl, hint) {
    const row = document.createElement('label');
    row.className = 'field';
    const t = document.createElement('span'); t.textContent = label;
    row.append(t);
    if (ctl) row.append(ctl);
    if (hint) { const h = document.createElement('small'); h.textContent = hint; row.append(h); }
    host.append(row);
    return row;
}
function qzSelect(placeholder) {
    const sel = document.createElement('select');
    const o = document.createElement('option');
    o.value = ''; o.textContent = placeholder;
    sel.append(o);
    return sel;
}

function renderQuantizer() {
    const host = $('qz-form');
    if (!host.dataset.built) {
        host.dataset.built = '1';
        host.innerHTML = '';
        const g = document.createElement('div');
        g.className = 'qz-form';
        host.append(g);

        const st = { all: [], models: [] };
        const selModel = qzSelect('Select a model...');
        qzField(g, 'Source Model', selModel, 'full precision only');
        const rowSens = qzField(g, 'Sensitivity Model', null,
            'Use a quantized version of the source model to analyze layer sensitivity with ~4x less memory.');
        const selSens = qzSelect('None (use source model)');
        rowSens.insertBefore(selSens, rowSens.querySelector('small'));
        const selLevel = qzSelect(null);
        selLevel.remove(0);
        for (const l of OQ_LEVELS) {
            const o = document.createElement('option');
            o.value = l; selLevel.append(o);
        }
        selLevel.value = '4';
        const rowLevel = qzField(g, 'oQ Level', selLevel);
        const start = document.createElement('button');
        start.className = 'se-btn'; start.textContent = 'Start';
        g.append(rowLevel);

        // enhanced (oQe) block
        const cbEnh = document.createElement('input'); cbEnh.type = 'checkbox';
        qzField(g, 'Enhanced quantization (oQe)', cbEnh,
            'Use imatrix calibration to weight affine quantization by activation importance.');
        const rowEnhOnly = document.createElement('div');
        rowEnhOnly.className = 'qz-enh-only'; rowEnhOnly.hidden = true;
        const cbReuse = document.createElement('input'); cbReuse.type = 'checkbox'; cbReuse.checked = true;
        qzField(rowEnhOnly, 'Reuse imatrix cache', cbReuse,
            'Use a compatible cached imatrix when available; otherwise collect a new one.');
        const inpCache = document.createElement('input');
        inpCache.type = 'text'; inpCache.placeholder = 'Automatic';
        qzField(rowEnhOnly, 'Imatrix cache path', inpCache);
        const cbStrict = document.createElement('input'); cbStrict.type = 'checkbox';
        qzField(rowEnhOnly, 'Strict imatrix coverage', cbStrict,
            'Fail when a quantized tensor has no matching imatrix entry instead of falling back.');
        g.append(rowEnhOnly);

        // advanced block
        const adv = document.createElement('div');
        adv.className = 'qz-adv';
        const advT = document.createElement('div');
        advT.className = 'qz-adv-title'; advT.textContent = 'Advanced Settings';
        adv.append(advT);
        const dtypes = document.createElement('div');
        dtypes.className = 'qz-toggle';
        const dtype = { v: 'bfloat16' };
        for (const d of ['bfloat16', 'float16']) {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = d;
            b.className = d === dtype.v ? 'on' : '';
            b.onclick = () => {
                dtype.v = d;
                for (const x of dtypes.children) x.classList.toggle('on', x.textContent === d);
            };
            dtypes.append(b);
        }
        qzField(adv, 'Non-quant weight dtype', dtypes,
            'float16 gives ~20% faster prefill on M1/M2 Apple Silicon (native fp16). bfloat16 is safer for newer models.').dataset.k = 'dtype';
        const cbMtp = document.createElement('input'); cbMtp.type = 'checkbox';
        const rowMtp = qzField(adv, 'Preserve MTP weights', cbMtp,
            'Keep mtp.* tensors and config fields in the output model so the Lightning MTP drafter still works.');
        const mtpNa = document.createElement('small');
        mtpNa.className = 'warn-text'; mtpNa.textContent = 'Source model has no MTP heads.';
        mtpNa.hidden = true; rowMtp.append(mtpNa);
        const selCombine = qzSelect('None');
        const rowCombine = qzField(adv, 'Combine other model\u2019s MTP head', selCombine,
            'Graft the MTP head from a same-architecture donor checkpoint (e.g. the base model of a fine-tune).');
        const cbText = document.createElement('input'); cbText.type = 'checkbox';
        const rowText = qzField(adv, 'Text only', cbText);
        const vlmWarn = document.createElement('small');
        vlmWarn.className = 'warn-text';
        vlmWarn.textContent = 'Selected model is a VLM — vision tower will be skipped.';
        vlmWarn.hidden = true; rowText.append(vlmWarn);
        g.append(adv);

        const est = document.createElement('div');
        est.className = 'qz-est dim'; est.textContent = '\u2014';
        g.append(est, start);

        const levelLabel = l => 'oQ' + l + (cbEnh.checked ? 'e' : '');
        const refreshLevelLabels = () => {
            for (const o of selLevel.options) o.textContent = levelLabel(o.value);
        };

        let estTimer = null;
        function refreshEst() {
            clearTimeout(estTimer);
            const m = st.models.find(x => x.path === selModel.value);
            if (!m) { est.textContent = '\u2014'; return; }
            estTimer = setTimeout(() => {
                const params = new URLSearchParams({
                    model_path: m.path, oq_level: selLevel.value,
                    preserve_mtp: (m.has_mtp_heads && cbMtp.checked) ? 'true' : 'false',
                });
                fetchJson(`${API}/admin/api/oq/estimate?${params}`).then(e => {
                    let mem = e.memory_streaming_formatted || '';
                    const sens = st.all.find(x => x.path === selSens.value);
                    if (sens) {   // client-side approximation, same as classic page
                        const bytes = Math.round(sens.size * 1.5) + 5 * 1024 ** 3;
                        mem = bytes > 1024 ** 3
                            ? (bytes / 1024 ** 3).toFixed(1) + ' GB'
                            : Math.round(bytes / 1024 ** 2) + ' MB';
                    }
                    est.textContent = `est: ${e.output_size_formatted || C.fmtBytes(e.output_size_bytes)}` +
                        ` \u00b7 ${e.effective_bpw} bpw \u00b7 stream ${mem}`;
                }).catch(err => { est.textContent = 'estimate: ' + err.message; });
            }, 300);
        }

        function fill(sel, items, label) {
            const keep = sel.value;
            for (const o of [...sel.options].slice(1)) o.remove();
            for (const m of items) {
                const o = document.createElement('option');
                o.value = m.path; o.textContent = label(m);
                sel.append(o);
            }
            sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
        }

        function updateConditional() {
            const m = st.models.find(x => x.path === selModel.value);
            // sensitivity candidates: quantized, same model_type, not the source
            const sens = m ? st.all.filter(x => x.path !== m.path && x.is_quantized &&
                x.model_type === m.model_type) : [];
            fill(selSens, sens, x => `${x.name} (${x.size_formatted})`);
            rowSens.hidden = sens.length === 0;
            // preserve MTP availability
            const hasMtp = !!(m && m.has_mtp_heads);
            cbMtp.disabled = !hasMtp;
            if (!hasMtp) cbMtp.checked = false;
            mtpNa.hidden = hasMtp || !m;
            // MTP donor / gemma4 assistant candidates (mirror the classic filter)
            let comb = [];
            if (m && m.model_type === 'gemma4') {
                comb = st.all.filter(x => x.model_type === 'gemma4_assistant');
                rowCombine.querySelector('span').textContent = 'Combine assistant model as MTP head';
                rowCombine.querySelector('small').textContent =
                    'Merge a separate gemma4_assistant checkpoint into the output as a Lightning MTP head.';
            } else if (m && oqMtpFamily(m.model_type) && !(hasMtp && cbMtp.checked)) {
                comb = st.all.filter(x => x.path !== m.path && x.has_mtp_heads &&
                    oqMtpFamily(x.model_type) === oqMtpFamily(m.model_type) &&
                    (!x.hidden_size || !m.hidden_size || x.hidden_size === m.hidden_size));
                rowCombine.querySelector('span').textContent = 'Combine other model\u2019s MTP head';
                rowCombine.querySelector('small').textContent =
                    'Graft the MTP head from a same-architecture donor checkpoint (e.g. the base model of a fine-tune).';
            }
            fill(selCombine, comb, x => `${x.name} (${x.size_formatted})`);
            rowCombine.hidden = comb.length === 0;
            // VLM text-only warning
            vlmWarn.hidden = !(m && m.is_vlm && cbText.checked);
            refreshEst();
        }

        fetchJson(`${API}/admin/api/oq/models`).then(d => {
            st.all = d.all_models || d.models || [];
            st.models = st.all.filter(m => !m.is_quantized);
            fill(selModel, st.models,
                m => `${m.source_repo_id || m.name} (${m.size_formatted})`);
            $('qz-sub').textContent = `${st.models.length} quantizable models`;
            refreshLevelLabels();
            updateConditional();
        }).catch(e => emptyMsg(host, e.message));

        selModel.onchange = updateConditional;
        selSens.onchange = refreshEst;
        selLevel.onchange = refreshEst;
        cbMtp.onchange = () => { updateConditional(); };
        cbText.onchange = updateConditional;
        cbEnh.onchange = () => {
            rowEnhOnly.hidden = !cbEnh.checked;
            refreshLevelLabels();     // labels gain the 'e' suffix, like the classic page
            refreshEst();
        };

        start.onclick = () => {
            const m = st.models.find(x => x.path === selModel.value);
            if (!m) { toast('Select a model'); return; }
            const donor = st.all.find(x => x.path === selCombine.value);
            start.disabled = true;
            const payload = {
                model_path: m.path,
                oq_level: parseFloat(selLevel.value),
                group_size: 64,
                sensitivity_model_path: selSens.value || '',
                text_only: cbText.checked,
                dtype: dtype.v,
                preserve_mtp: m.has_mtp_heads ? cbMtp.checked : false,
                mtp_assistant_model_path: donor ? donor.path : '',
            };
            if (cbEnh.checked) {
                payload.enhanced = true;
                payload.imatrix_reuse_cache = cbReuse.checked;
                payload.imatrix_cache_path = inpCache.value.trim();
                payload.imatrix_strict = cbStrict.checked;
            }
            postJson(`${API}/admin/api/oq/start`, payload).then(() => {
                toast('quantize queued (shadow): ' + m.name);
                renderTasks('qz-tasks', 'oq');
            }).catch(e => toast('quantize: ' + e.message))
              .finally(() => { start.disabled = false; });
        };
    }
    renderTasks('qz-tasks', 'oq');
}


/* ---- oQ uploader: faithful port. Token -> validate-token (shadow:
   never forwarded, so a real token is never leaked to the real server's
   response path; username/orgs are simulated), model list comes from
   upload/oq-models, upload opens the same modal fields as the classic
   page (repo name prefilled namespace/name, README source, re-download
   notice only when no README source, private). -- */
function renderUploader() {
    const host = $('up-form');
    if (host.dataset.built) { renderTasks('up-tasks', 'upload'); return; }
    host.dataset.built = '1';
    host.innerHTML = '';
    const st = { validated: false, ns: '', models: [] };
    const g = document.createElement('div');
    g.className = 'qz-form';
    host.append(g);
    const tokWrap = document.createElement('div');
    tokWrap.className = 'qz-inline';
    const tok = document.createElement('input');
    tok.type = 'password'; tok.placeholder = 'Enter HF write token (hf_...)';
    const vbtn = document.createElement('button');
    vbtn.className = 'se-btn'; vbtn.textContent = 'Validate';
    const vmsg = document.createElement('span');
    vmsg.className = 'stat-sub';
    tokWrap.append(tok, vbtn, vmsg);
    qzField(g, 'HuggingFace Token', tokWrap);
    const list = document.createElement('div');
    list.className = 'admin-table';
    const listT = document.createElement('div');
    listT.className = 'se-hint'; listT.textContent = 'oQ Models';
    host.append(listT, list);
    const tasksT = document.createElement('h3');
    tasksT.textContent = 'Upload Queue'; tasksT.style.margin = '16px 0 6px';

    function loadModels() {
        fetchJson(`${API}/admin/api/upload/oq-models`).then(d => {
            st.models = d.oq_models || [];
            $('up-sub').textContent = `${st.models.length} oQ models`;
            list.innerHTML = '';
            if (!st.models.length) { list.innerHTML = '<div class="empty">No oQ models found in model directories.</div>'; return; }
            for (const m of st.models) {
                const row = document.createElement('div'); row.className = 'urow usage';
                const name = cell(m.name); name.className = 'uname';
                row.append(name, cell(m.size_formatted || C.fmtBytes(m.size || 0)));
                const act = document.createElement('span'); act.className = 'rowacts';
                const b = document.createElement('button');
                b.className = 'se-btn act'; b.textContent = 'upload';
                b.disabled = !st.validated;
                b.onclick = () => uploadModal(m);
                act.append(b); row.append(act);
                list.append(row);
            }
            vbtn.disabledMsg = null;
        }).catch(e => emptyMsg(list, e.message));
    }

    vbtn.onclick = () => {
        if (!tok.value.trim()) { vmsg.textContent = 'Invalid token. Ensure it has write access.'; return; }
        vbtn.disabled = true; vmsg.textContent = 'Validating...';
        postJson(`${API}/admin/api/upload/validate-token`, { hf_token: tok.value.trim() })
            .then(d => {
                st.validated = true; st.ns = d.username || 'you';
                vmsg.textContent = 'Authenticated as ' + st.ns;
                tok.value = tok.value;   // stays in the browser only
                loadModels();
            })
            .catch(e => { st.validated = false; vmsg.textContent = e.message; })
            .finally(() => { vbtn.disabled = false; });
    };
    tok.addEventListener('keydown', e => { if (e.key === 'Enter') vbtn.onclick(); });

    function uploadModal(m) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const box = document.createElement('div');
        box.className = 'modal nasa';
        const h = document.createElement('h3'); h.textContent = 'Upload to HuggingFace';
        const repo = document.createElement('input');
        repo.type = 'text'; repo.value = st.ns + '/' + m.name;
        const readme = qzSelect('Auto-generate basic README');
        const rdSel = document.createElement('div');
        rdSel.append(readme);   // only auto-README is meaningful in the sandbox
        const cbRe = document.createElement('input'); cbRe.type = 'checkbox';
        const cbPr = document.createElement('input'); cbPr.type = 'checkbox';
        const bCancel = document.createElement('button'); bCancel.textContent = 'Cancel';
        const bGo = document.createElement('button'); bGo.className = 'danger'; bGo.textContent = 'Upload';
        bCancel.onclick = () => overlay.remove();
        bGo.onclick = () => {
            if (!repo.value.trim()) { toast('Repository name required'); return; }
            bGo.disabled = true;
            postJson(`${API}/admin/api/upload/start`, {
                model_path: m.path, repo_id: repo.value.trim(), hf_token: tok.value.trim(),
                readme_source_path: '', auto_readme: true,
                redownload_notice: cbRe.checked, private: cbPr.checked,
            }).then(() => {
                toast('upload queued (shadow): ' + repo.value.trim());
                overlay.remove();
                renderTasks('up-tasks', 'upload');
            }).catch(e => toast('upload: ' + e.message))
              .finally(() => { bGo.disabled = false; });
        };
        const bar = document.createElement('div');
        bar.className = 'row buttons';
        bar.append(document.createElement('span'), bCancel, bGo);
        qzField(box, 'Repository Name', repo);
        qzField(box, 'README Source', rdSel);
        qzField(box, 'Show re-download notice', cbRe,
            'Add a notice at the top of README asking previous users to re-download');
        qzField(box, 'Private Repository', cbPr);
        box.append(h, bar);
        overlay.append(box);
        overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
        document.body.append(overlay);
    }

    vmsg.textContent = 'Enter a token to list uploadable oQ models.';
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
    $('ms-sub').textContent = `${idx.stored} stored · ${idx.orphans.length} missing`;
    const host = $('ms-body'); host.innerHTML = '';
    const rows = (idx.entries || []).filter(e => !f || e.id.toLowerCase().includes(f));
    for (const e of rows) {
        const row = document.createElement('div'); row.className = 'urow usage';
        const name = cell(e.id); name.className = 'uname';
        const st = cell(orphan.has(e.id) ? 'MISSING' : (known.has(e.id) ? 'PRESENT' : 'EXTERNAL'));
        if (orphan.has(e.id)) st.className = 'spill miss';   // caution amber
        else if (!known.has(e.id)) st.className = 'dim';
        row.append(name, cell(e.alias || ''), st);
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




/* ---------------- models sub-page: helper models -------- */
async function renderHelperModels() {
    let models;
    try { models = (await fetchJson(`${API}/admin/api/models`)).models; }
    catch (e) { emptyMsg($('hm-list'), e.message); return; }
    const mk = models.filter(m => m.engine_type === 'markitdown' || m.model_type === 'markitdown');
    const helpers = models.filter(m => !mk.includes(m) && (m.is_helper ||
        /dflash|assistant/i.test(m.id)));
    $('hm-sub').textContent = `${helpers.length} helpers · ${mk.length} markitdown`;

    // Integrations, same fields / labels / conditionals as the classic
    // Settings -> Integrations tab. MarkItDown gets the special box at the
    // top (separate role gets separate space), then Web Search, then the
    // helper model list.
    const box = $('hm-markitdown');
    box.textContent = '';
    let integ = {};
    let modelList = [];
    try {
        integ = (await fetchJson(`${API}/admin/api/global-settings`)).integrations || {};
    } catch (_) {}
    modelList = models;

    // save exactly like classic saveIntegrationSettings(): flat body of
    // integrations_* keys POSTed to global-settings
    async function saveIntegration(overrides) {
        Object.assign(integ, overrides || {});
        const body = {};
        for (const [k, v] of Object.entries(integ)) body['integrations_' + k] = v;
        try {
            await fetch(`${API}/admin/api/global-settings`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            toast('Integration settings saved');
            return true;
        } catch (err) { toast('save failed: ' + err.message); return false; }
    }
    function integField(label, hint, control) {
        const f = document.createElement('label');
        f.className = 'field';
        const lab = document.createElement('span');
        lab.textContent = label;
        f.append(lab, control);
        if (hint) {
            const h = document.createElement('small');
            h.className = 'fhint dim'; h.textContent = hint;
            f.append(h);
        }
        return f;
    }
    function integSelect(opts, val, onchange) {
        const sel = document.createElement('select');
        for (const [v, t] of opts) {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            sel.append(o);
        }
        sel.value = val;
        sel.onchange = () => onchange(sel.value);
        return sel;
    }
    function integNumber(key, min, max) {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = min; inp.max = max;
        inp.value = integ[key] ?? '';
        inp.onchange = async () => {
            const v = Number(inp.value);
            if (await saveIntegration({ [key]: v })) renderHelperModels();
        };
        return inp;
    }

    /* ---- MarkItDown box ---- */
    const mkCard = document.createElement('div');
    mkCard.className = 'mk-box';
    const head = document.createElement('div');
    head.className = 'mk-head';
    const title = document.createElement('div');
    title.className = 'mk-title';
    title.textContent = 'MarkItDown';
    head.append(title);
    for (const m of mk) {
        const state = document.createElement('span');
        state.className = 'spill ' + (m.loaded ? 'on' : 'off');
        state.textContent = m.loaded ? 'LOADED' : 'IDLE';
        head.append(state);
    }
    mkCard.append(head);
    const mkGrid = document.createElement('div');
    mkGrid.className = 'mk-fields';

    const enabledInp = document.createElement('input');
    enabledInp.type = 'checkbox';
    enabledInp.checked = !!integ.markitdown_enabled;
    enabledInp.onchange = async () => {
        if (await saveIntegration({ markitdown_enabled: enabledInp.checked })) renderHelperModels();
    };
    mkGrid.append(integField('Enable MarkItDown',
        'Preprocess supported file attachments before LLM requests.', enabledInp));

    const exposeInp = document.createElement('input');
    exposeInp.type = 'checkbox';
    exposeInp.checked = !!integ.markitdown_expose_model;
    exposeInp.disabled = !integ.markitdown_enabled;
    exposeInp.onchange = async () => {
        if (await saveIntegration({ markitdown_expose_model: exposeInp.checked })) renderHelperModels();
    };
    mkGrid.append(integField('Show as model',
        'Expose MarkItDown in model lists for direct Markdown conversion requests.', exposeInp));

    mkGrid.append(integField('Max file size (MB)',
        'Reject larger document attachments before conversion.',
        integNumber('markitdown_max_file_size_mb', 1, 1024)));
    mkGrid.append(integField('Max files per request',
        'Limit document attachments converted in one request.',
        integNumber('markitdown_max_files_per_request', 1, 50)));

    // pdf engine: MarkItDown + OCR-capable models (classic: config_model_type contains 'ocr')
    const pdfOpts = [['markitdown', 'MarkItDown']];
    for (const m of modelList)
        if (String(m.config_model_type || '').toLowerCase().includes('ocr'))
            pdfOpts.push([m.id, m.id]);
    const pdfSel = integSelect(pdfOpts, integ.markitdown_pdf_processing_engine || 'markitdown',
        async v => { if (await saveIntegration({ markitdown_pdf_processing_engine: v })) renderHelperModels(); });
    const pdfField = integField('PDF processing engine',
        'Process PDF requests by MarkItDown itself or by an OCR engine.', pdfSel);
    if (integ.markitdown_pdf_processing_engine === 'markitdown') {
        const warn = document.createElement('small');
        warn.className = 'fhint warn';
        warn.textContent = 'Scanned or image-only PDFs will fail when MarkItDown is selected, '
            + 'and PDFs with tables may not be processed correctly.';
        pdfField.append(warn);
    }
    mkGrid.append(pdfField);
    mkCard.append(mkGrid);
    box.append(mkCard);

    /* ---- Web Search ---- */
    const wsCard = document.createElement('div');
    wsCard.className = 'mk-box';
    const wsHead = document.createElement('div');
    wsHead.className = 'mk-head';
    const wsTitle = document.createElement('div');
    wsTitle.className = 'mk-title';
    wsTitle.textContent = 'Web Search';
    wsHead.append(wsTitle);
    const wsGrid = document.createElement('div');
    wsGrid.className = 'mk-fields';

    const provSel = integSelect([
        ['ddgs', 'DDGS Total'], ['ddgs_custom', 'DDGS Custom'],
        ['duckduckgo', 'DuckDuckGo'], ['brave', 'Brave Search'],
        ['searxng', 'SearXNG'],
    ], integ.web_search_provider || 'ddgs', async v => {
        if (await saveIntegration({ web_search_provider: v })) renderHelperModels();
    });
    wsGrid.append(integField('Search provider',
        'Backend used by the chat web search tool. DDGS Total queries every available engine and needs no key.',
        provSel));

    if (integ.web_search_provider === 'ddgs_custom') {
        const be = document.createElement('input');
        be.type = 'text';
        be.placeholder = 'e.g. duckduckgo,brave,mojeek';
        be.value = integ.web_search_ddgs_backends || '';
        be.onchange = async () => {
            if (await saveIntegration({ web_search_ddgs_backends: be.value })) renderHelperModels();
        };
        wsGrid.append(integField('Search engines',
            'Comma-separated engines to query. All of these work without an API key.', be));
    }
    if (integ.web_search_provider === 'brave') {
        const key = document.createElement('input');
        key.type = 'password';
        key.placeholder = 'BSA…';
        key.value = integ.web_search_brave_api_key || '';
        key.onchange = async () => {
            if (await saveIntegration({ web_search_brave_api_key: key.value })) renderHelperModels();
        };
        wsGrid.append(integField('Brave API key',
            'Subscription token from the Brave Search API dashboard. Stored locally, never echoed.', key));
    }
    if (integ.web_search_provider === 'searxng') {
        const url = document.createElement('input');
        url.type = 'text';
        url.placeholder = 'http://127.0.0.1:8080';
        url.value = integ.web_search_searxng_url || '';
        url.onchange = async () => {
            if (await saveIntegration({ web_search_searxng_url: url.value })) renderHelperModels();
        };
        wsGrid.append(integField('SearXNG instance URL',
            'Base URL of a SearXNG instance with the JSON output format enabled.', url));
    }

    wsGrid.append(integField('Results per search',
        'How many sources one web_search call returns (1-10).',
        integNumber('web_search_max_results', 1, 10)));

    const modeSel = integSelect([
        ['snippet', 'Snippets only'], ['full', 'Full page content'],
    ], integ.web_search_content_mode || 'snippet', async v => {
        if (await saveIntegration({ web_search_content_mode: v })) renderHelperModels();
    });
    wsGrid.append(integField('Result content',
        'Snippets keep the prompt small. Full page content fetches and inlines each result page.',
        modeSel));

    if (integ.web_search_content_mode === 'full') {
        const tr = document.createElement('input');
        tr.type = 'checkbox';
        tr.checked = !!integ.web_search_content_truncate;
        tr.onchange = async () => {
            if (await saveIntegration({ web_search_content_truncate: tr.checked })) renderHelperModels();
        };
        wsGrid.append(integField('Truncate page content',
            'Cut each fetched page at the limit below. Turning this off can flood the model context.', tr));
        if (integ.web_search_content_truncate) {
            wsGrid.append(integField('Content limit (chars)',
                'Maximum characters kept per fetched page.',
                integNumber('web_search_content_max_chars', 500, 200000)));
        }
    }

    // Test search: classic uses the real API; through the gateway it hits the real backend read-only.
    const testRow = document.createElement('div');
    testRow.className = 'row buttons';
    const testBtn = document.createElement('button');
    testBtn.className = 'se-btn';
    testBtn.textContent = 'Test search';
    const testOut = cell('');
    testOut.className = 'dim';
    testBtn.onclick = async () => {
        testBtn.disabled = true; testBtn.textContent = 'Testing…';
        try {
            const r = await fetchJson(`${API}/admin/api/web-search/test`, { method: 'POST' });
            testOut.textContent = r.ok
                ? `Search OK: ${(r.results || []).length} results`
                : ('Search test failed: ' + ((r.error && r.error.message) || 'unknown'));
        } catch (err) {
            testOut.textContent = 'Search test failed: ' + err.message;
        }
        testBtn.disabled = false; testBtn.textContent = 'Test search';
    };
    testRow.append(testBtn, testOut);
    testRow.className = 'mk-row';
    wsGrid.append(testRow);
    wsCard.append(wsHead, wsGrid);
    box.append(wsCard);

    $('hm-sub').textContent = `${helpers.length} helpers · integrations editable (shadow)`;

    const host = $('hm-list');
    host.textContent = '';
    if (!helpers.length) { host.innerHTML = '<div class="empty">No helper models</div>'; return; }
    for (const m of helpers) {
        const row = document.createElement('div'); row.className = 'urow usage';
        const name = cell(m.id); name.className = 'uname';
        name.title = m.model_path || m.id;
        const kind = /dflash/i.test(m.id) ? 'DFLASH DRAFTER'
            : /assistant/i.test(m.id) ? 'ASSISTANT (MTP)' : 'HELPER';
        const state = document.createElement('span');
        state.className = 'spill ' + (m.loaded ? 'on' : (m.is_loading ? 'load' : 'off'));
        state.textContent = m.is_loading ? 'LOADING' : (m.loaded ? 'LOADED' : 'IDLE');
        row.append(name, cell(m.model_type || ''), cell(kind),
                   cell(m.actual_size_formatted || C.fmtBytes(m.actual_size || m.estimated_size || 0)), state);
        const act = document.createElement('span'); act.className = 'rowacts';
        const b = document.createElement('button');
        b.className = 'se-btn act'; b.textContent = m.loaded ? 'unload' : 'load';
        b.onclick = async () => {
            try { await postModelAction(m.id, m.loaded ? 'unload' : 'load'); renderHelperModels(); }
            catch (err) { toast('load failed: ' + err.message); }
        };
        act.append(b); row.append(act);
        host.append(row);
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
