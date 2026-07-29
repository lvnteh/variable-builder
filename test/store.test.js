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

// Seed a legacy variables.json shaped exactly like today's single-list store.
function seedLegacy(dir, seq, rows) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'variables.json'), JSON.stringify({ seq, rows }));
}

// ── Task 1: paths + atomic IO ────────────────────────────────────────────────
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

// ── Task 2: createSet / getStore / persistSet / library index ────────────────
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
  store2.loadLibrary();
  store2.loadAll();
  assert.equal(store2.getStore(set.setId).rows.length, 1);
});

test('getStore returns null for an unknown set', () => {
  const dir = freshDir();
  const store = loadStore(dir);
  assert.equal(store.getStore('nope'), null);
});

// ── Task 3: rename / soft-delete / restore / duplicate + loadAll ─────────────
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

test('renameSet preserves spaces in the name (control-char strip only)', () => {
  const dir = freshDir();
  const store = loadStore(dir);
  const set = store.createSet('Old', 'Alice');
  const r = store.renameSet(set.setId, 'Smoke Renamed', 1, 'Bob');
  assert.equal(r.ok, true);
  assert.equal(r.entry.name, 'Smoke Renamed', 'spaces preserved');
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
  store2.loadLibrary();
  store2.loadAll();
  assert.ok(store2.getStore(a.setId), 'set A reloaded');
  assert.ok(store2.getStore(b.setId), 'set B reloaded');
  assert.equal(store2.listSets().length, 2);
});

// ── Task 4: migration + boot ─────────────────────────────────────────────────
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
