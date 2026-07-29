/*
 * server.js — tiny collaborative backend for the Variable Builder.
 *
 * Serves the single-file editor (variable-builder.html) and owns the ONE
 * canonical variable list that all stakeholders edit together.
 *
 * Storage: a plain JSON file, holding an array of records — one per variable,
 * each with its own integer `version`. Row-per-variable versioning is the
 * collaboration-quality choice: two people editing DIFFERENT variables never
 * conflict; only editing the SAME variable concurrently produces a 409, and
 * only that one row reloads.
 *
 * Why JSON-file and not a DB: Node serves one request at a time on the event
 * loop, and the critical section (read version -> compare -> write) has no
 * `await` in it, so it is effectively atomic without SQL. Writes go to a temp
 * file then rename() (atomic on POSIX) so a crash mid-write can't corrupt the
 * store. Zero native dependencies => builds nowhere, runs everywhere.
 *
 * The JSON file lives on the Railway Volume (RAILWAY_VOLUME_MOUNT_PATH), NOT
 * the ephemeral container disk — otherwise every redeploy would wipe all work.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const V = require('./shared/validate.js');
const DEFAULTS = require('./shared/defaults.js');

// ── Paths ──────────────────────────────────────────────────────────────────
const ROOT = __dirname;
// Railway sets RAILWAY_VOLUME_MOUNT_PATH to the mounted volume (e.g. /data).
// Locally we fall back to ./data so `npm start` just works.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data');
const STORE_PATH = path.join(DATA_DIR, 'variables.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── In-memory store (source of truth in-process; mirrored to disk) ───────────
// Each record: { uid, position, version, data: <coerced variable>, meta }
//   meta = { created_by, created_at, updated_by, updated_at } — WHO/WHEN, kept
//   OUT of `data` so attribution never leaks into the exported variable JSON.
let store = { seq: 0, rows: [] };

const now = () => new Date().toISOString();

// ── Identity + presence ──────────────────────────────────────────────────────
// Contributors are anonymous but self-identified: the client sends a stable
// clientId + a chosen display name (+ the row it's editing) as request headers.
// Presence is EPHEMERAL — an in-memory map, TTL'd — so it never persists to disk
// and never affects the data revision. This keeps polling focus-safe: presence
// rides alongside the list and is read every poll regardless of `revision`.
const PRESENCE_TTL_MS = 12000;             // a client not seen in 12s drops off
const presence = new Map();                // clientId -> { name, editingUid, lastSeen }

// Pull identity off a request. Names are clamped + stripped of control chars;
// the client still escapes on render, this is defense in depth.
function identity(req) {
  const id = String(req.get('X-VB-Client') || '').slice(0, 64);
  // Name is percent-encoded by the client (ByteString-safe transport of
  // non-Latin1 names). Decode defensively, then strip control chars + clamp.
  const rawName = req.get('X-VB-Name') || '';
  let decoded;
  try { decoded = decodeURIComponent(rawName); } catch { decoded = rawName; }
  let name = decoded.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  const editingRaw = req.get('X-VB-Editing');
  const editingUid = editingRaw != null && editingRaw !== '' ? Number(editingRaw) : null;
  return { id, name, editingUid: Number.isInteger(editingUid) ? editingUid : null };
}

// Record that a client is alive (and optionally what row it's editing). Called
// on EVERY request from an identified client, so any poll is also a heartbeat.
function markPresence(req) {
  const { id, name, editingUid } = identity(req);
  if (!id) return null;
  const prev = presence.get(id);
  presence.set(id, {
    name: name || (prev && prev.name) || 'Someone',
    editingUid,
    lastSeen: Date.now(),
  });
  return id;
}

// Everyone seen within the TTL, freshest first. Prunes stale entries as it goes.
function presenceList() {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  const out = [];
  for (const [id, p] of presence) {
    if (p.lastSeen < cutoff) { presence.delete(id); continue; }
    out.push({ id, name: p.name, editingUid: p.editingUid });
  }
  return out;
}

function persist() {
  const tmp = STORE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, STORE_PATH);          // atomic replace
}

function load() {
  if (!fs.existsSync(STORE_PATH)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (parsed && Array.isArray(parsed.rows)) {
      store = { seq: Number(parsed.seq) || 0, rows: parsed.rows };
      return true;
    }
  } catch (e) {
    console.error('[load] corrupt store, starting fresh:', e.message);
  }
  return false;
}

// ── Seed once when the store is empty ────────────────────────────────────────
function seedIfEmpty() {
  if (store.rows.length > 0) return;
  const t = now();
  DEFAULTS.forEach((raw, i) => {
    const v = V.coerceVariable(raw);
    v.id = V.toSnakeCase(v.display_name);
    store.rows.push({
      uid: ++store.seq, position: i, version: 1, data: v,
      meta: { created_by: 'seed', created_at: t, updated_by: 'seed', updated_at: t },
    });
  });
  persist();
  console.log(`[seed] inserted ${DEFAULTS.length} default variables`);
}

load();
seedIfEmpty();

// ── Row helpers ──────────────────────────────────────────────────────────────
// The record on the wire carries data + uid/version + a `_meta` attribution
// block. `_meta` is underscored so the client can strip it before export and
// exclude it from the data-equality diff used by the reconcile engine.
function rowToRecord(row) {
  return Object.assign({}, row.data, {
    uid: row.uid,
    version: row.version,
    _meta: row.meta || null,
  });
}

function sortedRows() {
  return store.rows.slice().sort((a, b) => (a.position - b.position) || (a.uid - b.uid));
}

function listRecords() {
  return sortedRows().map(rowToRecord);
}

function findRow(uid) {
  return store.rows.find(r => r.uid === uid);
}

function maxPosition() {
  return store.rows.reduce((m, r) => Math.max(m, r.position), -1);
}

// Global list revision: uid sequence + per-row versions. Because `seq` only
// ever increases (even across deletes) and every edit bumps a row version,
// any create/update/delete strictly changes this token — pollers never miss a
// change to a token collision.
function listRevision() {
  const versionSum = store.rows.reduce((s, r) => s + r.version, 0);
  return `${store.seq}:${store.rows.length}:${versionSum}`;
}

// ── App ────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));

// Minimal hardening: a Content-Security-Policy that still allows the SAP CDN
// fonts the editor uses. Blocks inline/injected script origins beyond our own.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",           // inline app script in the HTML
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://ui5.sap.com https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// Health check for Railway.
app.get('/health', (req, res) => res.status(200).json({ ok: true, revision: listRevision() }));

// Silence favicon 404s (no icon asset; avoids error spam on every poll).
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── API ──────────────────────────────────────────────────────────────────────

// GET all variables + a list revision token + live presence. This doubles as a
// heartbeat: every poll marks the caller present, so no separate ping is needed.
app.get('/api/variables', (req, res) => {
  markPresence(req);
  res.json({ variables: listRecords(), revision: listRevision(), presence: presenceList() });
});

// POST just presence — used for immediate updates (focus change, name change,
// leaving the page) between the 4s data polls, so "X is editing this" is snappy.
// `?leave=1&id=<clientId>` (used by sendBeacon on unload, which can't set
// headers) removes the client immediately so its "editing" flag clears fast.
app.post('/api/presence', (req, res) => {
  if (req.query.leave && req.query.id) {
    presence.delete(String(req.query.id).slice(0, 64));
    return res.json({ ok: true, presence: presenceList() });
  }
  markPresence(req);
  res.json({ presence: presenceList() });
});

// POST a new variable. Body: a raw variable (no uid). Returns the created record.
app.post('/api/variables', (req, res) => {
  const id = markPresence(req);
  const who = (id && presence.get(id) && presence.get(id).name) || 'Someone';
  const t = now();
  const v = V.coerceVariable(req.body || {});
  const row = {
    uid: ++store.seq, position: maxPosition() + 1, version: 1, data: v,
    meta: { created_by: who, created_at: t, updated_by: who, updated_at: t },
  };
  store.rows.push(row);
  persist();
  res.status(201).json({ variable: rowToRecord(row), revision: listRevision() });
});

/*
 * PUT one variable — optimistic concurrency at ROW level.
 * Body: { version: <int>, data: <raw variable> }.
 * The read-compare-write below has no `await`, so under Node's single-threaded
 * event loop it is atomic: no interleaving PUT can slip between the version
 * check and the write.
 * If the stored version != body.version, someone else changed THIS variable
 * first: reply 409 with the current record so the client can reload just it.
 */
