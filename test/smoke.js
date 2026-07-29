/*
 * test/smoke.js — API + concurrency smoke test. Requires the server running.
 * Usage:  npm start   (in one shell)
 *         npm run smoke  (in another)
 *
 * Exits non-zero on the first failed assertion.
 */
'use strict';

const BASE = process.env.BASE || 'http://localhost:3000';
const V = require('../shared/validate.js');
let passed = 0;

function assert(cond, msg) {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  passed++;
  console.log(`✓ ${msg}`);
}

async function j(method, path, body, headers) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign(
      body !== undefined ? { 'Content-Type': 'application/json' } : {},
      headers || {}
    ),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const AS_ALICE = { 'X-VB-Client': 'test-alice', 'X-VB-Name': 'Alice' };
const AS_BOB   = { 'X-VB-Client': 'test-bob',   'X-VB-Name': 'Bob'   };

(async () => {
  // health
  const h = await j('GET', '/health');
  assert(h.status === 200 && h.json.ok, 'GET /health returns ok');

  // seeded list
  const list = await j('GET', '/api/variables');
  assert(list.status === 200 && Array.isArray(list.json.variables), 'GET /api/variables returns an array');
  assert(list.json.variables.length >= 21, `seeded with ${list.json.variables.length} defaults (>=21)`);
  const rev0 = list.json.revision;
  assert(typeof rev0 === 'string', 'list has a revision token');

  // create
  const created = await j('POST', '/api/variables', { type: 'integer', display_name: 'Test Count', default_value: '42' });
  assert(created.status === 201 && created.json.variable.uid, 'POST creates a variable with a uid');
  const uid = created.json.variable.uid;
  assert(created.json.variable.default_value === 42, 'integer default_value coerced to number (42)');
  assert(created.json.variable.version === 1, 'new variable starts at version 1');
  assert(created.json.revision !== rev0, 'revision changed after create');

  // update with correct version
  const upd = await j('PUT', `/api/variables/${uid}`, {
    version: 1,
    data: { type: 'integer', display_name: 'Test Count', default_value: '43', id: 'test_count' },
  });
  assert(upd.status === 200 && upd.json.variable.version === 2, 'PUT with correct version bumps to v2');
  assert(upd.json.variable.default_value === 43, 'updated integer coerced to 43');

  // stale update -> 409 with current record (the collaboration guarantee)
  const stale = await j('PUT', `/api/variables/${uid}`, {
    version: 1, data: { type: 'integer', display_name: 'Stale', default_value: '99' },
  });
  assert(stale.status === 409, 'PUT with stale version returns 409');
  assert(stale.json.variable.version === 2, '409 body carries the current (v2) record');

  // xss-ish payload survives round-trip as data (escaping is a render concern)
  const xss = await j('POST', '/api/variables', {
    type: 'string', display_name: 'XSS', default_value: '"><img src=x onerror=alert(1)>',
  });
  assert(xss.status === 201 && xss.json.variable.default_value.includes('<img'),
    'payload stored verbatim (client escapes at render)');

  // unknown type coerced to string
  const bad = await j('POST', '/api/variables', { type: 'wat', display_name: 'Bad Type' });
  assert(bad.json.variable.type === 'string', 'unknown type coerced to string');

  // invalid numeric default -> '' (never a stray string where a number is due)
  const badNum = await j('POST', '/api/variables', { type: 'integer', display_name: 'Bad Num', default_value: 'abc' });
  assert(badNum.json.variable.default_value === '', 'invalid integer default coerced to empty string');

  // bulk import appends + uniquifies ids
  const before = (await j('GET', '/api/variables')).json.variables.length;
  const bulk = await j('POST', '/api/variables/bulk', {
    variables: [
      { type: 'color', display_name: 'Accent Color', default_value: '#111111' }, // collides with seed id
      { type: 'color', display_name: 'Accent Color', default_value: '#222222' }, // collides with itself
    ],
  });
  assert(bulk.status === 201 && bulk.json.added === 2, 'bulk import adds 2');
  const after = bulk.json.variables;
  assert(after.length === before + 2, 'bulk import appended (did not replace)');
  const accentIds = after.filter(v => v.display_name === 'Accent Color').map(v => v.id);
  assert(new Set(accentIds).size === accentIds.length, `duplicate display_names got unique ids: ${accentIds.join(', ')}`);

  // ── Attribution: creator + editor are stamped, kept in _meta (not exported) ──
  const cAttr = await j('POST', '/api/variables',
    { type: 'string', display_name: 'Attrib Test' }, AS_ALICE);
  assert(cAttr.status === 201, 'POST as Alice creates a variable');
  const auid = cAttr.json.variable.uid;
  assert(cAttr.json.variable._meta && cAttr.json.variable._meta.created_by === 'Alice',
    'created_by stamped from X-VB-Name (Alice)');
  assert(cAttr.json.variable._meta.updated_by === 'Alice', 'updated_by == creator on create');
  assert(!('_meta' in V.toExport(cAttr.json.variable)),
    '_meta is not in the export shape (never leaks into exported JSON)');

  const eAttr = await j('PUT', `/api/variables/${auid}`, {
    version: cAttr.json.variable.version,
    data: { type: 'string', display_name: 'Attrib Test', default_value: 'x', id: 'attrib_test' },
  }, AS_BOB);
  assert(eAttr.status === 200, 'PUT as Bob succeeds');
  assert(eAttr.json.variable._meta.updated_by === 'Bob', 'updated_by becomes the editor (Bob)');
  assert(eAttr.json.variable._meta.created_by === 'Alice', 'created_by is preserved across edits (Alice)');
  await j('DELETE', `/api/variables/${auid}`, undefined, AS_ALICE);

  // ── Presence: GET heartbeats the caller; /api/presence lists who is here ──
  await j('GET', '/api/variables', undefined, AS_ALICE);
  await j('GET', '/api/variables', undefined, AS_BOB);
  const pres = await j('POST', '/api/presence', undefined, AS_ALICE);
  assert(Array.isArray(pres.json.presence), '/api/presence returns a presence array');
  const ids = pres.json.presence.map(p => p.id);
  assert(ids.includes('test-alice') && ids.includes('test-bob'),
    'presence lists both recent clients');
  const alice = pres.json.presence.find(p => p.id === 'test-alice');
  assert(alice && alice.name === 'Alice', 'presence carries the display name');

  // non-Latin1 name arrives percent-encoded and is decoded server-side
  const cjk = await j('POST', '/api/presence', undefined,
    { 'X-VB-Client': 'test-cjk', 'X-VB-Name': encodeURIComponent('田中さん') });
  const cjkEntry = cjk.json.presence.find(p => p.id === 'test-cjk');
  assert(cjkEntry && cjkEntry.name === '田中さん', 'percent-encoded non-Latin1 name decoded server-side');
  await j('POST', `/api/presence?leave=1&id=test-cjk`, undefined, {});

  // editing indicator rides the X-VB-Editing header
  const someVar = (await j('GET', '/api/variables')).json.variables[0];
  await j('POST', '/api/presence', undefined,
    Object.assign({ 'X-VB-Editing': String(someVar.uid) }, AS_BOB));
  const pres2 = await j('POST', '/api/presence', undefined, AS_ALICE);
  const bob = pres2.json.presence.find(p => p.id === 'test-bob');
  assert(bob && bob.editingUid === someVar.uid, 'presence reports which row a client is editing');

  // leave beacon removes a client immediately
  await j('POST', `/api/presence?leave=1&id=test-bob`, undefined, {});
  const pres3 = await j('POST', '/api/presence', undefined, AS_ALICE);
  assert(!pres3.json.presence.some(p => p.id === 'test-bob'),
    'leave beacon removes the client from presence');

  // presence must NOT change the data revision (it is ephemeral)
  const revA = (await j('GET', '/api/variables')).json.revision;
  await j('POST', '/api/presence', undefined, AS_ALICE);
  const revB = (await j('GET', '/api/variables')).json.revision;
  assert(revA === revB, 'presence activity does not bump the data revision');

  // delete
  const del = await j('DELETE', `/api/variables/${uid}`);
  assert(del.status === 200, 'DELETE removes a variable');
  const del404 = await j('DELETE', `/api/variables/${uid}`);
  assert(del404.status === 404, 'second DELETE returns 404');

  console.log(`\nAll ${passed} assertions passed.`);
})().catch(e => { console.error(e); process.exit(1); });
