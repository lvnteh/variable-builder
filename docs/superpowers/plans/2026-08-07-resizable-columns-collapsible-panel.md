# Resizable Columns + Collapsible Preview Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag-resize all 7 table columns (with double-click auto-fit) and collapse the right JSON Preview panel to a thin strip for more editing width.

**Architecture:** Single-file app (`variable-builder.html`, inline CSS + JS). Column widths become container-scoped CSS custom properties (`--w-*`) on `.table-panel` so header and every `.var-row` reflow in sync and survive `innerHTML` re-renders. Drag handles are appended to the static header spans (not the rebuilt rows). Panel collapse toggles a class on `.workspace`. All state is session-only (in-memory JS), reset to defaults on reload and via the existing Reset button.

**Tech Stack:** Vanilla HTML/CSS/JS. No build step. Manual browser verification (repo has no automated browser test for UI). Served by `node server.js` (`npm start`).

**Design reference:** `docs/superpowers/specs/2026-08-07-resizable-columns-collapsible-panel-design.md`

---

## File Structure

Only one file changes: **`variable-builder.html`**. Edits cluster in three regions:

- **CSS** (`~467-473` column classes, `~450-455` workspace grid, `~774-813` preview panel): convert widths to vars, add resizer + collapsed-panel styles.
- **HTML markup** (`~1128-1142` preview panel): add collapse toggle button + vertical re-expand tab.
- **JS** (new block near other view helpers `~2052-2100`, and init `~2621-2654`): `colW` state, `applyColW()`, resizer wiring, auto-fit measurement, panel toggle, Reset integration.

No new files. No new dependencies.

---

## Task 1: Convert column widths to CSS custom properties

Makes widths driven by `.table-panel` vars so JS can update them live and they survive row re-renders. No behavior change yet — visual output must look identical to before.

**Files:**
- Modify: `variable-builder.html:458-464` (`.table-panel` — add var declarations + `overflow-x`)
- Modify: `variable-builder.html:467-473` (`.col-*` — read vars)

- [ ] **Step 1: Add the default width variables and horizontal scroll to `.table-panel`**

Replace the `.table-panel` rule (currently at `458-464`):

```css
.table-panel {
  /* session-resizable column widths — mutated live by JS via --w-* */
  --w-type: 72px;
  --w-id: 180px;
  --w-display: 200px;
  --w-default: 150px;
  --w-category: 110px;
  --w-override: 50px;
  --w-actions: 96px;
  overflow-y: auto;
  overflow-x: auto;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 2: Point the column classes at the variables**

Replace the column layout block (currently at `467-473`):

```css
/* Column layout — widths driven by --w-* on .table-panel (see JS colW) */
.col-type      { width: var(--w-type);     flex-shrink: 0; }
.col-id        { width: var(--w-id);       flex-shrink: 0; }
.col-display   { flex: 1 0 var(--w-display); min-width: 40px; }
.col-default   { width: var(--w-default);  flex-shrink: 0; }
.col-category  { width: var(--w-category); flex-shrink: 0; }
.col-override  { width: var(--w-override); flex-shrink: 0; text-align: center; }
.col-actions   { width: var(--w-actions);  flex-shrink: 0; }
```

`.col-display` keeps `flex: 1 0 <basis>` so it still stretches to fill leftover space on wide screens, but its resized width becomes the flex-basis. All other columns are fixed.

- [ ] **Step 3: Verify visually — no regression**

Run: `npm start` then open `http://localhost:3000` (check the port `server.js` logs). Add a few variables of different types.
Expected: table looks identical to before this task (type 72px, id 180px, display fills, etc.), header and rows aligned. Rows still add/edit/delete normally.

- [ ] **Step 4: Commit**

```bash
git add variable-builder.html
git commit -m "refactor: drive column widths via CSS custom properties"
```

---

## Task 2: Add colW state and applyColW(), wired at init

Introduce the session state object and the function that pushes it into the CSS vars. Called once at init so defaults are explicit (and later reused by drag/auto-fit/reset).

**Files:**
- Modify: `variable-builder.html` — add JS block just before `function resetFilters()` (currently `~2052`)
- Modify: `variable-builder.html:2621-2628` (`init()` — call `applyColW()`)

- [ ] **Step 1: Add colW state + applyColW() helper**

Insert immediately before `function resetFilters() {` (`~2052`):