app.put('/api/variables/:uid', (req, res) => {
  const id = markPresence(req);
  const who = (id && presence.get(id) && presence.get(id).name) || 'Someone';
  const uid = Number(req.params.uid);
  const row = findRow(uid);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const clientVersion = Number((req.body || {}).version);
  if (!Number.isInteger(clientVersion)) {
    return res.status(400).json({ error: 'missing_version' });
  }
  if (clientVersion !== row.version) {
    return res.status(409).json({ error: 'version_conflict', variable: rowToRecord(row), revision: listRevision() });
  }

  row.data = V.coerceVariable((req.body || {}).data || {});
  row.version += 1;
  const created = row.meta || {};
  row.meta = {
    created_by: created.created_by || who,
    created_at: created.created_at || now(),
    updated_by: who,
    updated_at: now(),
  };
  persist();
  res.json({ variable: rowToRecord(row), revision: listRevision() });
});

// DELETE one variable.
app.delete('/api/variables/:uid', (req, res) => {
  markPresence(req);
  const uid = Number(req.params.uid);
  const before = store.rows.length;
  store.rows = store.rows.filter(r => r.uid !== uid);
  if (store.rows.length === before) return res.status(404).json({ error: 'not_found' });
  persist();
  res.json({ ok: true, revision: listRevision() });
});

