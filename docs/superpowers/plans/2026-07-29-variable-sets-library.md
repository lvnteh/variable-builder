# Variable Sets & Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single shared variable list into many named **sets** shown in a shared **library** home screen, preserving live per-variable collaboration within each set.

**Architecture:** Replace the single in-memory `store` with a `Map<setId, store>` pre-loaded at boot (keeps every handler `await`-free, so the atomic critical section survives). A `library.json` index holds display metadata; one `sets/<uuid>.json` file holds each set (identical row shape to today). Variable routes gain a `/api/sets/:setId` prefix; new library-CRUD routes manage sets. Presence becomes per-set. The client gains two views — library home and editor — switched by a nullable `currentSetId`.

**Tech Stack:** Node + Express, plain JSON files (atomic tmp+rename), `crypto.randomUUID`, single-file HTML/JS client, `node --test`-free hand-rolled smoke asserts. No new dependencies.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `server.js` | HTTP + per-set store Map + library index + migration + per-set presence | Heavy modify |
| `lib/store.js` | **New.** Pure set-store module: load-all, getStore, persistSet, library index read/write, migration. Extracted so `server.js` stays route-focused and the logic is unit-testable without HTTP. | Create |
| `variable-builder.html` | Client: two views, `currentSetId`, per-set localStorage, library home UI | Heavy modify |
| `shared/validate.js` | Unchanged (row shape identical) | None |
| `shared/defaults.js` | Unchanged; used only by migration | None |
| `test/smoke.js` | Extend: library CRUD, set-scoped vars, isolation, migration, per-set presence | Modify |
| `test/store.test.js` | **New.** Unit tests for `lib/store.js` (migration idempotency, atomic copy, soft-delete/restore) runnable with no server. | Create |
| `README.md` | Document sets/library model + new routes | Modify (final task) |

**Why extract `lib/store.js`:** `server.js` today mixes storage and routing in one 346-line file. Adding sets triples the storage logic (index + N set files + migration + trash). Splitting storage into a pure, synchronous, HTTP-free module keeps each file focused, lets migration be unit-tested directly (no boot race to orchestrate in a test), and keeps the route handlers thin. This is a targeted split of code we're already rewriting — not unrelated refactoring.

---

## Conventions used throughout this plan

- **Set store shape** (in memory and on disk), identical rows to today:
  ```js
  { setId: "<uuid>", name: "AI Brand Identity", seq: 31, rows: [ /* {uid,position,version,data,meta} */ ] }
  ```
- **Library index entry:**
  ```js
  { setId, name, version: 1, variable_count, created_by, created_at, updated_by, updated_at }
  ```
- **Library file:** `{ seq: <int>, sets: [ <IndexEntry>, ... ] }`
- **Paths:** `DATA_DIR` = `process.env.RAILWAY_VOLUME_MOUNT_PATH || ./data`. `LIBRARY_PATH` = `DATA_DIR/library.json`. `SETS_DIR` = `DATA_DIR/sets`. `TRASH_DIR` = `DATA_DIR/sets/.trash`. `LEGACY_PATH` = `DATA_DIR/variables.json`.
- **Atomic write:** `writeJson(p, obj)` = write `p + '.tmp'`, then `renameSync` over `p`.
- **Never `await` between reading a version and writing** — same invariant as today.

---

## Phase 1 — `lib/store.js` storage module (no HTTP)

Pure, synchronous storage layer. All functions operate on files + an in-memory `Map`. Unit-tested directly against a temp dir. `node --test` is built in (Node ≥ 18) — used via a new `test/store.test.js` and a `test:unit` npm script.

### Task 1: Scaffold `lib/store.js` paths + atomic write + node:test wiring

**Files:**
- Create: `lib/store.js`
- Create: `test/store.test.js`
- Modify: `package.json` (add `test:unit` script)

- [ ] **Step 1: Add the unit-test script to `package.json`**

Modify the `"scripts"` block to:

```json
  "scripts": {
    "start": "node server.js",
    "smoke": "node test/smoke.js",
    "test:unit": "node --test test/store.test.js"
  },
```

- [ ] **Step 2: Write the failing test for path config + atomic writeJson/readJson**