```js
// ─── Column layout (session-only) ──────────────────────────────────────────────
// Widths live as --w-* CSS vars on .table-panel so header + rows reflow in sync
// and survive innerHTML re-renders. Reset to defaults on reload (no persistence).
const DEFAULT_COL_W = { type: 72, id: 180, display: 200, default: 150,
                        category: 110, override: 50, actions: 96 };
const MIN_COL_W = 40;
const MAX_AUTOFIT_W = 480;
let colW = { ...DEFAULT_COL_W };

function applyColW() {
  const p = document.getElementById('table-panel');
  if (!p) return;
  for (const k in colW) p.style.setProperty(`--w-${k}`, colW[k] + 'px');
}
```

- [ ] **Step 2: Call applyColW() at init**

In `init()` (`~2627`), add the call right after `wireViewControls();`:

```js
  loadView();
  wireViewControls();
  applyColW();
```

- [ ] **Step 3: Verify in browser console**

Run: `npm start`, open the app, open DevTools console, run:
```js
document.getElementById('table-panel').style.getPropertyValue('--w-id')
```
Expected: `"180px"`. Table still renders identically.

- [ ] **Step 4: Commit**

```bash
git add variable-builder.html
git commit -m "feat: add session column-width state and applyColW()"
```

---

## Task 3: Add drag-resize handles to header columns

Append a resizer strip to each of the 7 header spans and wire pointer-drag to update `colW`. Resizer must not trigger the column's sort click.

**Files:**
- Modify: `variable-builder.html` — add CSS after the `.table-head > span.sort-*` rules (`~520`)
- Modify: `variable-builder.html` — add JS (`wireColumnResizers`) near `applyColW` (`~2052` block)
- Modify: `variable-builder.html:2628` (`init()` — call `wireColumnResizers()`)

- [ ] **Step 1: Add resizer CSS**

Insert after line `520` (after the `.sort-desc::after` rule, before the "Rows hidden by an active filter" comment at `522`):

```css
/* Column resize handles */
.table-head > span { position: relative; }
.col-resizer {
  position: absolute;
  top: 0;
  right: -1px;
  width: 7px;
  height: 100%;
  cursor: col-resize;
  user-select: none;
  z-index: 11;
  touch-action: none;
}
.col-resizer:hover,
.col-resizer.dragging {
  background: var(--accent);
  opacity: 0.4;
}
```

- [ ] **Step 2: Add wireColumnResizers() + auto-fit stub**

Insert in the column-layout JS block (after `applyColW`, before `resetFilters`). The `autoFitColumn` body is filled in Task 4 — for now it is a no-op placeholder that is replaced, NOT left as a stub in the final plan (see Task 4 Step 1 which supplies the real body):

```js
// Map each header span's data-sort/class to the colW key it controls.
const COL_KEYS = ['type', 'id', 'display', 'default', 'category', 'override', 'actions'];
const COL_CLASS = { type:'col-type', id:'col-id', display:'col-display',
                    default:'col-default', category:'col-category',
                    override:'col-override', actions:'col-actions' };

// Append a drag handle to each header span; dragging mutates colW live.
function wireColumnResizers() {
  const head = document.getElementById('table-head');
  if (!head) return;
  COL_KEYS.forEach(key => {
    const span = head.querySelector('.' + COL_CLASS[key]);
    if (!span || span.querySelector('.col-resizer')) return;
    const handle = document.createElement('span');
    handle.className = 'col-resizer';
    handle.dataset.col = key;

    let startX = 0, startW = 0;
    const onMove = e => {
      colW[key] = Math.max(MIN_COL_W, startW + (e.clientX - startX));
      applyColW();
    };
    const onUp = e => {
      handle.classList.remove('dragging');
      handle.releasePointerCapture?.(e.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();               // don't trigger column sort
      startX = e.clientX;
      startW = colW[key];
      handle.classList.add('dragging');
      handle.setPointerCapture?.(e.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    // A click that bubbles from the handle would sort; swallow it.
    handle.addEventListener('click', e => e.stopPropagation());
    handle.addEventListener('dblclick', e => {
      e.preventDefault();
      e.stopPropagation();
      autoFitColumn(key);
    });
    span.appendChild(handle);
  });
}
```

- [ ] **Step 3: Add a temporary autoFitColumn so init doesn't throw**

Task 4 replaces this. For now, insert immediately after `wireColumnResizers`:

```js
function autoFitColumn(key) {
  // Filled in by Task 4. Temporary fallback: reset that column to default.
  colW[key] = DEFAULT_COL_W[key];
  applyColW();
}
```

- [ ] **Step 4: Call wireColumnResizers() at init**

In `init()`, add after `applyColW();`:

```js
  applyColW();
  wireColumnResizers();
```

- [ ] **Step 5: Verify drag works and doesn't sort**

Run: `npm start`, open app, add variables. Hover the right edge of the `id` header → cursor becomes `col-resize`, handle highlights. Drag right → `id` column (header + all rows) widens together. Drag past panel width → horizontal scrollbar appears, header scrolls with rows.
Click the handle (no drag) → column does NOT re-sort. Click the header label itself → still sorts.
Expected: all 7 columns draggable, alignment preserved, no accidental sort.

- [ ] **Step 6: Commit**

```bash
git add variable-builder.html
git commit -m "feat: drag-resize handles on all table columns"
```

---

## Task 4: Double-click auto-fit (cap 480px)

Replace the temporary `autoFitColumn` with real content measurement: text columns measured via canvas using the row input font; non-text columns fit rendered cell width; clamp to [40, 480].

**Files:**
- Modify: `variable-builder.html` — replace the temporary `autoFitColumn` from Task 3 Step 3

- [ ] **Step 1: Replace autoFitColumn with the measuring implementation**

Replace the entire temporary `autoFitColumn` function with:

```js
// Shared canvas for text measurement (created lazily).
let _measureCtx = null;
function measureCtx() {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
  // Match the row input font: --fs-xs size, --sans family.
  const cs = getComputedStyle(document.body);
  const size = cs.getPropertyValue('--fs-xs').trim() || '12px';
  const fam = cs.getPropertyValue('--sans').trim() || 'sans-serif';
  _measureCtx.font = `400 ${size} ${fam}`;
  return _measureCtx;
}

// Which text field each column reads, for value measurement.
const COL_FIELD = { id: 'f-id', display: 'f-display',
                    default: 'f-default', category: 'f-category' };

function autoFitColumn(key) {
  let want = DEFAULT_COL_W[key];
  const rows = document.querySelectorAll('#rows-container .var-row:not(.filtered-out)');

  if (COL_FIELD[key]) {
    const ctx = measureCtx();
    let max = 0;
    rows.forEach(r => {
      const input = r.querySelector('.' + COL_FIELD[key]);
      if (input) max = Math.max(max, ctx.measureText(input.value || '').width);
    });
    // Also fit the header label text.
    const label = document.querySelector('#table-head .' + COL_CLASS[key]);
    if (label) max = Math.max(max, ctx.measureText(label.textContent.trim()).width);
    // input padding (0.375rem*2 ≈ 12px) + borders + cell padding-right (~8px) + handle.
    if (max > 0) want = Math.ceil(max) + 34;
  } else {
    // Non-text columns (type badge, override checkbox, actions): fit rendered content.
    let max = 0;
    rows.forEach(r => {
      const cell = r.querySelector('.' + COL_CLASS[key]);
      if (cell) max = Math.max(max, cell.scrollWidth);
    });
    if (max > 0) want = Math.ceil(max) + 8;
  }

  colW[key] = Math.max(MIN_COL_W, Math.min(MAX_AUTOFIT_W, want));
  applyColW();
}
```

- [ ] **Step 2: Verify auto-fit on a long value**

Run: `npm start`, open app. Add a string variable and set its `id` to a long value like `promotional_banner_secondary_cta_label_override`. Double-click the `id` column handle.
Expected: `id` column grows to fit the value (no clipping), but not beyond 480px. Double-click with an empty table (delete all rows first) → column returns to its default width (no crash).

- [ ] **Step 3: Verify auto-fit ignores filtered-out rows**

Add several variables, use a search/filter that hides some, double-click a handle.
Expected: width fits only the visible rows' values.

- [ ] **Step 4: Commit**

```bash
git add variable-builder.html
git commit -m "feat: double-click column handle auto-fits to content (max 480px)"
```

---

## Task 5: Collapsible preview panel (thin strip)

Add a collapse toggle to the preview header and a vertical re-expand tab; toggling adds/removes `.preview-collapsed` on `.workspace`, shrinking the grid's right column to 32px.

