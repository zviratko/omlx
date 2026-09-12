/* Uplift UI controller. Read-only: polls admin APIs, animates, never writes config. */
(function () {
'use strict';
const C = window.UpliftCore;
const $ = id => document.getElementById(id);

/* API base: same origin when hosted by omlx itself, else the local server
   (page is served by the helper on :11436 during testing; override with ?api=). */
const API = new URLSearchParams(location.search).get('api') ||
    (location.port === '11435' || location.port === '' ? '' : 'http://127.0.0.1:11435');

const prefs = C.loadPrefs(localStorage);
let stats = null, prevStats = null, history = [], failCount = 0, timer = null, usageTimer = null;

/* ---------------- theme & motion ---------------- */
function applyPrefs() {
    const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' &&
        matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const motionOff = prefs.motion === 'off' ||
        matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.dataset.motion = motionOff ? 'off' : 'auto';
    $('btn-motion').style.opacity = motionOff ? 0.4 : 1;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);
applyPrefs();
$('btn-theme').onclick = () => {
    prefs.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    C.savePrefs(localStorage, prefs); applyPrefs();
};
$('btn-motion').onclick = () => {
    prefs.motion = document.documentElement.dataset.motion === 'off' ? 'auto' : 'off';
    C.savePrefs(localStorage, prefs); applyPrefs();
};

/* ---------------- animated counters ---------------- */
const motionOff = () => document.documentElement.dataset.motion === 'off';
const counters = {};
function counter(elId, opts) {
    const el = $(elId);
    counters[elId] = { el, opts: opts || {}, value: null, raf: 0 };
}
function setCounter(elId, target) {
    const c = counters[elId];
    if (!c || target === null) { c && (c.el.textContent = '—'); return; }
    if (c.value === null || motionOff()) { c.value = target; renderCounter(c, target); return; }
    if (c.value === target) return;
    cancelAnimationFrame(c.raf);
    const from = c.value, start = performance.now(), dur = 600;
    const step = now => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - (1 - t) ** 3;               // easeOutCubic
        const v = from + (target - from) * eased;
        c.el.textContent = c.opts.format(v);
        if (t < 1) c.raf = requestAnimationFrame(step);
        else c.value = target;
    };
    c.value = target;
    c.raf = requestAnimationFrame(step);
}
function renderCounter(c, v) { c.el.textContent = c.opts.format(v); }

counter('v-gentps',    { format: v => v.toFixed(1) });
counter('v-prefilltps',{ format: v => v.toFixed(0) });
counter('v-requests',  { format: v => C.fmtNumber(v) });
counter('v-tokens',    { format: v => C.fmtCompact(v) });
counter('v-cacheeff',  { format: v => v.toFixed(1) + '%' });
counter('v-active',    { format: v => C.fmtNumber(v) });
counter('v-waiting',   { format: v => C.fmtNumber(v) });
counter('v-hotcache',  { format: v => C.fmtBytes(v) });

/* ---------------- charts ---------------- */
const gridColor = () => getComputedStyle(document.documentElement).getPropertyValue('--border') || 'rgba(148,163,184,.15)';
// uPlot 1.6.32: axis font must be a plain CSS font string (font-as-function throws).
const axisFont = '10px ui-monospace, SFMono-Regular, Menlo, monospace';

const tpsData = [[], [], []];   // time, gen, prefill
const memData = [[], []];       // time, percent

function baseOpts(yLabel, series) {
    return {
        width: 0, height: 240, padding: [6, 8, 0, 0],
        cursor: { drag: { x: false, y: false } },
        // Legend on top of the plot: the bottom row is reserved for x-axis labels.
        // live:false => static labels (values shown on hover; the stat cards already show live values).
        legend: { show: true, top: true, live: false, labels: { fontSize: '10px' } },
        scales: { x: { time: true }, y: { auto: true } },
        axes: [
            { stroke: '#8b94a7', width: 1, size: 42, font: axisFont,
              values: (s, t) => t.map(ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })) },
            { stroke: '#8b94a7', size: 40, font: axisFont, grid: true, label: yLabel },
        ],
        series: [{}, ...series],
    };
}
const line = (label, color, fill) => ({
    label, stroke: color, width: 2,
    fill: fill ? `${color}22` : undefined,
    points: { show: false },
});

const tpsChart = new uPlot(baseOpts('tok/s', [
    line('generation', '#22d3ee', true),
    line('prefill', '#a78bfa', false),
]), tpsData, $('chart-tps'));

