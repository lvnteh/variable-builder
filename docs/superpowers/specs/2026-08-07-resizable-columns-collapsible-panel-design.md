# Resizable columns + collapsible preview panel

**Date:** 2026-08-07
**Status:** Approved design, ready for implementation plan
**File touched:** `variable-builder.html` (single-file app — inline CSS + JS)

## Goal

Give the user more control over the variable table layout:

1. **Resize all columns** by dragging handles, so long variable names / default
   values / categories are readable at a comfortable width.
2. **Double-click a handle to auto-fit** the column to its widest visible value.
3. **Collapse the right JSON Preview panel** to a thin strip to reclaim editing
   width, with a visible toggle to re-expand.

State is **session-only** (in-memory) — resets to defaults on reload. No
localStorage / `viewKey()` involvement.

## Current architecture (context)

- The "table" is **flexbox rows**, not `<table>`. `.table-head` and each
  `.var-row` share column classes so their widths stay aligned:
  `.col-type` (72px), `.col-id` (180px), `.col-display` (flex:1, min 120px),
  `.col-default` (150px), `.col-category` (110px), `.col-override` (50px),
  `.col-actions` (96px). Defined at `variable-builder.html:467-473`.
- Header markup: `variable-builder.html:1100-1108`. Rows built via `innerHTML`
  in `rowHTML()` (`~1589`), re-rendered on every change (`renderAll` ~2293,
  `renderRow` ~1534).
- Layout grid: `.workspace { grid-template-columns: 1fr 340px }`
  (`variable-builder.html:450-455`). Left `.table-panel` (`458`), right
  `.preview-panel` (`774`).
- `.table-panel` currently has `overflow-y: auto` only.
- Reset button: `#filter-reset` (`1090`) → `resetFilters()` (`2052`).

## Design

### 1. Column widths as CSS custom properties

Convert the fixed pixel widths to CSS variables scoped on `.table-panel`, so a
single update reflows both header and all rows and survives `innerHTML`
re-renders (vars live on the container, not the rebuilt rows):

```css
.table-panel {
  --w-type: 72px;  --w-id: 180px;  --w-display: 200px;
  --w-default: 150px; --w-category: 110px; --w-override: 50px; --w-actions: 96px;
}
.col-type     { width: var(--w-type);     flex-shrink: 0; }
.col-id       { width: var(--w-id);       flex-shrink: 0; }
.col-display  { width: var(--w-display);  flex-shrink: 0; }   /* see note */
.col-default  { width: var(--w-default);  flex-shrink: 0; }
.col-category { width: var(--w-category); flex-shrink: 0; }
.col-override { width: var(--w-override); flex-shrink: 0; text-align:center; }
.col-actions  { width: var(--w-actions);  flex-shrink: 0; }
```

**`display_name` note:** today it is `flex:1` (absorbs slack). To make it
independently resizable it becomes a fixed `var(--w-display)` column like the
others. To preserve the "fills remaining space on wide screens" feel, the panel
keeps `overflow-x: auto`; if the summed columns are narrower than the panel, a
trailing flexible spacer (or leaving `.col-display` as `flex:1 0 var(--w-display)`)
absorbs the gap. **Chosen:** `.col-display` uses `flex: 1 0 var(--w-display)` —
its resized width is the flex-basis (minimum), and it still stretches to fill
leftover space when the table is narrower than the panel. All other columns are
fixed. Min width when dragging: 40px.

The in-memory default values are held in a JS object so Reset can restore them:

```js
const DEFAULT_COL_W = { type:72, id:180, display:200, default:150,
                        category:110, override:50, actions:96 };
let colW = { ...DEFAULT_COL_W };   // session-only, mutated by drag/auto-fit
function applyColW() {
  const p = document.getElementById('table-panel');
  for (const k in colW) p.style.setProperty(`--w-${k}`, colW[k] + 'px');
}
```

`.table-panel` gains `overflow-x: auto`. Header is already `position: sticky;
top:0` — it scrolls horizontally with rows because both live in the same
scrolling container.

### 2. Drag handles

Each of the 7 header `<span>`s gets a right-edge grab strip:

```css
.table-head > span { position: relative; }
.col-resizer {
  position: absolute; top: 0; right: 0; width: 6px; height: 100%;
  cursor: col-resize; user-select: none; z-index: 11;
}
.col-resizer:hover, .col-resizer.dragging { background: var(--accent); opacity:.5; }
```

A resizer element is appended to each header span at init (keyed by column name
via `data-col`). The sortable click handler must **not** fire when interacting
with the resizer — stop propagation on the resizer's mousedown/click.