**Files:**
- Modify: `variable-builder.html:450-455` (`.workspace` — collapsed variant)
- Modify: `variable-builder.html:774-798` (`.preview-panel` / `.preview-header` — collapsed rules + tab)
- Modify: `variable-builder.html:1128-1142` (preview panel markup — toggle button + tab)
- Modify: `variable-builder.html` — add `togglePreview()` JS + `previewCollapsed` state in the column-layout block
- Modify: `variable-builder.html:2628` (`init()` — wire the toggle/tab buttons)

- [ ] **Step 1: Add collapsed grid + panel CSS**

After the `.workspace` rule (`455`), add:

```css
.workspace.preview-collapsed { grid-template-columns: 1fr 34px; }
```

After the `.preview-panel` rule (`779`), add:

```css
.preview-panel { position: relative; }

/* Collapse toggle in the header (visible when expanded) */
.preview-collapse-btn {
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: var(--radius);
}
.preview-collapse-btn:hover { color: var(--accent); background: var(--accent-bg); }

/* Vertical re-expand tab (visible only when collapsed) */
.preview-expand-tab {
  display: none;
  position: absolute;
  inset: 0;
  align-items: center;
  justify-content: center;
  gap: 6px;
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  font-family: var(--sans);
  font-size: var(--fs-xs);
  font-weight: var(--fw-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
  background: transparent;
  border: none;
  cursor: pointer;
}
.preview-expand-tab:hover { color: var(--accent); background: var(--accent-bg); }

/* Collapsed state: hide contents, show the tab */
.workspace.preview-collapsed .preview-header,
.workspace.preview-collapsed .preview-body,
.workspace.preview-collapsed .preview-footer { display: none; }
.workspace.preview-collapsed .preview-expand-tab { display: flex; }
```

- [ ] **Step 2: Add the toggle button and expand tab to the markup**

Replace the preview panel block (`1128-1142`):

```html
  <!-- JSON PREVIEW -->
  <div class="preview-panel">
    <div class="preview-header">
      <span class="preview-title">JSON Preview</span>
      <div style="display:flex;align-items:center;gap:4px;">
        <button class="btn-tiny" id="copy-btn" onclick="copyJson()">⎘ Copy</button>
        <button class="preview-collapse-btn" id="preview-collapse" title="Collapse panel">›</button>
      </div>
    </div>
    <div class="preview-body">
      <pre id="json-output"><span style="color:var(--muted)">// empty</span></pre>
    </div>
    <div class="preview-footer">
      <span class="stat"><strong id="s-total">0</strong> variables</span>
      <span class="stat"><strong id="s-ovrd">0</strong> editable</span>
      <span class="stat"><strong id="s-cat">0</strong> with category</span>
      <span class="stat dup-badge" id="dup-badge" style="display:none"></span>
    </div>
    <button class="preview-expand-tab" id="preview-expand" title="Expand JSON Preview">‹ JSON Preview</button>
  </div>
```

- [ ] **Step 2b: Verify the app still loads before wiring JS**

Run: `npm start`, open the app.
Expected: preview panel looks unchanged except a new `›` button next to Copy. No console errors.

- [ ] **Step 3: Add previewCollapsed state + togglePreview()**

In the column-layout JS block (near `applyColW`), add:

```js
let previewCollapsed = false;
function setPreviewCollapsed(collapsed) {
  previewCollapsed = collapsed;
  const ws = document.querySelector('.workspace');
  if (ws) ws.classList.toggle('preview-collapsed', collapsed);
}
function togglePreview() { setPreviewCollapsed(!previewCollapsed); }
```

- [ ] **Step 4: Wire the buttons at init**

In `init()`, after `wireColumnResizers();`, add:

```js
  wireColumnResizers();
  document.getElementById('preview-collapse')?.addEventListener('click', () => setPreviewCollapsed(true));
  document.getElementById('preview-expand')?.addEventListener('click', () => setPreviewCollapsed(false));
```

- [ ] **Step 5: Verify collapse/expand**

Run: `npm start`, open app. Click the `›` button in the preview header.
Expected: right panel shrinks to a ~34px strip showing a vertical "‹ JSON Preview" label; the table widens to fill the freed space. Click the vertical tab → panel re-expands with JSON + footer intact. Toggle several times.

- [ ] **Step 6: Commit**

```bash
git add variable-builder.html
git commit -m "feat: collapse JSON preview panel to a thin strip"
```