// PUT order — persist a new row ordering. Body: { order: [uid, uid, ...] }.
app.put('/api/order', (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'missing_order' });
  order.forEach((uid, i) => {
    const row = findRow(Number(uid));
    if (row) row.position = i;
  });
  persist();
  res.json({ ok: true, revision: listRevision() });
});

/*
 * POST bulk import — APPEND (not replace), so an import can't nuke everyone's
 * list. Body: { variables: [...] } or { custom: [...] } or a bare array.
 * Each item is coerced; ids are made unique against the WHOLE resulting list.
 */
app.post('/api/variables/bulk', (req, res) => {
  const id = markPresence(req);
  const who = (id && presence.get(id) && presence.get(id).name) || 'Someone';
  const t = now();
  const body = req.body || {};
  let incoming = Array.isArray(body) ? body
    : Array.isArray(body.variables) ? body.variables
    : Array.isArray(body.custom) ? body.custom
    : null;
  if (!incoming) return res.status(400).json({ error: 'expected_array' });

  const existing = listRecords();
  const coerced = incoming.map(V.coerceVariable);
  // Unique-ify across existing + incoming, only reassigning the NEW ones.
  const combined = existing.concat(coerced);
  const uniqueIds = V.ensureUniqueIds(combined);
  coerced.forEach((v, i) => { v.id = uniqueIds[existing.length + i]; });

  let pos = maxPosition();
  coerced.forEach(v => {
    store.rows.push({
      uid: ++store.seq, position: ++pos, version: 1, data: v,
      meta: { created_by: who, created_at: t, updated_by: who, updated_at: t },
    });
  });
  persist();
  res.status(201).json({ variables: listRecords(), revision: listRevision(), added: coerced.length });
});

// DELETE all — clear the shared list. (Explicit, guarded on the client.)
app.delete('/api/variables', (req, res) => {
  store.rows = [];
  persist();
  res.json({ ok: true, revision: listRevision() });
});

// ── Static: serve the editor + shared modules ────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'variable-builder.html')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use(express.static(ROOT, { index: false, extensions: ['html'] }));

// ── Listen ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Variable Builder listening on :${PORT}  (store: ${STORE_PATH})`);
});