Drag logic (pointer events for robustness):
- `pointerdown` on resizer → record `startX`, `startW = colW[col]`, set capture.
- `pointermove` → `colW[col] = max(40, startW + (e.clientX - startX))`;
  `applyColW()`.
- `pointerup` → release capture, clear dragging class.

### 3. Double-click auto-fit (cap 480px)

Double-click a resizer → size that column to its widest visible value:

- **Text columns** (`id`, `display`, `default`, `category`): measure each
  visible (`:not(.filtered-out)`) row's value string with a shared
  `CanvasRenderingContext2D` using the row input font
  (`var(--fs-xs)` / `var(--sans)`), take the max, add padding (~24px for input
  padding + borders), also measure the header label text.
- **Non-text columns** (`type` badge, `override` checkbox, `actions` buttons):
  fit to their natural rendered width — measure the widest rendered cell via
  `scrollWidth`, or fall back to the default width.
- Clamp result to `[40px, 480px]`. Apply via `colW[col]` + `applyColW()`.

Helper reads the live font from a sample `.var-row input` (or the panel computed
style) so it tracks the design tokens.

### 4. Collapsible preview panel (thin strip)

Add a collapsed state toggled by a button in the preview header.

```css
.workspace.preview-collapsed { grid-template-columns: 1fr 32px; }
.preview-panel { position: relative; }
/* When collapsed, hide body/footer, show a vertical re-expand button */
.workspace.preview-collapsed .preview-body,
.workspace.preview-collapsed .preview-footer,
.workspace.preview-collapsed .preview-title,
.workspace.preview-collapsed #copy-btn { display: none; }
.preview-collapsed-tab { display: none; }   /* vertical "‹ JSON" button */
.workspace.preview-collapsed .preview-collapsed-tab {
  display: flex; writing-mode: vertical-rl; /* rotated label */ ...
}
```

- Toggle button in `.preview-header` (e.g. `›` to collapse). Collapsing adds
  `.preview-collapsed` to `.workspace`.
- When collapsed, a vertical `‹ JSON` tab (the collapsed-tab element, added to
  `.preview-panel`) re-expands on click.
- Table gains the freed width automatically (grid `1fr` column grows); combined
  with `overflow-x`, wide column layouts get more room.
- State held in a session `let previewCollapsed = false`.

### 5. Reset integration

Extend `resetFilters()` (it already restores sort/filter defaults) to also
restore layout, so the single Reset button is the "put everything back" control:

```js
colW = { ...DEFAULT_COL_W }; applyColW();
previewCollapsed = false;
document.querySelector('.workspace').classList.remove('preview-collapsed');
```

(Update the button's `title` from "Clear all filters & sorting" to include
layout.)

## Data flow

```
init → applyColW() (sets --w-* from defaults) + attach resizers + wire toggle
drag        → colW[col] mutated → applyColW() → header+rows reflow live
dblclick    → measure visible values → colW[col] (clamped) → applyColW()
toggle btn  → previewCollapsed flip → .workspace class → grid recomputes
reset       → colW reset + previewCollapsed=false → applyColW() + class removed
row re-render (innerHTML) → unaffected: vars live on .table-panel container
```

## Error handling / edge cases

- **Min width 40px** on drag prevents zero/negative columns.
- **Auto-fit max 480px** prevents one long value from making a column unusable
  (full value still reachable via the input + horizontal scroll).
- **Empty table:** auto-fit falls back to the default width (no visible rows to
  measure).
- **Sortable vs resize conflict:** resizer stops event propagation so a drag or
  double-click never triggers column sort.
- **Horizontal scroll alignment:** header and rows share one scroll container,
  so they stay aligned — no separate scroll sync needed.
- **Re-render safety:** because widths are container-scoped CSS vars and the
  resizers are appended to the static header (not the rebuilt rows-container),
  frequent `renderRow`/`renderAll` calls don't reset widths or drop handles.

## Testing

Manual verification (no automated browser test required for this UI-only
change, matching the repo's current test surface):

1. Drag each of the 7 handles — header and rows resize together, stay aligned.
2. Grow columns past panel width — horizontal scroll appears, header scrolls
   with rows.
3. Double-click a text-column handle with long values — column fits content,
   capped at 480px; with an empty table it falls back to default.
4. Double-click and drag do NOT trigger sort.
5. Collapse preview → strip + vertical re-expand tab; table widens. Expand
   restores panel.
6. Reset → column widths return to defaults and panel re-expands, alongside the
   existing filter/sort reset.
7. Add/edit/delete rows after resizing — widths persist through re-render.
8. Reload page — everything returns to defaults (session-only confirmed).

## Out of scope (YAGNI)

- Persisting layout across reloads / per-set (explicitly chosen session-only).
- Reordering columns.
- Resizing the left/right split ratio via a draggable divider (only collapse).