---

## Task 6: Wire layout reset into resetFilters()

Make the existing Reset button also restore default column widths and re-expand the panel, so it is the single "put everything back" control.

**Files:**
- Modify: `variable-builder.html:2052-2061` (`resetFilters()`)
- Modify: `variable-builder.html:1090` (Reset button `title`)

- [ ] **Step 1: Extend resetFilters()**

Add layout restoration at the end of `resetFilters()` (after `applyView();` at `2060`, inside the function before its closing brace):

```js
function resetFilters() {
  view.sortKey = 'created'; view.sortDir = 'desc';
  view.search = ''; view.types = []; view.category = '';
  view.editableOnly = false; view.dupesOnly = false;
  const s = document.getElementById('f-search'); if (s) s.value = '';
  const c = document.getElementById('f-category'); if (c) c.value = '';
  saveView();
  refreshCategoryOptions();
  applyView();
  // Layout: restore default column widths and re-expand the preview panel.
  colW = { ...DEFAULT_COL_W };
  applyColW();
  setPreviewCollapsed(false);
}
```

- [ ] **Step 2: Update the Reset button tooltip**

Replace line `1090`:

```html
  <button class="btn-ghost" id="filter-reset" title="Clear filters, sorting &amp; column layout">Reset</button>
```

- [ ] **Step 3: Verify Reset restores layout**

Run: `npm start`, open app. Resize a couple of columns, collapse the preview panel, apply a filter/sort. Click **Reset**.
Expected: filters/sort clear (existing behavior), column widths snap back to defaults, and the preview panel re-expands — all at once.

- [ ] **Step 4: Commit**

```bash
git add variable-builder.html
git commit -m "feat: Reset button also restores column widths and expands preview"
```

---

## Task 7: Full manual verification pass

Confirm the whole feature against the spec's test checklist, including re-render persistence and session-only reset.

**Files:** none (verification only)

- [ ] **Step 1: Run the full checklist**

Run: `npm start`, open the app, open a variable set with several variables.

Verify each:
1. Drag each of the 7 handles → header + rows resize together, stay aligned.
2. Grow columns past panel width → horizontal scrollbar; header scrolls with rows.
3. Double-click a text-column handle with long values → fits content, capped 480px; empty table → falls back to default, no crash.
4. Double-click and single-click-drag never trigger sort; clicking the label still sorts.
5. Collapse preview → thin strip + vertical tab; table widens. Expand → restored.
6. Reset → widths default + panel expanded, alongside filter/sort reset.
7. Add / edit / delete rows after resizing → widths persist through re-render (this is the key regression check: `renderAll` rebuilds `#rows-container` but widths live on `.table-panel`).
8. Reload page → everything returns to defaults (session-only confirmed).

- [ ] **Step 2: Run existing tests to confirm no breakage**

Run: `npm run smoke && npm run test:unit`
Expected: pass (these cover the store/server, unaffected by UI changes — confirms nothing structural broke).

- [ ] **Step 3: Final commit (only if any fixes were needed)**

```bash
git add variable-builder.html
git commit -m "fix: address issues found in manual verification"
```

If no issues found, no commit needed — the feature is complete.

---

## Self-Review notes

- **Spec coverage:** Task 1 (CSS vars) + Task 3 (drag) = resizable all-7-columns; Task 4 = auto-fit cap 480; Task 5 = thin-strip collapse + vertical tab; Task 6 = Reset integration; session-only persistence = no localStorage touched anywhere; Task 7 = spec's test checklist. All spec sections covered.
- **Type/name consistency:** `colW`, `DEFAULT_COL_W`, `MIN_COL_W`, `MAX_AUTOFIT_W`, `applyColW`, `wireColumnResizers`, `autoFitColumn`, `COL_KEYS`, `COL_CLASS`, `COL_FIELD`, `previewCollapsed`, `setPreviewCollapsed`, `togglePreview` are used consistently across tasks. `autoFitColumn` is intentionally introduced as a temporary body in Task 3 Step 3 and fully replaced in Task 4 Step 1 (called out explicitly so out-of-order readers aren't confused).
- **No placeholders:** every code step shows complete code; the only intentional temporary (Task 3 `autoFitColumn`) is labeled and superseded.
- **Port note:** `server.js` logs its listening port; the plan says to check the log rather than hard-coding, since Railway/local may differ.
