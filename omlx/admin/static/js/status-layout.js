/* Status tab: client-side panel layout (flat grid, local patch v2).
 *
 * The Status tab is one CSS grid with fixed 8px auto-rows. Each card is
 * explicitly placed by this script: grid-column from its width mode,
 * grid-row from a masonry cursor algorithm over N configurable columns.
 * Card order lives in the DOM (drag to reorder); placements are derived,
 * never persisted, so any column count works.
 *
 * Persisted in localStorage (client-side only, no server settings):
 *   omlx-status-layout-v4   { order: [cardId...], widths: {cardId: mode} }
 *   omlx-status-settings-v4 { columns: 1-4, maxWidth: px }
 * Layout v3 (two-column left/right/below zones) is dropped on load: the
 * arrangement resets to the template default once.
 *
 * Dragging uses Pointer Events started from the grip handle; window-level
 * capture listeners survive DOM rearrangement (Safari drops pointer capture
 * when the dragged node is re-inserted).
 */
(() => {
    const LAYOUT_KEY = '***';
    const SETTINGS_KEY = '***';
    const DRAG_THRESHOLD = 4;   // px before a press becomes a drag
    const ROW = 8;              // px per implicit grid row
    const GAP = 32;             // px vertical gap (card margin-bottom, 2rem)
    const DESKTOP_MIN = 1024;   // px viewport width enabling multi-column
    const WIDTH_MODES = ['normal', 'wide', 'full'];
    let wired = false;
    let layout = null;          // {order:[], widths:{}} current state
    let defaultOrder = [];      // template DOM order
    let defaultWidths = {};     // from data-default-span
    let settings = loadSettings();
    let measurePass = 0;
    let placeScheduled = false;

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            const s = raw ? JSON.parse(raw) : null;
            if (s && Number.isInteger(s.columns)) return s;
        } catch (e) { /* fall through to defaults */ }
        return { columns: 2, maxWidth: 1740 };
    }

    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
        catch (e) { /* private mode: settings just won't persist */ }
    }

    function loadLayout() {
        try {
            // v3 encoded a fixed left/right/below zone model that has no
            // faithful flat-grid equivalent: drop it, start from defaults.
            localStorage.removeItem('omlx-sta…t-v3');
            const raw = localStorage.getItem(LAYOUT_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && Array.isArray(parsed.order)) return parsed;
        } catch (e) { /* corrupt save: defaults */ }
        return null;
    }

    function saveLayout() {
        try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); }
        catch (e) { /* private mode: layout just won't persist */ }
    }

    const root = () => document.getElementById('status-layout');

    const cards = () =>
        [...root().querySelectorAll(':scope > .omlx-card')];

    const effectiveColumns = () =>
        window.innerWidth < DESKTOP_MIN
            ? 1
            : Math.max(1, Math.min(4, settings.columns || 2));

    const spanFor = (card) => {
        const cols = effectiveColumns();
        const mode = (layout && layout.widths[card.getAttribute('data-card')])
            || defaultWidths[card.getAttribute('data-card')] || 'normal';
        if (mode === 'full') return cols;
        if (mode === 'wide') return Math.min(2, cols);
        return 1;
    };

    /* Masonry placement: walk cards in DOM order, drop each into the
       shortest column; full-width cards start at the tallest row. Only
       runs on desktop widths; mobile CSS stacks everything in one column. */
    function place() {
        const r = root();
        if (!r) return;
        const cols = effectiveColumns();
        r.style.setProperty('--omlx-cols', String(cols));
        const cursor = new Array(cols).fill(1);
        for (const card of cards()) {
            const span = Math.min(spanFor(card), cols);
            let col;
            if (span >= cols) {
                col = 0;
                const tallest = Math.max(...cursor);
                cursor.fill(tallest);
            } else {
                col = 0;
                for (let i = 1; i <= cols - span; i++) {
                    if (cursor[i] < cursor[col]) col = i;
                }
            }
            const row = Math.max(...cursor.slice(col, col + span));
            const height = card.getBoundingClientRect().height;
            const rows = Math.max(1, Math.ceil((height + GAP) / ROW));
            card.style.gridColumn = `${col + 1} / span ${span}`;
            card.style.gridRow = `${row} / span ${rows}`;
            // Expose the effective span to CSS (narrow-card typography fixes)
            card.dataset.span = span >= cols ? 'full' : String(span);
            for (let i = col; i < col + span; i++) cursor[i] = row + rows;
        }
    }

    /* Card heights depend on assigned column width, and placement depends
       on heights: run placement, let the browser reflow, place again. Two
       passes converge for these cards (width modes change height only via
       text reflow). */
    function placeStable() {
        measurePass = 0;
        const step = () => {
            place();
            measurePass += 1;
            if (measurePass < 2) requestAnimationFrame(step);
        };
        step();
    }

    function schedulePlace() {
        if (placeScheduled) return;
        placeScheduled = true;
        requestAnimationFrame(() => {
            placeScheduled = false;
            place();
        });
    }

    function applyPageWidth() {
        const shell = document.querySelector('.omlx-page-shell');
        if (shell) {
            shell.style.setProperty('--omlx-max-width',
                (settings.maxWidth || 1740) + 'px');
        }
    }

    function serialize() {
        layout = {
            order: cards().map(el => el.getAttribute('data-card')),
            widths: layout ? layout.widths : {},
        };
    }

    function applyOrder(order) {
        const r = root();
        const byId = {};
        cards().forEach(el => { byId[el.getAttribute('data-card')] = el; });
        for (const id of order) {
            const el = byId[id];
            if (el) { r.appendChild(el); delete byId[id]; }
        }
        // Cards added upstream after this arrangement was saved: append in
        // template order instead of vanishing.
        Object.values(byId).forEach(el => r.appendChild(el));
    }

    /* Per-card width button: cycles normal -> wide -> full. window.t is
       defined by base.html before any page script runs; fall back to
       English in case the page is ever rendered without it. */
    const FALLBACK_LABELS = {
        normal: 'Normal width', wide: 'Wide', full: 'Full width',
        click: 'Click to change width',
    };
    function widthLabels() {
        const label = (key) => {
            try {
                const v = typeof window.t === 'function'
                    ? window.t('status.width_' + key) : key;
                return v && !v.startsWith('status.') ? v : FALLBACK_LABELS[key];
            } catch (e) { return FALLBACK_LABELS[key]; }
        };
        return {
            normal: label('normal'), wide: label('wide'),
            full: label('full'), click: label('click'),
        };
    }

    function widthIcon(mode) {
        if (mode === 'full') return 'maximize';
        if (mode === 'wide') return 'move-horizontal';
        return 'minus';
    }

    function refreshWidthButtons() {
        const labels = widthLabels();
        for (const card of cards()) {
            const btn = card.querySelector(':scope > .omlx-width-btn');
            if (!btn) continue;
            const mode = currentMode(card);
            btn.dataset.mode = mode;
            btn.title = `${labels[mode]} — ${labels.click}`;
            // Fixed icon-name template, no user data; rebuilt via DOM API
            // so no HTML ever gets parsed from state.
            btn.textContent = '';
            const icon = document.createElement('i');
            icon.setAttribute('data-lucide', widthIcon(mode));
            icon.className = 'w-3.5 h-3.5';
            btn.appendChild(icon);
        }
        if (window.lucide) lucide.createIcons();
    }

    function currentMode(card) {
        const id = card.getAttribute('data-card');
        return (layout.widths[id] || defaultWidths[id] || 'normal');
    }

    function cycleWidth(card) {
        const id = card.getAttribute('data-card');
        const mode = WIDTH_MODES[
            (WIDTH_MODES.indexOf(currentMode(card)) + 1) % WIDTH_MODES.length];
        layout.widths[id] = mode;
        saveLayout();
        refreshWidthButtons();
        placeStable();
    }

    function injectWidthButtons() {
        for (const card of cards()) {
            if (card.querySelector(':scope > .omlx-width-btn')) continue;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'omlx-width-btn';
            btn.addEventListener('click', () => cycleWidth(card));
            card.appendChild(btn);
        }
        refreshWidthButtons();
    }

    /* Drag to reorder: pointerdown on the grip, cards rearrange live as the
       pointer passes them (dominant-axis hit-test on the hovered card). */
    const autoScroll = (y) => {
        const margin = 60;
        if (y < margin) window.scrollBy(0, -12);
        else if (y > window.innerHeight - margin) window.scrollBy(0, 12);
    };

    const startDrag = (evt, card) => {
        const startX = evt.clientX, startY = evt.clientY;
        const pointerId = evt.pointerId;
        let dragging = false;

        const onMove = (e) => {
            if (e.pointerId !== pointerId) return;
            if (!dragging) {
                const dx = e.clientX - startX, dy = e.clientY - startY;
                if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
                dragging = true;
                card.classList.add('omlx-dragging');
                document.documentElement.classList.add('omlx-drag-active');
            }
            e.preventDefault();

            const x = e.clientX, y = e.clientY;
            card.style.pointerEvents = 'none';
            const under = document.elementFromPoint(x, y);
            card.style.pointerEvents = '';
            // Only reorder when hovering another card; the grid itself is
            // always a valid drop zone and end-of-order means append.
            const target = under ? under.closest('.omlx-card') : null;
            if (target && target !== card) {
                const box = target.getBoundingClientRect();
                const before = Math.abs(x - (box.left + box.width / 2)) * 1.5
                        <= Math.abs(y - (box.top + box.height / 2))
                    ? (y - box.top) / box.height < 0.5
                    : (x - box.left) / box.width < 0.5;
                const current = cards();
                const wouldBeSame = before
                    ? current[current.indexOf(target) - 1] === card
                    : current[current.indexOf(target) + 1] === card ||
                      (current[current.indexOf(target) + 1] === undefined &&
                       current[current.length - 1] === card);
                if (!wouldBeSame) {
                    if (before) root().insertBefore(card, target);
                    else if (target.nextSibling === card) { /* noop */ }
                    else root().insertBefore(card, target.nextSibling);
                    schedulePlace();
                }
            } else if (!target) {
                // Over empty grid space (not over any card): treat as
                // end-of-order. Outside the grid rect, do nothing — the
                // pointer may be over the page header or margins.
                const gridBox = root().getBoundingClientRect();
                const inside = x >= gridBox.left && x <= gridBox.right
                    && y >= gridBox.top && y <= gridBox.bottom;
                const current = cards();
                if (inside && current[current.length - 1] !== card) {
                    root().appendChild(card);
                    schedulePlace();
                }
            }
            autoScroll(y);
        };

        const cleanup = () => {
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointercancel', onUp, true);
            if (!dragging) return;
            dragging = false;
            card.classList.remove('omlx-dragging');
            document.documentElement.classList.remove('omlx-drag-active');
            serialize();
            saveLayout();
            placeStable();
        };

        const onUp = (e) => {
            if (e.pointerId !== pointerId) return;
            cleanup();
        };

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onUp, true);
        evt.preventDefault();
    };

    window.resetStatusLayout = () => {
        try {
            localStorage.removeItem(LAYOUT_KEY);
            localStorage.removeItem(SETTINGS_KEY);
        } catch (e) { /* ignore */ }
        settings = loadSettings();
        layout = { order: [...defaultOrder], widths: { ...defaultWidths } };
        for (const card of cards()) {
            card.style.gridColumn = '';
            card.style.gridRow = '';
        }
        applyOrder(defaultOrder);
        refreshWidthButtons();
        applyPageWidth();
        placeStable();
        window.dispatchEvent(new CustomEvent('omlx-layout-reset'));
    };

    window.applyStatusLayoutSettings = () => {
        settings = loadSettings();
        applyPageWidth();
        placeStable();
    };

    const wire = () => {
        const r = root();
        if (!r || wired) return;
        wired = true;

        defaultOrder = cards().map(el => el.getAttribute('data-card'));
        for (const card of cards()) {
            defaultWidths[card.getAttribute('data-card')] =
                card.dataset.defaultSpan === 'full' ? 'full' : 'normal';
        }
        layout = loadLayout() || { order: [...defaultOrder], widths: {} };
        // Drop saved modes for cards that no longer exist; unknown cards
        // keep their defaults.
        for (const id of Object.keys(layout.widths)) {
            if (!defaultOrder.includes(id)) delete layout.widths[id];
        }
        applyOrder(layout.order);

        r.querySelectorAll('[data-card]').forEach(card => {
            const handle = card.querySelector('.omlx-drag-handle');
            if (!handle) return;
            handle.addEventListener('pointerdown', (e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                startDrag(e, card);
            });
        });

        injectWidthButtons();
        applyPageWidth();
        placeStable();

        // Active-models lists, cache bars etc. change card height at runtime.
        let roTimer = null;
        try {
            const ro = new ResizeObserver(() => {
                if (document.querySelector('.omlx-dragging')) return;
                clearTimeout(roTimer);
                roTimer = setTimeout(placeStable, 300);
            });
            ro.observe(r);
        } catch (e) { /* no ResizeObserver: heights update on next drag */ }

        let resizeTimer = null;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(placeStable, 150);
        });
    };

    if (document.readyState === 'complete') {
        setTimeout(wire, 0);
    } else {
        window.addEventListener('load', () => setTimeout(wire, 50));
    }
})();