Create `test/store.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test gets its own DATA_DIR. store.js reads DATA_DIR at configure() time.
function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vb-store-'));
}
function loadStore(dir) {
  delete require.cache[require.resolve('../lib/store.js')];
  const store = require('../lib/store.js');
  store.configure(dir);
  return store;
}

test('configure creates data + sets + trash dirs', () => {
  const dir = freshDir();
  const store = loadStore(dir);
  assert.ok(fs.existsSync(path.join(dir, 'sets')), 'sets dir exists');
  assert.ok(fs.existsSync(path.join(dir, 'sets', '.trash')), 'trash dir exists');
});

test('writeJson then readJson round-trips atomically (no .tmp left)', () => {
  const dir = freshDir();
  const store = loadStore(dir);
  const p = path.join(dir, 'x.json');
  store._writeJson(p, { a: 1 });
  assert.deepEqual(store._readJson(p), { a: 1 });
  assert.ok(!fs.existsSync(p + '.tmp'), 'no leftover tmp file');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — `Cannot find module '../lib/store.js'`.

- [ ] **Step 4: Implement the minimal `lib/store.js` to pass**

Create `lib/store.js`:

```js
'use strict';
/*
 * lib/store.js — pure, synchronous storage for the Variable Builder.
 *
 * Owns: the library index (library.json), one file per set (sets/<uuid>.json),
 * soft-delete trash (sets/.trash), legacy migration, and an in-memory
 * Map<setId, store> pre-loaded at boot. NO Express, NO await — every mutation
 * is a synchronous read-compare-write so it is atomic on Node's event loop
 * (the same reason the single-list app needed no database).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DATA_DIR, LIBRARY_PATH, SETS_DIR, TRASH_DIR, LEGACY_PATH;
const sets = new Map();          // setId -> { setId, name, seq, rows }
let library = { seq: 0, sets: [] };

function configure(dataDir) {
  DATA_DIR = dataDir;
  LIBRARY_PATH = path.join(DATA_DIR, 'library.json');
  SETS_DIR = path.join(DATA_DIR, 'sets');
  TRASH_DIR = path.join(SETS_DIR, '.trash');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SETS_DIR, { recursive: true });
  fs.mkdirSync(TRASH_DIR, { recursive: true });
}

function _writeJson(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}
function _readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

module.exports = { configure, _writeJson, _readJson };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:unit`
Expected: PASS — both tests green.

- [ ] **Step 6: Commit**

```bash
git add lib/store.js test/store.test.js package.json
git commit -m "feat(store): scaffold set-store module with atomic json IO"
```

### Task 2: Library index + set create/get/persist in the store module

**Files:**
- Modify: `lib/store.js`
- Modify: `test/store.test.js`

- [ ] **Step 1: Write failing tests for createSet / getStore / persistSet / library index**

Append to `test/store.test.js`:

```js
test('createSet adds an empty set to the index and to disk', () => {
  const dir = freshDir();
  const store = loadStore(dir);
  const set = store.createSet('My Set', 'Alice');
  assert.ok(set.setId, 'returns a setId');
  assert.equal(set.name, 'My Set');
  assert.equal(store.getStore(set.setId).rows.length, 0, 'new set is empty');
  const idx = store.listSets();
  assert.equal(idx.length, 1);
  assert.equal(idx[0].variable_count, 0);
  assert.equal(idx[0].created_by, 'Alice');
  // persisted
  assert.ok(fs.existsSync(path.join(dir, 'sets', set.setId + '.json')));
  const lib = store._readJson(path.join(dir, 'library.json'));
  assert.equal(lib.sets.length, 1);
});

test('persistSet writes the set file and refreshes denormalized count', () => {
  const dir = freshDir();
  const store = loadStore(dir);
  const set = store.createSet('S', 'Alice');
  const s = store.getStore(set.setId);
  s.rows.push({ uid: ++s.seq, position: 0, version: 1, data: { id: 'a' }, meta: {} });
  store.persistSet(set.setId, 'Bob');
  assert.equal(store.listSets()[0].variable_count, 1, 'count denormalized');
  assert.equal(store.listSets()[0].updated_by, 'Bob');
  // survives a reload
  const store2 = loadStore(dir);
  assert.equal(store2.getStore(set.setId).rows.length, 1);
});

test('getStore returns null for an unknown set', () => {
  const dir = freshDir();
  const store = loadStore(dir);
  assert.equal(store.getStore('nope'), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — `store.createSet is not a function`.

- [ ] **Step 3: Implement library load + createSet + getStore + persistSet**

In `lib/store.js`, add `now()` near the top after the requires:

```js
const now = () => new Date().toISOString();
```

Add these functions before `module.exports` and export them:

```js
// ── Library index ────────────────────────────────────────────────────────────
function loadLibrary() {
  if (fs.existsSync(LIBRARY_PATH)) {
    try {
      const parsed = _readJson(LIBRARY_PATH);
      if (parsed && Array.isArray(parsed.sets)) {
        library = { seq: Number(parsed.seq) || 0, sets: parsed.sets };
      }
    } catch (e) {
      console.error('[store] corrupt library.json, starting empty:', e.message);
      library = { seq: 0, sets: [] };
    }
  } else {
    library = { seq: 0, sets: [] };
  }
}
function persistLibrary() { _writeJson(LIBRARY_PATH, library); }
function listSets() { return library.sets.map(e => Object.assign({}, e)); }
function indexEntry(setId) { return library.sets.find(e => e.setId === setId) || null; }

// Recompute the denormalized display fields from the authoritative set file.
function refreshIndex(setId, who) {
  const entry = indexEntry(setId);
  const s = sets.get(setId);
  if (!entry || !s) return;
  entry.variable_count = s.rows.length;
  entry.name = s.name;
  entry.updated_by = who || entry.updated_by;
  entry.updated_at = now();
}

// ── Sets ─────────────────────────────────────────────────────────────────────
function setPath(setId) { return path.join(SETS_DIR, setId + '.json'); }

function getStore(setId) { return sets.get(setId) || null; }

function persistSet(setId, who) {
  const s = sets.get(setId);
  if (!s) return;
  _writeJson(setPath(setId), s);
  refreshIndex(setId, who);
  persistLibrary();
}

function createSet(name, who) {
  const setId = crypto.randomUUID();
  const t = now();
  const s = { setId, name: String(name || 'Untitled set').slice(0, 120), seq: 0, rows: [] };
  sets.set(setId, s);
  library.seq += 1;
  library.sets.push({
    setId, name: s.name, version: 1, variable_count: 0,
    created_by: who || 'Someone', created_at: t, updated_by: who || 'Someone', updated_at: t,
  });
  _writeJson(setPath(setId), s);
  persistLibrary();
  return Object.assign({}, indexEntry(setId));
}
```

Update `module.exports` to:

```js
module.exports = {
  configure, loadLibrary, listSets, indexEntry,
  getStore, persistSet, createSet,
  _writeJson, _readJson,
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/store.js test/store.test.js
git commit -m "feat(store): library index + createSet/getStore/persistSet"
```

### Task 3: rename / soft-delete / restore / duplicate + loadAll

**Files:**
- Modify: `lib/store.js`
- Modify: `test/store.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/store.test.js`:

```js
test('renameSet bumps index version; stale version rejected', () => {
  const dir = freshDir();
  const store = loadStore(dir);
  const set = store.createSet('Old', 'Alice');
  const ok = store.renameSet(set.setId, 'New', 1, 'Bob');
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.name, 'New');
  assert.equal(ok.entry.version, 2, 'version bumped');
  const stale = store.renameSet(set.setId, 'Newer', 1, 'Bob');
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict.version, 2, 'conflict returns current entry');
});

test('deleteSet moves file to trash and removes from index; restore brings it back', () => {
  const dir = freshDir();
  const store = loadStore(dir);
  const set = store.createSet('Doomed', 'Alice');
  assert.equal(store.deleteSet(set.setId).ok, true);
  assert.equal(store.listSets().length, 0, 'gone from index');
  assert.equal(store.getStore(set.setId), null, 'gone from memory');
  assert.ok(fs.existsSync(path.join(dir, 'sets', '.trash', set.setId + '.json')), 'in trash');
  const r = store.restoreSet(set.setId);
  assert.equal(r.ok, true);
  assert.equal(store.listSets().length, 1, 'back in index');
  assert.equal(store.getStore(set.setId).name, 'Doomed');
});

test('deleteSet on unknown id returns not found', () => {
  const dir = freshDir();
  const store = loadStore(dir);
  assert.equal(store.deleteSet('nope').ok, false);
});

test('duplicateSet copies rows with fresh row uids; original untouched', () => {
  const dir = freshDir();
  const store = loadStore(dir);
  const set = store.createSet('Orig', 'Alice');
  const s = store.getStore(set.setId);
  s.rows.push({ uid: ++s.seq, position: 0, version: 5, data: { id: 'a' }, meta: {} });
  store.persistSet(set.setId, 'Alice');
  const dup = store.duplicateSet(set.setId, 'Orig copy', 'Bob');
  const ds = store.getStore(dup.setId);
  assert.equal(ds.rows.length, 1, 'row copied');
  assert.equal(ds.rows[0].data.id, 'a');
  assert.equal(ds.rows[0].version, 1, 'copied row version reset to 1');
  assert.notEqual(dup.setId, set.setId, 'new set id');
  assert.equal(store.getStore(set.setId).rows[0].version, 5, 'original untouched');
});

test('loadAll reads every set file into memory on boot', () => {
  const dir = freshDir();
  const store = loadStore(dir);
  const a = store.createSet('A', 'x');
  const b = store.createSet('B', 'x');
  // simulate a fresh process
  const store2 = loadStore(dir);   // configure re-run
  store2.loadAll();
  assert.ok(store2.getStore(a.setId), 'set A reloaded');
  assert.ok(store2.getStore(b.setId), 'set B reloaded');
  assert.equal(store2.listSets().length, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — `store.renameSet is not a function`.

- [ ] **Step 3: Implement the functions**

In `lib/store.js`, add and export:

```js
function renameSet(setId, name, version, who) {
  const entry = indexEntry(setId);
  const s = sets.get(setId);
  if (!entry || !s) return { ok: false, notFound: true };
  if (Number(version) !== entry.version) {
    return { ok: false, conflict: Object.assign({}, entry) };
  }
  const clean = String(name || '').replace(/[ -]/g, '').trim().slice(0, 120);
  s.name = clean || s.name;
  entry.name = s.name;
  entry.version += 1;
  entry.updated_by = who || entry.updated_by;
  entry.updated_at = now();
  _writeJson(setPath(setId), s);
  persistLibrary();
  return { ok: true, entry: Object.assign({}, entry) };
}

function deleteSet(setId) {
  const idx = library.sets.findIndex(e => e.setId === setId);
  if (idx === -1) return { ok: false, notFound: true };
  const src = setPath(setId);
  if (fs.existsSync(src)) fs.renameSync(src, path.join(TRASH_DIR, setId + '.json'));
  library.sets.splice(idx, 1);
  sets.delete(setId);
  persistLibrary();
  return { ok: true };
}

function restoreSet(setId) {
  const trashed = path.join(TRASH_DIR, setId + '.json');
  if (!fs.existsSync(trashed)) return { ok: false, notFound: true };
  fs.renameSync(trashed, setPath(setId));
  const s = _readJson(setPath(setId));
  sets.set(setId, s);
  const t = now();
  library.seq += 1;
  library.sets.push({
    setId, name: s.name, version: 1, variable_count: s.rows.length,
    created_by: 'restore', created_at: t, updated_by: 'restore', updated_at: t,
  });
  persistLibrary();
  return { ok: true, entry: Object.assign({}, indexEntry(setId)) };
}

function duplicateSet(setId, name, who) {
  const src = sets.get(setId);
  if (!src) return null;
  const dupId = crypto.randomUUID();
  const t = now();
  // Snapshot in ONE synchronous tick — no await — so a concurrent edit to the
  // original cannot interleave into the copy.
  let seq = 0;
  const rows = src.rows
    .slice()
    .sort((a, b) => (a.position - b.position) || (a.uid - b.uid))
    .map((r, i) => ({
      uid: ++seq, position: i, version: 1,
      data: JSON.parse(JSON.stringify(r.data)),
      meta: { created_by: who || 'Someone', created_at: t, updated_by: who || 'Someone', updated_at: t },
    }));
  const s = { setId: dupId, name: String(name || (src.name + ' copy')).slice(0, 120), seq, rows };
  sets.set(dupId, s);
  library.seq += 1;
  library.sets.push({
    setId: dupId, name: s.name, version: 1, variable_count: rows.length,
    created_by: who || 'Someone', created_at: t, updated_by: who || 'Someone', updated_at: t,
  });
  _writeJson(setPath(dupId), s);
  persistLibrary();
  return Object.assign({}, indexEntry(dupId));
}

// Pre-load every set file into memory. Called once at boot AFTER loadLibrary().
function loadAll() {
  sets.clear();
  for (const entry of library.sets) {
    const p = setPath(entry.setId);
    if (!fs.existsSync(p)) {
      console.error('[store] index references missing set file:', entry.setId);
      continue;
    }
    try { sets.set(entry.setId, _readJson(p)); }
    catch (e) { console.error('[store] corrupt set file, skipping:', entry.setId, e.message); }
  }
}
```

Add `renameSet, deleteSet, restoreSet, duplicateSet, loadAll` to `module.exports`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/store.js test/store.test.js
git commit -m "feat(store): rename/soft-delete/restore/duplicate + loadAll"
```

### Task 4: Idempotent legacy migration + boot sequence

**Files:**
- Modify: `lib/store.js`
- Modify: `test/store.test.js`

- [ ] **Step 1: Write failing tests for migration**

Append to `test/store.test.js`:

```js
// Seed a legacy variables.json shaped exactly like today's single-list store.
function seedLegacy(dir, seq, rows) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'variables.json'), JSON.stringify({ seq, rows }));
}

test('migrate folds legacy variables.json into first set, seq copied verbatim', () => {
  const dir = freshDir();
  seedLegacy(dir, 31, [
    { uid: 1, position: 0, version: 3, data: { id: 'primary_brand_color' }, meta: { created_by: 'seed' } },
    { uid: 5, position: 1, version: 1, data: { id: 'accent_color' }, meta: {} },
  ]);
  const store = loadStore(dir);
  store.boot();                          // loadLibrary + migrate + loadAll
  const idx = store.listSets();
  assert.equal(idx.length, 1, 'one set created');
  assert.equal(idx[0].name, 'AI Brand Identity');
  assert.equal(idx[0].variable_count, 2);
  const s = store.getStore(idx[0].setId);
  assert.equal(s.seq, 31, 'seq copied verbatim (not reset to row count)');
  assert.equal(s.rows.length, 2);
  assert.equal(s.rows[0].version, 3, 'row versions preserved');
  // commit marker
  assert.ok(fs.existsSync(path.join(dir, 'variables.json.bak')), 'legacy renamed to .bak');
  assert.ok(!fs.existsSync(path.join(dir, 'variables.json')), 'legacy gone');
});

test('migrate is idempotent — second boot does not double-migrate', () => {
  const dir = freshDir();
  seedLegacy(dir, 5, [{ uid: 1, position: 0, version: 1, data: { id: 'a' }, meta: {} }]);
  loadStore(dir).boot();
  const store2 = loadStore(dir);
  store2.boot();
  assert.equal(store2.listSets().length, 1, 'still exactly one set');
});

test('boot with no legacy file yields an empty library', () => {
  const dir = freshDir();
  const store = loadStore(dir);
  store.boot();
  assert.equal(store.listSets().length, 0, 'empty library, no crash');
});

test('corrupt legacy file is treated as no-legacy (does not crash)', () => {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'variables.json'), '{ not json');
  const store = loadStore(dir);
  store.boot();
  assert.equal(store.listSets().length, 0);
  // corrupt legacy is NOT renamed to .bak (we didn't migrate it)
  assert.ok(fs.existsSync(path.join(dir, 'variables.json')), 'left in place for inspection');
});

test('empty legacy rows are treated as no-legacy', () => {
  const dir = freshDir();
  seedLegacy(dir, 0, []);
  const store = loadStore(dir);
  store.boot();
  assert.equal(store.listSets().length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — `store.boot is not a function`.

- [ ] **Step 3: Implement `migrate()`, `sweepTmp()`, and `boot()`**

In `lib/store.js`, add and export:

```js
// Fold a legacy single-list variables.json into the first set. Idempotent:
// the presence of variables.json.bak (written LAST) proves migration ran, so a
// re-run is a no-op. Backing up last is the transaction commit — if we renamed
// the legacy file first and then crashed, shouldMigrate would flip false and
// orphan the data.
function migrate() {
  const legacy = path.join(DATA_DIR, 'variables.json');
  const bak = path.join(DATA_DIR, 'variables.json.bak');
  const shouldMigrate =
    fs.existsSync(legacy) && !fs.existsSync(bak) && library.sets.length === 0;
  if (!shouldMigrate) return false;

  let parsed;
  try { parsed = _readJson(legacy); }
  catch (e) {
    console.error('[store] legacy variables.json unparseable, skipping migration:', e.message);
    return false;
  }
  if (!parsed || !Array.isArray(parsed.rows) || parsed.rows.length === 0) {
    console.warn('[store] legacy variables.json empty, skipping migration');
    return false;
  }

  const setId = crypto.randomUUID();
  const t = now();
  const s = {
    setId, name: 'AI Brand Identity',
    seq: Number(parsed.seq) || parsed.rows.length,   // verbatim; fallback only if absent
    rows: parsed.rows,
  };
  sets.set(setId, s);
  _writeJson(setPath(setId), s);                     // (a) set file
  library.seq += 1;
  library.sets.push({                                // (b) index entry
    setId, name: s.name, version: 1, variable_count: s.rows.length,
    created_by: 'migration', created_at: t, updated_by: 'migration', updated_at: t,
  });
  persistLibrary();
  fs.renameSync(legacy, bak);                        // (c) COMMIT MARKER — last
  console.log(`[store] migrated ${s.rows.length} legacy variables into set ${setId}`);
  return true;
}

// Remove stray *.tmp files left by a crash mid-write (in DATA_DIR and SETS_DIR).
function sweepTmp() {
  for (const d of [DATA_DIR, SETS_DIR]) {
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(d, f)); } catch {} }
    }
  }
}

// Full boot sequence — call once, synchronously, BEFORE app.listen().
function boot() {
  loadLibrary();
  migrate();      // no-op unless a legacy file is present and unmigrated
  loadAll();      // pre-load every set into memory (await-free atomicity)
  sweepTmp();
}
```

Add `migrate, sweepTmp, boot` to `module.exports`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit`
Expected: PASS — all migration tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/store.js test/store.test.js
git commit -m "feat(store): idempotent legacy migration + boot sequence"
```

---

## Phase 2 — `server.js`: wire the store, per-set presence, routes

`server.js` stops owning `store`/`persist`/`load`/`seedIfEmpty` (that logic now lives in `lib/store.js`) and becomes routing + presence + wire-format helpers. The smoke test (`test/smoke.js`) is the safety net for this phase; it is rewritten in Phase 4, but keep the server booting and `/health` green after every task.

### Task 5: Replace single-store internals with the store module + per-set presence

**Files:**
- Modify: `server.js:31-134` (paths, in-memory store, load/seed) and `server.js:48-95` (presence)

- [ ] **Step 1: Rewire requires, paths, and boot**

Replace `server.js` lines 24-44 (the `require`s through `let store = ...`) with:

```js
const path = require('path');
const express = require('express');

const V = require('./shared/validate.js');
const STORE = require('./lib/store.js');

// ── Paths ──────────────────────────────────────────────────────────────────
const ROOT = __dirname;
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data');

// Configure + boot the store synchronously BEFORE app.listen() (see bottom of
// file). boot() = loadLibrary + idempotent legacy migration + pre-load all sets.
STORE.configure(DATA_DIR);

const now = () => new Date().toISOString();
```

Note: `fs` and `DEFAULTS` are no longer required in `server.js` (both moved to the store module — `DEFAULTS` is only used by seeding, which is gone; sets start empty). Delete the `const fs = require('fs');` and `const DEFAULTS = require('./shared/defaults.js');` lines.

- [ ] **Step 2: Delete the now-dead single-store code**

Remove these blocks entirely from `server.js`:
- `fs.mkdirSync(DATA_DIR, …)` (now done by `STORE.configure`)
- `let store = { seq: 0, rows: [] };`
- `persist()`, `load()`, `seedIfEmpty()` functions
- the top-level `load();` and `seedIfEmpty();` calls
- `sortedRows()`, `listRecords()`, `findRow()`, `maxPosition()`, `listRevision()` — these become **per-set** helpers in the next step.

Keep `rowToRecord(row)` as-is (wire format is unchanged).

- [ ] **Step 3: Add per-set helpers**

Add after `rowToRecord`:

```js
// All list helpers are now per-set: they take a store `s` (from STORE.getStore).
function sortedRows(s) {
  return s.rows.slice().sort((a, b) => (a.position - b.position) || (a.uid - b.uid));
}
function listRecords(s) { return sortedRows(s).map(rowToRecord); }
function findRow(s, uid) { return s.rows.find(r => r.uid === uid); }
function maxPosition(s) { return s.rows.reduce((m, r) => Math.max(m, r.position), -1); }

// Per-set list revision — same construction as the old global one, scoped to s.
function listRevision(s) {
  const versionSum = s.rows.reduce((acc, r) => acc + r.version, 0);
  return `${s.seq}:${s.rows.length}:${versionSum}`;
}

// Library-level revision: changes on any create/rename/delete/restore, so the
// home screen can poll for library changes the way the editor polls a set.
function libraryRevision() {
  const sets = STORE.listSets();
  let h = 0;
  for (const e of sets) {
    const key = `${e.setId}:${e.version}:${e.variable_count}:${e.updated_at}`;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return `${sets.length}:${h}`;
}
```

- [ ] **Step 4: Make presence per-set**

Replace the presence block (`PRESENCE_TTL_MS` through `presenceList()`, old lines 54-95) with:

```js
const PRESENCE_TTL_MS = 12000;
// setId -> Map<clientId, { name, editingUid, lastSeen }>. A special key of ''
// (empty string) holds people browsing the library home (no set open).
const presenceBySet = new Map();
// Reverse index so the header-less sendBeacon leave path can find a client fast.
const clientSet = new Map();               // clientId -> setId (or '')

function setIdOf(req) {
  // set-scoped routes carry it in the URL; header covers /api/presence + home.
  const fromParam = req.params && req.params.setId;
  const fromHeader = req.get('X-VB-Set');
  return String(fromParam || fromHeader || '').slice(0, 64);
}

function identity(req) {
  const id = String(req.get('X-VB-Client') || '').slice(0, 64);
  const rawName = req.get('X-VB-Name') || '';
  let decoded;
  try { decoded = decodeURIComponent(rawName); } catch { decoded = rawName; }
  const name = decoded.replace(/[ -]/g, '').trim().slice(0, 40);
  const editingRaw = req.get('X-VB-Editing');
  const editingUid = editingRaw != null && editingRaw !== '' ? Number(editingRaw) : null;
  return { id, name, editingUid: Number.isInteger(editingUid) ? editingUid : null };
}

function markPresence(req) {
  const { id, name, editingUid } = identity(req);
  if (!id) return null;
  const setId = setIdOf(req);
  // If the client moved to a different set, drop it from the old one.
  const prevSet = clientSet.get(id);
  if (prevSet !== undefined && prevSet !== setId) {
    const m = presenceBySet.get(prevSet);
    if (m) { m.delete(id); if (m.size === 0) presenceBySet.delete(prevSet); }
  }
  clientSet.set(id, setId);
  if (!presenceBySet.has(setId)) presenceBySet.set(setId, new Map());
  const m = presenceBySet.get(setId);
  const prev = m.get(id);
  m.set(id, { name: name || (prev && prev.name) || 'Someone', editingUid, lastSeen: Date.now() });
  return id;
}

function dropClient(id) {
  const setId = clientSet.get(id);
  if (setId === undefined) return;
  const m = presenceBySet.get(setId);
  if (m) { m.delete(id); if (m.size === 0) presenceBySet.delete(setId); }
  clientSet.delete(id);
}

function whoIs(id) {
  const setId = clientSet.get(id);
  const m = setId !== undefined && presenceBySet.get(setId);
  const p = m && m.get(id);
  return (p && p.name) || 'Someone';
}

// Live clients in ONE set, freshest-agnostic; prunes stale entries as it goes.
function presenceList(setId) {
  const m = presenceBySet.get(String(setId || ''));
  if (!m) return [];
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  const out = [];
  for (const [id, p] of m) {
    if (p.lastSeen < cutoff) { m.delete(id); clientSet.delete(id); continue; }
    out.push({ id, name: p.name, editingUid: p.editingUid });
  }
  return out;
}

// Count of live clients per set, for the library home cards.
function presenceCounts() {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  const counts = {};
  for (const [setId, m] of presenceBySet) {
    let n = 0;
    for (const [, p] of m) if (p.lastSeen >= cutoff) n++;
    if (n > 0 && setId) counts[setId] = n;
  }
  return counts;
}
```

- [ ] **Step 5: Verify the server still boots and `/health` responds**

Add the boot call at the bottom (see Task 9 for the final listen block) — for now, temporarily ensure `STORE.boot()` runs before `app.listen`. Run:

```bash
rm -rf /tmp/vb-boot && RAILWAY_VOLUME_MOUNT_PATH=/tmp/vb-boot PORT=4801 node server.js &
sleep 1 && curl -s localhost:4801/health && kill %1
```

Expected: `{"ok":true,...}` (routes referencing removed helpers will 500 until Task 6-8; `/health` must be green).

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "refactor(server): per-set store + per-set presence via store module"
```

### Task 6: Library CRUD routes

**Files:**
- Modify: `server.js` (add routes after `/api/presence`)

- [ ] **Step 1: Update the presence route to be set-aware**

Replace the existing `app.post('/api/presence', …)` handler with:

```js
app.post('/api/presence', (req, res) => {
  if (req.query.leave && req.query.id) {
    dropClient(String(req.query.id).slice(0, 64));
    return res.json({ ok: true });
  }
  markPresence(req);
  const setId = setIdOf(req);
  res.json({ presence: presenceList(setId) });
});
```

- [ ] **Step 2: Add the library routes**

Add this block after the presence route:

```js
// ── Library (set index) ───────────────────────────────────────────────────────

// GET the library: every set's index entry + a live presence count, + revision.
app.get('/api/library', (req, res) => {
  markPresence(req);                         // caller may be browsing home (setId '')
  const counts = presenceCounts();
  const sets = STORE.listSets().map(e => Object.assign({}, e, { presence: counts[e.setId] || 0 }));
  res.json({ sets, revision: libraryRevision(), presence: presenceList(setIdOf(req)) });
});

// POST create an empty set. Body: { name }.
app.post('/api/library', (req, res) => {
  const id = markPresence(req);
  const who = id ? whoIs(id) : 'Someone';
  const name = String((req.body || {}).name || '').trim() || 'Untitled set';
  const entry = STORE.createSet(name, who);
  res.status(201).json({ set: entry, revision: libraryRevision() });
});

// PUT rename a set. Body: { name, version }. 409 on stale index version.
app.put('/api/library/:setId', (req, res) => {
  const id = markPresence(req);
  const who = id ? whoIs(id) : 'Someone';
  const { name, version } = req.body || {};
  const r = STORE.renameSet(req.params.setId, name, version, who);
  if (r.notFound) return res.status(404).json({ error: 'set_not_found' });
  if (!r.ok) return res.status(409).json({ error: 'version_conflict', set: r.conflict, revision: libraryRevision() });
  res.json({ set: r.entry, revision: libraryRevision() });
});

// DELETE soft-delete a set (moves file to .trash/).
app.delete('/api/library/:setId', (req, res) => {
  markPresence(req);
  const r = STORE.deleteSet(req.params.setId);
  if (!r.ok) return res.status(404).json({ error: 'set_not_found' });
  res.json({ ok: true, revision: libraryRevision() });
});

// POST restore a soft-deleted set from .trash/.
app.post('/api/library/:setId/restore', (req, res) => {
  markPresence(req);
  const r = STORE.restoreSet(req.params.setId);
  if (!r.ok) return res.status(404).json({ error: 'set_not_found' });
  res.status(201).json({ set: r.entry, revision: libraryRevision() });
});

// POST duplicate a set (server-side atomic copy, fresh row uids). Body: { name? }.
app.post('/api/library/:setId/duplicate', (req, res) => {
  const id = markPresence(req);
  const who = id ? whoIs(id) : 'Someone';
  const entry = STORE.duplicateSet(req.params.setId, (req.body || {}).name, who);
  if (!entry) return res.status(404).json({ error: 'set_not_found' });
  res.status(201).json({ set: entry, revision: libraryRevision() });
});
```

- [ ] **Step 3: Smoke-check the library routes by hand**

```bash
rm -rf /tmp/vb-lib && RAILWAY_VOLUME_MOUNT_PATH=/tmp/vb-lib PORT=4802 node server.js &
sleep 1
curl -s localhost:4802/api/library
SID=$(curl -s -XPOST localhost:4802/api/library -H 'Content-Type: application/json' -d '{"name":"First"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).set.setId))")
echo "created $SID"
curl -s localhost:4802/api/library
kill %1
```

Expected: first GET `{"sets":[],...}`; after POST the set appears with `variable_count:0`.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(server): library CRUD routes (create/rename/delete/restore/duplicate)"
```

### Task 7: Set-scoped variable routes

**Files:**
- Modify: `server.js` (replace the old `/api/variables*` routes)

Every route resolves its set first via a tiny guard; a missing set is `404 {error:"set_not_found"}`.

- [ ] **Step 1: Add a set-resolver guard, then the scoped routes**

Replace the old `/api/variables` GET/POST/PUT/DELETE/order/bulk block with:

```js
// Resolve :setId → in-memory store, or send 404. Returns the store or null
// (null means a response was already sent).
function requireSet(req, res) {
  const s = STORE.getStore(req.params.setId);
  if (!s) { res.status(404).json({ error: 'set_not_found' }); return null; }
  return s;
}

// GET all variables in a set + revision + that set's presence. Doubles as a heartbeat.
app.get('/api/sets/:setId/variables', (req, res) => {
  markPresence(req);
  const s = requireSet(req, res); if (!s) return;
  res.json({ variables: listRecords(s), revision: listRevision(s), presence: presenceList(req.params.setId) });
});

// POST a new variable into a set.
app.post('/api/sets/:setId/variables', (req, res) => {
  const id = markPresence(req);
  const s = requireSet(req, res); if (!s) return;
  const who = id ? whoIs(id) : 'Someone';
  const t = now();
  const v = V.coerceVariable(req.body || {});
  const row = {
    uid: ++s.seq, position: maxPosition(s) + 1, version: 1, data: v,
    meta: { created_by: who, created_at: t, updated_by: who, updated_at: t },
  };
  s.rows.push(row);
  STORE.persistSet(req.params.setId, who);
  res.status(201).json({ variable: rowToRecord(row), revision: listRevision(s) });
});

// PUT one variable — optimistic concurrency at ROW level. No await between the
// version check and the write, so it stays atomic on the event loop.
app.put('/api/sets/:setId/variables/:uid', (req, res) => {
  const id = markPresence(req);
  const s = requireSet(req, res); if (!s) return;
  const who = id ? whoIs(id) : 'Someone';
  const uid = Number(req.params.uid);
  const row = findRow(s, uid);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const clientVersion = Number((req.body || {}).version);
  if (!Number.isInteger(clientVersion)) return res.status(400).json({ error: 'missing_version' });
  if (clientVersion !== row.version) {
    return res.status(409).json({ error: 'version_conflict', variable: rowToRecord(row), revision: listRevision(s) });
  }
  row.data = V.coerceVariable((req.body || {}).data || {});
  row.version += 1;
  const created = row.meta || {};
  row.meta = {
    created_by: created.created_by || who,
    created_at: created.created_at || now(),
    updated_by: who, updated_at: now(),
  };
  STORE.persistSet(req.params.setId, who);
  res.json({ variable: rowToRecord(row), revision: listRevision(s) });
});

// DELETE one variable.
app.delete('/api/sets/:setId/variables/:uid', (req, res) => {
  const id = markPresence(req);
  const s = requireSet(req, res); if (!s) return;
  const who = id ? whoIs(id) : 'Someone';
  const uid = Number(req.params.uid);
  const before = s.rows.length;
  s.rows = s.rows.filter(r => r.uid !== uid);
  if (s.rows.length === before) return res.status(404).json({ error: 'not_found' });
  STORE.persistSet(req.params.setId, who);
  res.json({ ok: true, revision: listRevision(s) });
});

// PUT order — persist a new row ordering. Body: { order: [uid,...] }.
app.put('/api/sets/:setId/order', (req, res) => {
  const id = markPresence(req);
  const s = requireSet(req, res); if (!s) return;
  const who = id ? whoIs(id) : 'Someone';
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'missing_order' });
  order.forEach((uid, i) => { const row = findRow(s, Number(uid)); if (row) row.position = i; });
  STORE.persistSet(req.params.setId, who);
  res.json({ ok: true, revision: listRevision(s) });
});

// POST bulk import — APPEND (never replace). Body: { variables|custom: [...] } or bare array.
app.post('/api/sets/:setId/variables/bulk', (req, res) => {
  const id = markPresence(req);
  const s = requireSet(req, res); if (!s) return;
  const who = id ? whoIs(id) : 'Someone';
  const t = now();
  const body = req.body || {};
  let incoming = Array.isArray(body) ? body
    : Array.isArray(body.variables) ? body.variables
    : Array.isArray(body.custom) ? body.custom : null;
  if (!incoming) return res.status(400).json({ error: 'expected_array' });
  const existing = listRecords(s);
  const coerced = incoming.map(V.coerceVariable);
  const combined = existing.concat(coerced);
  const uniqueIds = V.ensureUniqueIds(combined);
  coerced.forEach((v, i) => { v.id = uniqueIds[existing.length + i]; });
  let pos = maxPosition(s);
  coerced.forEach(v => {
    s.rows.push({
      uid: ++s.seq, position: ++pos, version: 1, data: v,
      meta: { created_by: who, created_at: t, updated_by: who, updated_at: t },
    });
  });
  STORE.persistSet(req.params.setId, who);
  res.status(201).json({ variables: listRecords(s), revision: listRevision(s), added: coerced.length });
});

// DELETE all variables in a set (guarded on the client).
app.delete('/api/sets/:setId/variables', (req, res) => {
  const id = markPresence(req);
  const s = requireSet(req, res); if (!s) return;
  const who = id ? whoIs(id) : 'Someone';
  s.rows = [];
  STORE.persistSet(req.params.setId, who);
  res.json({ ok: true, revision: listRevision(s) });
});
```

- [ ] **Step 2: Smoke-check a full CRUD cycle by hand**

```bash
rm -rf /tmp/vb-vars && RAILWAY_VOLUME_MOUNT_PATH=/tmp/vb-vars PORT=4803 node server.js &
sleep 1
SID=$(curl -s -XPOST localhost:4803/api/library -H 'Content-Type: application/json' -d '{"name":"S"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).set.setId))")
curl -s -XPOST localhost:4803/api/sets/$SID/variables -H 'Content-Type: application/json' -d '{"type":"integer","display_name":"Count","default_value":"7"}'
curl -s localhost:4803/api/sets/$SID/variables
curl -s localhost:4803/api/sets/does-not-exist/variables   # expect 404 set_not_found
kill %1
```

Expected: POST returns `default_value:7` (coerced), GET lists it, bad set → `{"error":"set_not_found"}`.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(server): set-scoped variable routes (/api/sets/:setId/...)"
```

### Task 8: Health revision + boot-before-listen

**Files:**
- Modify: `server.js` (`/health` route; the bottom `app.listen` block)

- [ ] **Step 1: Point `/health` at the library revision**

Replace the `/health` handler with:

```js
app.get('/health', (req, res) => res.status(200).json({ ok: true, revision: libraryRevision() }));
```

- [ ] **Step 2: Boot the store synchronously before listening**

Replace the bottom listen block with:

```js
// ── Listen ───────────────────────────────────────────────────────────────────
// boot() runs migration + pre-loads all sets. It is synchronous and completes
// BEFORE the socket binds, so no request can arrive mid-migration (no lock file).
STORE.boot();
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Variable Builder listening on :${PORT}  (data: ${DATA_DIR})`);
});
```

- [ ] **Step 3: Verify boot + migration end-to-end with a legacy file**

```bash
rm -rf /tmp/vb-mig && mkdir -p /tmp/vb-mig
echo '{"seq":31,"rows":[{"uid":1,"position":0,"version":3,"data":{"id":"primary_brand_color","display_name":"Primary Brand Color","type":"color","default_value":"#1A1A2E"},"meta":{"created_by":"seed"}}]}' > /tmp/vb-mig/variables.json
RAILWAY_VOLUME_MOUNT_PATH=/tmp/vb-mig PORT=4804 node server.js &
sleep 1
curl -s localhost:4804/api/library
ls /tmp/vb-mig                       # expect: library.json  sets  variables.json.bak
kill %1
```

Expected: library has one set "AI Brand Identity" with `variable_count:1`; `variables.json.bak` exists; `variables.json` is gone.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(server): library-level health revision + boot-before-listen"
```

---

## Phase 3 — client (`variable-builder.html`): two views

The client gains a nullable `currentSetId`: `null` = **library home**, a UUID = **editor** for that set. All existing editor logic (reconcile, presence, attribution, view/filter) is unchanged — it just runs against set-scoped URLs and per-set storage keys. This phase is verified by the browser test in Phase 4; after each task, load the page and confirm no console errors.

**Grounding — current client landmarks** (`variable-builder.html`): global state at 1021-1023; `POLL_MS`/`CACHE_KEY` at 1025-1026; `ID_KEY`/`NAME_KEY` at 1034-1035; `api()` at 1081-1098; `addVar` 1296; `saveVar` 1588; `deleteVar` 1651; `loadFromServer` 1689; `VIEW_KEY` 1704; `applyServerList` 1921; `poll` 1990; `clearAll` 2089; `importJson` 2138; `init` 2178; `beforeunload` 2202-2210.

### Task 9: Set state, `X-VB-Set` header, per-set storage keys

**Files:**
- Modify: `variable-builder.html` (globals ~1021-1036; `api()` ~1081; storage-key usages)

- [ ] **Step 1: Add set-state globals**

After `const saveTimers = {};` (line 1023) add:

```js
let currentSetId = null;           // null = library home; UUID = editing that set
let libRev = null;                 // last library revision we rendered (home view)
let sets = [];                     // library index entries (home view)
const CURRENT_SET_KEY = 'bc-variable-builder-current-set';
```

- [ ] **Step 2: Send `X-VB-Set` on every request**

In `api()` (after the `X-VB-Editing` header line ~1089) add:

```js
  if (currentSetId) headers['X-VB-Set'] = currentSetId;
```

- [ ] **Step 3: Make `CACHE_KEY` and `VIEW_KEY` per-set**

`CACHE_KEY` (1026) and `VIEW_KEY` (1704) are currently constants. Replace their **usages** with per-set accessors so cache/view state don't bleed across sets. Add near the other key constants:

```js
// Per-set storage keys: the base cache/view keys get a `-<setId>` suffix so each
// set keeps its own offline cache and sort/filter state. Home view uses neither.
const CACHE_BASE = 'bc-variable-builder-cache';
const VIEW_BASE  = 'bc-variable-builder-view';
function cacheKey() { return currentSetId ? `${CACHE_BASE}-${currentSetId}` : CACHE_BASE; }
function viewKey()  { return currentSetId ? `${VIEW_BASE}-${currentSetId}`  : VIEW_BASE; }
```

Then:
- Delete the old `const CACHE_KEY = …` (1026) and `const VIEW_KEY = …` (1704) lines.
- In `cacheOffline()` (1677): `localStorage.setItem(cacheKey(), …)`.
- In `loadView()` (1717): `JSON.parse(localStorage.getItem(viewKey()) || '{}')`.
- In `saveView()` (1723): `localStorage.setItem(viewKey(), …)`.
- In `init()` offline fallback (2190): `JSON.parse(localStorage.getItem(cacheKey()) || '[]')`.

- [ ] **Step 4: Verify no console errors on load (still single-view for now)**

```bash
rm -rf /tmp/vb-cli && RAILWAY_VOLUME_MOUNT_PATH=/tmp/vb-cli PORT=4805 node server.js &
sleep 1 && echo "open http://localhost:4805 — expect it to load; poll will 404 until Task 11" ; kill %1
```

Expected: page renders; `currentSetId` is defined. (Wiring the actual views is Tasks 10-11.)

- [ ] **Step 5: Commit**

```bash
git add variable-builder.html
git commit -m "feat(client): set-state globals, X-VB-Set header, per-set storage keys"
```

### Task 10: Library home view — markup + render

Rendered into a new top-level container that is shown on home and hidden in the editor. The editor chrome (filter bar at line 895, workspace at 930) is hidden on home.

**Files:**
- Modify: `variable-builder.html` (add `#library-view` after `<body>`; add render + CSS)

- [ ] **Step 1: Add the library container markup**

Immediately after the `</header>` (line 892) insert:

```html
<!-- LIBRARY HOME (shown when no set is open) -->
<section class="library" id="library-view" style="display:none">
  <div class="library-head">
    <h1 class="library-title">Variable sets</h1>
    <button class="btn-primary" id="new-set-btn" onclick="createSetPrompt()">+ New set</button>
  </div>
  <div class="library-grid" id="library-grid"></div>
  <div class="empty-state" id="library-empty" style="display:none">
    <div class="empty-icon">[ ]</div>
    <p>No sets yet.<br>Create your first set to start adding variables.</p>
  </div>
  <div class="library-trash" id="library-trash" style="display:none"></div>
</section>
```

- [ ] **Step 2: Add an editor breadcrumb**

Inside `<header>`, after the `.brand` div (line 882), add a breadcrumb that only shows in the editor:

```html
    <button class="crumb" id="crumb-back" onclick="goHome()" style="display:none" title="Back to library">← Library</button>
    <span class="crumb-sep" id="crumb-sep" style="display:none">/</span>
    <button class="crumb-name" id="crumb-name" style="display:none" title="Rename this set" onclick="renameSetPrompt()"></button>
```

- [ ] **Step 3: Add CSS for the library grid**

Before `</style>` (find it near the top `<style>` block), add:

```css
.library { padding: 24px 32px; max-width: 1100px; margin: 0 auto; }
.library-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.library-title { font-size: 20px; font-weight: 600; margin: 0; }
.library-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
.set-card { border: 1px solid var(--border); border-radius: 10px; padding: 16px; cursor: pointer; background: var(--panel); transition: border-color .15s, transform .05s; }
.set-card:hover { border-color: var(--accent); }
.set-card:active { transform: scale(.995); }
.set-card h3 { margin: 0 0 6px; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.set-card .set-meta { font-size: 12px; color: var(--muted); display: flex; gap: 10px; align-items: center; }
.set-card .set-actions { margin-top: 12px; display: flex; gap: 8px; }
.set-card .set-actions button { font-size: 12px; padding: 4px 8px; }
.set-card .set-presence { color: var(--accent); font-weight: 600; }
.crumb, .crumb-name { background: none; border: none; color: var(--muted); cursor: pointer; font: inherit; padding: 0 4px; }
.crumb-name { color: var(--text); font-weight: 600; }
.crumb:hover, .crumb-name:hover { color: var(--accent); }
.crumb-sep { color: var(--muted); }
.library-trash { margin-top: 28px; font-size: 13px; }
.library-trash .trash-item { display: flex; gap: 10px; align-items: center; padding: 4px 0; color: var(--muted); }
```

(If `--panel`/`--accent` aren't defined, reuse existing variables — check the `:root` block and substitute the closest existing token.)

- [ ] **Step 4: Add the render function**

Add near `renderAll` (~1979):

```js
// ─── Library home view ─────────────────────────────────────────────────────
function esc2(s) { return esc(s); }   // reuse existing esc()

function renderLibrary() {
  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');
  grid.innerHTML = '';
  if (!sets.length) { empty.style.display = ''; }
  else {
    empty.style.display = 'none';
    sets.forEach(s => {
      const card = document.createElement('div');
      card.className = 'set-card';
      card.onclick = (e) => { if (!e.target.closest('.set-actions')) openSet(s.setId); };
      const who = s.updated_by ? `edited by ${esc(s.updated_by)}` : '';
      const pres = s.presence ? `<span class="set-presence">● ${s.presence} here</span>` : '';
      card.innerHTML =
        `<h3>${esc(s.name)}</h3>` +
        `<div class="set-meta"><span>${s.variable_count} vars</span>${pres}</div>` +
        `<div class="set-meta" style="margin-top:4px">${who}</div>` +
        `<div class="set-actions">` +
          `<button class="btn-tiny" onclick="openSet('${s.setId}')">Open</button>` +
          `<button class="btn-tiny" onclick="duplicateSet('${s.setId}')">Duplicate</button>` +
          `<button class="btn-tiny" onclick="renameSetPromptFor('${s.setId}',${s.version})">Rename</button>` +
          `<button class="btn-tiny" onclick="deleteSet('${s.setId}','${esc(s.name).replace(/'/g,"\\'")}')">Delete</button>` +
        `</div>`;
      grid.appendChild(card);
    });
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add variable-builder.html
git commit -m "feat(client): library home markup, styles, and render"
```

### Task 11: View switching, set-scoped load/poll, and 404 handling

**Files:**
- Modify: `variable-builder.html` (`loadFromServer`, `poll`, `addVar`/`saveVar`/`deleteVar`/`clearAll`/`importJson` paths, `init`)

- [ ] **Step 1: Add view-toggle + set-switch routines**

Add near `loadFromServer` (~1689):

```js
// Show/hide editor chrome vs the library home. One source of truth for "what
// view am I in": currentSetId (null = home).
function applyViewMode() {
  const home = currentSetId == null;
  document.getElementById('library-view').style.display = home ? '' : 'none';
  document.getElementById('filterbar').style.display = home ? 'none' : '';
  document.querySelector('.workspace').style.display = home ? 'none' : '';
  ['crumb-back','crumb-sep','crumb-name'].forEach(id =>
    document.getElementById(id).style.display = home ? 'none' : '');
  document.getElementById('count-tag').style.display = home ? 'none' : '';
  if (!home) {
    const entry = sets.find(s => s.setId === currentSetId);
    document.getElementById('crumb-name').textContent = entry ? entry.name : 'Set';
  }
}

async function goHome() {
  currentSetId = null;
  try { localStorage.removeItem(CURRENT_SET_KEY); } catch {}
  applyViewMode();
  await loadLibrary();
}

async function openSet(setId) {
  currentSetId = setId;
  try { localStorage.setItem(CURRENT_SET_KEY, setId); } catch {}
  // Reset per-set editor state; only one set is open at a time.
  vars = []; localRev = null;
  Object.keys(saveTimers).forEach(k => { clearTimeout(saveTimers[k]); delete saveTimers[k]; });
  loadView();                          // load THIS set's saved sort/filter
  applyViewMode();
  await loadFromServer();
}
```

- [ ] **Step 2: Add `loadLibrary` + rewrite `loadFromServer` and `poll` to branch on view**

Add `loadLibrary` and update `loadFromServer` (1689-1698):

```js
async function loadLibrary() {
  const res = await api('GET', '/api/library');
  if (!res.ok) { setSync('offline', 'offline'); return false; }
  sets = res.json.sets;
  libRev = res.json.revision;
  renderLibrary();
  setSync('synced', 'synced');
  return true;
}

async function loadFromServer() {
  if (currentSetId == null) return loadLibrary();
  const res = await api('GET', `/api/sets/${currentSetId}/variables`);
  if (res.status === 404) { onSetDeleted(); return false; }
  if (!res.ok) { setSync('offline', 'offline'); return false; }
  vars = res.json.variables.map(toRecord);
  localRev = res.json.revision;
  renderAll();
  applyPresence(res.json.presence);
  setSync('synced', 'synced');
  return true;
}
```

Update `poll` (1990-2002):

```js
async function poll() {
  if (currentSetId == null) {
    const res = await api('GET', '/api/library');
    if (!res.ok) { setSync('offline', 'offline'); return; }
    if (res.json.revision !== libRev) { sets = res.json.sets; libRev = res.json.revision; renderLibrary(); }
    setSync('synced', 'synced');
    return;
  }
  const res = await api('GET', `/api/sets/${currentSetId}/variables`);
  if (res.status === 404) { onSetDeleted(); return; }      // set deleted by someone else
  if (!res.ok) { setSync('offline', 'offline'); return; }
  applyPresence(res.json.presence);
  if (res.json.revision !== localRev) {
    applyServerList(res.json.variables, res.json.revision);
    if (!Object.keys(saveTimers).length) setSync('synced', 'synced');
  } else if (!Object.keys(saveTimers).length) {
    setSync('synced', 'synced');
  }
}
```

- [ ] **Step 3: Add `onSetDeleted` with draft recovery**

Add near `openSet`:

```js
// The open set was deleted by someone else (any 404 from a set route). Stop
// auto-saving, stash in-flight work to a draft, warn, and return to the library.
let setDeletedHandled = false;   // fire once per deletion
function onSetDeleted() {
  if (setDeletedHandled) return;
  setDeletedHandled = true;
  Object.keys(saveTimers).forEach(k => { clearTimeout(saveTimers[k]); delete saveTimers[k]; });
  try {
    const draft = buildJson();
    if (draft.length) localStorage.setItem(`draft_${currentSetId}`, JSON.stringify(draft));
  } catch {}
  const deletedId = currentSetId;
  alert('This set was deleted by someone else. Your in-progress changes were saved locally — use Import to recover them into a new set.');
  currentSetId = null;
  try { localStorage.removeItem(CURRENT_SET_KEY); } catch {}
  applyViewMode();
  loadLibrary().then(() => { setDeletedHandled = false; });
}
```

- [ ] **Step 4: Scope the mutation routines to the current set**

Change the request paths (leave all other logic untouched):
- `addVar` (~1307): `api('POST', `/api/sets/${currentSetId}/variables`, …)`
- `saveVar` (~1600): `api('PUT', `/api/sets/${currentSetId}/variables/${v.uid}`, …)`; on `res.status === 404` where the **set** is gone (body `error === 'set_not_found'`), call `onSetDeleted()` and return (do not schedule a retry).
- `deleteVar` (~1656): `api('DELETE', `/api/sets/${currentSetId}/variables/${v.uid}`)`
- order save (find `PUT', '/api/order'`): `/api/sets/${currentSetId}/order`
- `clearAll` (~2092): `api('DELETE', `/api/sets/${currentSetId}/variables`)`
- `importJson` (~2157, the bulk POST): `/api/sets/${currentSetId}/variables/bulk`

Guard each mutation entry with: `if (currentSetId == null) return;` (they can only be triggered from the editor, but this is defense in depth).

For `saveVar`'s retry path (1637-1638): only retry on network/5xx, and on `error==='set_not_found'` call `onSetDeleted()` instead of retrying (see edge case #8 in the spec — never back off on 404).

- [ ] **Step 5: Restore last-open set (or land on home) in `init`**

In `init` (~2186), replace the `const ok = await loadFromServer();` region with:

```js
  // Restore the last-open set if it still exists; otherwise land on the library.
  let restore = null;
  try { restore = localStorage.getItem(CURRENT_SET_KEY); } catch {}
  await loadLibrary();                       // always know the set list first
  if (restore && sets.some(s => s.setId === restore)) {
    await openSet(restore);
  } else {
    currentSetId = null;
    applyViewMode();
  }
```

Delete the old offline-cache fallback tied to the single list, or gate it behind `if (currentSetId)` — the home view has no `vars` cache.

- [ ] **Step 6: Add the set-action handlers used by the cards/breadcrumb**

Add near `renderLibrary`:

```js
async function createSetPrompt() {
  const name = prompt('Name your new set:', 'New set');
  if (name == null) return;
  const res = await api('POST', '/api/library', { name: name.trim() || 'Untitled set' });
  if (res.ok && res.json.set) { await loadLibrary(); openSet(res.json.set.setId); }
}
async function duplicateSet(setId) {
  const res = await api('POST', `/api/library/${setId}/duplicate`, {});
  if (res.ok) await loadLibrary();
}
async function renameSetPromptFor(setId, version) {
  const entry = sets.find(s => s.setId === setId);
  const name = prompt('Rename set:', entry ? entry.name : '');
  if (name == null) return;
  const res = await api('PUT', `/api/library/${setId}`, { name: name.trim(), version });
  if (res.status === 409) { await loadLibrary(); alert('That set was renamed by someone else — try again.'); return; }
  await loadLibrary();
  if (setId === currentSetId) applyViewMode();   // refresh breadcrumb
}
function renameSetPrompt() {                       // from the editor breadcrumb
  const entry = sets.find(s => s.setId === currentSetId);
  if (entry) renameSetPromptFor(currentSetId, entry.version);
}
async function deleteSet(setId, name) {
  if (!confirm(`Delete "${name}"? It moves to trash and can be restored.`)) return;
  const res = await api('DELETE', `/api/library/${setId}`);
  if (res.ok) { if (setId === currentSetId) { currentSetId = null; applyViewMode(); } await loadLibrary(); }
}
```

- [ ] **Step 7: Verify both views in a browser**

```bash
rm -rf /tmp/vb-two && RAILWAY_VOLUME_MOUNT_PATH=/tmp/vb-two PORT=4806 node server.js &
sleep 1 && echo "open http://localhost:4806 — create a set, add a var, go back, see the card, reload (restores set)"
# leave running for manual check, then: kill %1
```

Expected: home shows empty state → **+ New set** → editor opens empty → add variable → **← Library** → card shows "1 vars" → reload reopens the set.

- [ ] **Step 8: Commit**

```bash
git add variable-builder.html
git commit -m "feat(client): two-view switching, set-scoped load/poll, delete-set recovery"
```

---

## Phase 4 — tests, docs, deploy

### Task 12: Rewrite `test/smoke.js` for sets

The smoke suite runs against a **throwaway** instance so production data is untouched. It first creates a set, then runs the full existing variable cycle scoped to it, then adds library-specific assertions.

**Files:**
- Modify: `test/smoke.js`
- Modify: `package.json` (smoke should spin up its own server on a spare port + temp dir)

- [ ] **Step 1: Make `smoke` self-contained (own server + temp dir)**

Replace the `smoke` script in `package.json` and add a runner so the suite never touches `./data` or a running prod:

```json
    "smoke": "node test/run-smoke.js",
```

Create `test/run-smoke.js`:

```js
'use strict';
// Boots a throwaway server on a spare port + temp data dir, runs smoke.js
// against it, and tears down. Production data is never touched.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 4700;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-smoke-'));
const srv = spawn('node', ['server.js'], {
  env: Object.assign({}, process.env, { PORT, RAILWAY_VOLUME_MOUNT_PATH: dir }),
  stdio: 'inherit',
});

function done(code) {
  try { srv.kill(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

setTimeout(() => {
  const smoke = spawn('node', ['test/smoke.js'], {
    env: Object.assign({}, process.env, { BASE: `http://localhost:${PORT}` }),
    stdio: 'inherit',
  });
  smoke.on('exit', done);
}, 1000);

srv.on('exit', (c) => { if (c) done(c || 1); });
```

- [ ] **Step 2: Rewrite `test/smoke.js` — set up a set, then scope all variable asserts to it**

Replace the top of the IIFE (health + seeded-list section, lines 38-48) with:

```js
  // health
  const h = await j('GET', '/health');
  assert(h.status === 200 && h.json.ok, 'GET /health returns ok');

  // library starts empty (fresh temp instance, no legacy file)
  const lib0 = await j('GET', '/api/library');
  assert(lib0.status === 200 && Array.isArray(lib0.json.sets), 'GET /api/library returns a sets array');
  assert(lib0.json.sets.length === 0, 'fresh instance has an empty library');

  // create a set to work in
  const mk = await j('POST', '/api/library', { name: 'Smoke Set' }, AS_ALICE);
  assert(mk.status === 201 && mk.json.set.setId, 'POST /api/library creates a set');
  const SID = mk.json.set.setId;
  assert(mk.json.set.variable_count === 0, 'new set is empty');

  // set-scoped list is empty to start
  const list = await j('GET', `/api/sets/${SID}/variables`);
  assert(list.status === 200 && Array.isArray(list.json.variables), 'GET set variables returns an array');
  assert(list.json.variables.length === 0, 'new set has zero variables');
  const rev0 = list.json.revision;
  assert(typeof rev0 === 'string', 'set list has a revision token');
```

Then, in every remaining assertion, replace the paths:
- `'/api/variables'` → `` `/api/sets/${SID}/variables` ``
- `` `/api/variables/${uid}` `` → `` `/api/sets/${SID}/variables/${uid}` ``
- `'/api/variables/bulk'` → `` `/api/sets/${SID}/variables/bulk` ``

The presence assertions (124-157) stay, but add `X-VB-Set` so both clients are in the same set. Change `AS_ALICE`/`AS_BOB` to include the set, OR pass a merged header object. Simplest: define set-scoped identities after `SID` exists:

```js
  const IN_SET = { 'X-VB-Set': SID };
  const ALICE_S = Object.assign({}, AS_ALICE, IN_SET);
  const BOB_S   = Object.assign({}, AS_BOB, IN_SET);
```

and use `ALICE_S`/`BOB_S` for the presence-in-a-set assertions (so `presenceList(SID)` returns them). Update the two `GET /api/variables` heartbeats (122-123) to `GET /api/sets/${SID}/variables` with `ALICE_S`/`BOB_S`, and `POST /api/presence` calls to include `IN_SET`.

- [ ] **Step 3: Add library-specific assertions before the final log line (165)**

```js
  // ── Library CRUD ──────────────────────────────────────────────────────────
  // rename
  const beforeRename = (await j('GET', '/api/library')).json.sets.find(s => s.setId === SID);
  const ren = await j('PUT', `/api/library/${SID}`, { name: 'Smoke Renamed', version: beforeRename.version }, AS_ALICE);
  assert(ren.status === 200 && ren.json.set.name === 'Smoke Renamed', 'rename updates the set name');
  assert(ren.json.set.version === beforeRename.version + 1, 'rename bumps the index version');
  // stale rename -> 409
  const staleRen = await j('PUT', `/api/library/${SID}`, { name: 'Nope', version: beforeRename.version }, AS_ALICE);
  assert(staleRen.status === 409, 'stale rename returns 409');

  // duplicate: new set, fresh row uids, original untouched
  await j('POST', `/api/sets/${SID}/variables`, { type: 'string', display_name: 'Dup Me' }, AS_ALICE);
  const dup = await j('POST', `/api/library/${SID}/duplicate`, { name: 'Smoke Copy' }, AS_ALICE);
  assert(dup.status === 201 && dup.json.set.setId !== SID, 'duplicate creates a new set');
  const dupVars = (await j('GET', `/api/sets/${dup.json.set.setId}/variables`)).json.variables;
  const origVars = (await j('GET', `/api/sets/${SID}/variables`)).json.variables;
  assert(dupVars.length === origVars.length, 'duplicate copied all rows');

  // isolation: two sets with same-named vars don't collide; editing one doesn't bump the other
  const other = await j('POST', '/api/library', { name: 'Other' }, AS_ALICE);
  const OID = other.json.set.setId;
  const otherRevA = (await j('GET', `/api/sets/${OID}/variables`)).json.revision;
  await j('POST', `/api/sets/${SID}/variables`, { type: 'string', display_name: 'Only In S' }, AS_ALICE);
  const otherRevB = (await j('GET', `/api/sets/${OID}/variables`)).json.revision;
  assert(otherRevA === otherRevB, 'editing set S does not change set Other revision');

  // soft-delete + restore
  const del = await j('DELETE', `/api/library/${OID}`, undefined, AS_ALICE);
  assert(del.status === 200, 'DELETE soft-deletes a set');
  assert(!(await j('GET', '/api/library')).json.sets.some(s => s.setId === OID), 'deleted set gone from index');
  assert((await j('GET', `/api/sets/${OID}/variables`)).status === 404, 'GET deleted set -> 404 set_not_found');
  const restore = await j('POST', `/api/library/${OID}/restore`, {}, AS_ALICE);
  assert(restore.status === 201, 'restore brings the set back');
  assert((await j('GET', '/api/library')).json.sets.some(s => s.setId === OID), 'restored set back in index');

  // deleted-set variable write -> 404
  await j('DELETE', `/api/library/${OID}`, undefined, AS_ALICE);
  const writeGone = await j('POST', `/api/sets/${OID}/variables`, { type: 'string', display_name: 'x' }, AS_ALICE);
  assert(writeGone.status === 404, 'writing to a deleted set -> 404');
```

- [ ] **Step 4: Run the full smoke suite**

Run: `npm run smoke`
Expected: `All N assertions passed.` (N ≥ 34 + the ~15 new library asserts).

- [ ] **Step 5: Commit**

```bash
git add test/smoke.js test/run-smoke.js package.json
git commit -m "test: self-contained smoke suite covering sets + library CRUD"
```

### Task 13: Playwright two-view / two-user browser test

**Files:**
- Create: `test/browser.mjs` (or extend an existing Playwright test if one exists — check `test/` first)

- [ ] **Step 1: Check for an existing Playwright harness**

Run: `ls test/ && grep -rl playwright package.json test/ 2>/dev/null`
If a browser test already exists, extend it; otherwise create `test/browser.mjs` using the same launch pattern as `test/run-smoke.js` (throwaway server + temp dir).

- [ ] **Step 2: Write the scenario (two contexts = two users)**

Key assertions (write with your available Playwright API — `chromium.launch()`, `browser.newContext()` ×2):

1. Home renders; **+ New set** → editor opens with the empty-state copy "No variables yet".
2. Add a variable in context A; **← Library**; the card shows "1 vars".
3. Both contexts open the **same** set; A focuses a row → B sees the pulsing "editing" avatar within ~5s (presence per-set).
4. Open two **different** sets in A and B → neither sees the other's presence badge on their row.
5. In A, delete the set B has open (via a second tab or the library card) → B gets the "deleted by someone else" alert, returns to the library, and `localStorage` has a `draft_<setId>` entry. No uncaught console errors throughout.

- [ ] **Step 3: Run it**

Run: `node test/browser.mjs` (or the project's Playwright invocation)
Expected: all steps pass, exit 0, zero console errors.

- [ ] **Step 4: Commit**

```bash
git add test/browser.mjs
git commit -m "test: Playwright two-view/two-user sets scenario"
```

### Task 14: Update README + memory

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the model + API sections**

- Change "One canonical list" framing to "a library of named **sets**; open one to edit it live."
- Replace the API table's `/api/variables*` rows with the `/api/library*` and `/api/sets/:setId/variables*` routes from Phase 2.
- Add the `X-VB-Set` header to the identity-headers note.
- Note the migration: an existing `variables.json` is folded into a first set on boot and renamed to `.bak`.
- Update the Files list: add `lib/store.js`, `test/store.test.js`, `test/run-smoke.js`.
- Update run instructions: `npm run test:unit` (store unit tests) + `npm run smoke` (now self-contained).

- [ ] **Step 2: Verify the doc references match reality**

Run: `grep -n "api/variables\b" README.md`
Expected: no bare `/api/variables` references remain (all are set-scoped or library routes).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document sets/library model, routes, and migration"
```

- [ ] **Step 4: Deploy note (manual, only when the user asks)**

Per the workspace rule, do **not** push or deploy without an explicit request. When asked:
```bash
railway up          # from the project dir (already linked); migration runs on boot
```
The existing `/data` volume is unchanged; the first boot after deploy folds the live `variables.json` into a set and writes `library.json`.

---

## Self-review

**Spec coverage** (checked against `2026-07-29-variable-sets-library-design.md`):
- §3 data model → Tasks 1-4 (library.json, sets/<uuid>.json, trash, verbatim seq). ✓
- §4 API surface → Tasks 6-8 (library CRUD, set-scoped routes, X-VB-Set, health revision). ✓
- §5 migration (idempotent, backup-last, corrupt/empty handling, fresh=empty) → Task 4. ✓
- §6 concurrency (pre-load all, await-free) → Tasks 1-3 (`loadAll`, synchronous mutations). ✓
- §7 presence per-set (presenceBySet, counts, leave via reverse index) → Task 5. ✓
- §8 client (currentSetId, per-set storage, two views, empty-state copy, breadcrumb) → Tasks 9-11. ✓
- §9 edge cases: #1/#3 delete-while-editing + draft → `onSetDeleted` (Task 11); #2 rename 409 (Tasks 6,11); #4 duplicate atomic snapshot (Task 3); #5/#8 poll 404 never-backoff (Task 11); #6 empty library (Tasks 10,11); #9 UUID (Task 2). ✓
- §10 testing → Tasks 12-13. ✓
- §11 deploy note → Task 14. ✓

**Placeholder scan:** no TBD/TODO; every code step shows real code. Browser test (Task 13) intentionally describes assertions rather than pinning an exact Playwright API, because the project's Playwright setup is verified in Step 1 first — the scenario and assertions are concrete.

**Type/name consistency:** store API names used identically across tasks — `configure, boot, loadLibrary, loadAll, listSets, indexEntry, getStore, persistSet, createSet, renameSet, deleteSet, restoreSet, duplicateSet` (defined Tasks 1-4, consumed Tasks 5-8). Client: `currentSetId, loadLibrary, openSet, goHome, onSetDeleted, applyViewMode, renderLibrary, cacheKey(), viewKey()` consistent across Tasks 9-11. `persistSet(setId, who)` signature stable. Wire shapes: library routes return `{ set, revision }`; set-var routes return `{ variable(s), revision, presence }` — matches client expectations.

**Scope:** one feature, one deployable increment; phases are independently testable (Phase 1 unit-tested with no server; Phase 2 smoke-checkable by curl; Phase 3 browser-verified).