const memOpts = baseOpts('memory %', [line('used', '#34d399', true)]);
memOpts.scales.y = { range: [0, 100] };
const memChart = new uPlot(memOpts, memData, $('chart-mem'));

function resizeCharts() {
    const w1 = $('chart-tps').clientWidth, w2 = $('chart-mem').clientWidth;
    if (w1 > 0) tpsChart.setSize({ width: w1, height: 240 });
    if (w2 > 0) memChart.setSize({ width: w2, height: 240 });
}
new ResizeObserver(resizeCharts).observe($('grid'));
requestAnimationFrame(resizeCharts);

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
function flashCard(elId, tone) {
    const el = $(elId); if (!el || motionOff()) return;
    const card = el.closest('.card'); if (!card) return;
    card.classList.add(`flash-${tone}`);
    setTimeout(() => card.classList.remove(`flash-${tone}`), 1200);
}
function celebrate(text) {
    toast(`🎉 ${text}`);
    if (motionOff() || typeof confetti !== 'function') return;
    confetti({ particleCount: 90, spread: 70, origin: { y: 0.7 },
               colors: ['#22d3ee', '#a78bfa', '#34d399', '#fbbf24'] });
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
    setCounter('v-active', s.active);
    setCounter('v-waiting', s.waiting);
    setCounter('v-hotcache', s.cacheBytes);

    $('v-tokens-sub').textContent = s.cachedTokens !== null
        ? `${C.fmtCompact(s.completionTokens)} generated` : '\u00a0';
    $('chip-uptime').textContent = `up ${C.fmtDuration(s.uptime)}`;

    const dot = $('status-dot');
    dot.classList.toggle('bad', s.pressure === 'hard');

    const mem = $('meter-cache');
    mem.classList.toggle('warn', s.memPercent !== null && s.memPercent >= 70);
    mem.classList.toggle('bad', s.memPercent !== null && s.memPercent >= 90);
    $('cache-sub').textContent = s.memUsed !== null
        ? `models ${C.fmtBytes(s.memUsed)} / ${C.fmtBytes(s.memMax)} · cache ${C.fmtBytes(s.cacheBytes)}${s.cachePercent !== null ? ' (' + s.cachePercent.toFixed(0) + '%)' : ''}`
        : '';
    $('mem-label').textContent = s.memPercent !== null ? `${s.memPercent.toFixed(1)}% ${s.pressure || ''}` : '';

    // Models
    const list = $('model-list');
    $('models-count').textContent = s.models.length ? `${s.models.length} loaded` : '';
    if (!s.models.length) {
        if (!list.querySelector('.empty')) list.innerHTML = '<div class="empty">No models loaded</div>';
    } else {
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

    // Charts
    const t = s.time;
    tpsData[0].push(t); tpsData[1].push(s.genTps); tpsData[2].push(s.prefillTps);
    while (tpsData[0].length > 300) { tpsData[0].shift(); tpsData[1].shift(); tpsData[2].shift(); }
    tpsChart.setData(tpsData);
    memData[0].push(t); memData[1].push(s.memPercent === null ? null : +s.memPercent.toFixed(2));
    while (memData[0].length > 300) { memData[0].shift(); memData[1].shift(); }
    memChart.setData(memData);
    const win = tpsData[0].length > 1
        ? `${((tpsData[0].at(-1) - tpsData[0][0]) / 1000).toFixed(0)}s window` : '';
    $('chart-tps-window').textContent = win;
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
        C.appendSample(history, s, 300);
        render(s);
        reactTo(events);
        for (const m of miles) celebrate(`${C.fmtNumber(m.value)} ${m.label}`);
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
    timer = setInterval(pollStats, prefs.intervalMs);
}

/* Usage heat strip: tokens per hour today. */
async function pollUsage() {
    if (document.hidden) return;
    try {
        const u = await fetchJson(`${API}/admin/api/usage?range=today`);
        const hm = u.heatmap || [];
        const today = hm.at(-1);
        const hours = today ? today.tokens : new Array(24).fill(0);
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
    } catch (_) { /* usage tab may be disabled; keep last strip */ }
}

/* Device chip (once). */
fetchJson(`${API}/admin/api/device-info`).then(d => {
    $('chip-device').textContent = `${d.chip_name}${d.chip_variant === 'Max' ? ' Max' : ''} · ${d.memory_gb} GB · ${d.gpu_cores}c`;
    $('chip-device').classList.add('state-ok');
}).catch(() => {});

/* Pause when hidden — no background CPU burn. */
document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    pollStats(); pollUsage(); resizeCharts();
});

restartPolling();
pollUsage();
usageTimer = setInterval(pollUsage, 15000);
})();
