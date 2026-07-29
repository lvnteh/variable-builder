# Variable Builder

A tiny collaborative app for building **comprehensive, shared variable lists**
with stakeholders. The server holds a **library of named _sets_**; open one to
edit it live with everyone else. Export any set as JSON (`{ custom: [...] }`).

Originally a single-file local tool (state in `localStorage`); now server-backed
so multiple contributors edit **shared sets** instead of trading JSON files.

## What it does

- A **library** home screen lists every set (name, variable count, who last
  edited it, and a live "who's here" count). Create, open, duplicate, rename, or
  soft-delete sets. Deletes move to a `.trash/` folder and can be restored.
- Open a set to edit it in place — **live auto-save**, exactly like the old
  single list, just scoped to that set.
- Add variables of 6 types: `string`, `integer`, `decimal`, `color`, `image`, `select`.
- Inline-edit `display_name`, `default_value`, `category`, `is_overridable`, and
  (for `select`) an options table of `{ id, value, name }`.
- Live JSON preview, **Copy**, **Download**, and **Import** (append) JSON.
- **Shared state**: edits save to the server per-variable; other contributors'
  changes appear within a few seconds (polling), without disrupting the field
  you're typing in.
- **Safe concurrency**: each variable has its own version. Two people editing
  *different* variables — or *different sets* — never conflict; editing the
  *same* one shows a conflict and reloads just that row.
- **Presence & attribution** (per-set): pick a display name once; every row shows
  a small avatar for *who last edited it and when*, and a header cluster shows
  *who else is here in this set right now*. The row someone is actively editing
  gets a pulsing avatar and a highlighted edge, so contributors don't stomp each
  other. Names are anonymous-but-chosen (no accounts); attribution is stored
  server-side but **never included in the exported JSON**.

## Architecture

```
browser (variable-builder.html)   two views: library home + set editor
   │  GET/POST/PUT/DELETE  /api/library  and  /api/sets/:setId/variables
   ▼
Express (server.js)  ──►  lib/store.js  ──►  library.json  (the set index)
                                          └─ sets/<uuid>.json  (one file per set)
                                          └─ sets/.trash/<uuid>.json  (soft-deleted)
                                            all on the Railway Volume (durable)
shared/validate.js   ← loaded by BOTH server and client (one schema, no drift)
shared/defaults.js   ← only used by legacy migration (see below)
```

All sets are **pre-loaded into memory at boot** so the version check→write
critical section stays synchronous (no `await`), preserving atomicity.

> **Why JSON files, not a database?** Node serves one request at a time, and the
> version check→write critical section has no `await`, so it's atomic without
> SQL. Writes go through a temp file + `rename()` (atomic on POSIX) so a crash
> can't corrupt the store. Zero native dependencies — builds nowhere, runs on any
> Node version and on Railway out of the box.

### Migration

On boot, if a legacy single-list `variables.json` is present (and hasn't been
migrated yet), it is folded into a first set named **"AI Brand Identity"** and
the legacy file is renamed to `variables.json.bak` (the commit marker — makes the
migration idempotent). A fresh deploy with no legacy file starts with an **empty
library**. Migration runs synchronously **before** the socket binds, so no
request can arrive mid-migration.

### API

**Library (set index):**

| Method | Path                              | Purpose |
|--------|-----------------------------------|---------|
| GET    | `/api/library`                    | Every set's index entry + live presence count + `revision` |
| POST   | `/api/library`                    | Create an **empty** set — body `{ name }` |
| PUT    | `/api/library/:setId`             | Rename — body `{ name, version }`; `409` on stale index version |
| DELETE | `/api/library/:setId`             | Soft-delete (moves file to `.trash/`) |
| POST   | `/api/library/:setId/restore`     | Restore a soft-deleted set from `.trash/` |
| POST   | `/api/library/:setId/duplicate`   | Server-side atomic copy (fresh row uids) — body `{ name? }` |

**Set-scoped variables** (1:1 with the old routes, `/api/sets/:setId` prefixed;
a missing set is `404 {error:"set_not_found"}`):

| Method | Path                                    | Purpose |
|--------|-----------------------------------------|---------|
| GET    | `/api/sets/:setId/variables`            | All variables in the set + `revision` + live `presence` |
| POST   | `/api/sets/:setId/variables`            | Create one (returns record with `uid`, `version`) |
| PUT    | `/api/sets/:setId/variables/:uid`       | Update one — body `{ version, data }`; `409` on stale version |
| DELETE | `/api/sets/:setId/variables/:uid`       | Delete one |
| PUT    | `/api/sets/:setId/order`                | Persist row order — body `{ order: [uid,...] }` |
| POST   | `/api/sets/:setId/variables/bulk`       | Import (append) — body `{ variables\|custom: [...] }` |
| DELETE | `/api/sets/:setId/variables`            | Clear the set |

**Presence & health:**

| Method | Path              | Purpose |
|--------|-------------------|---------|
| GET    | `/health`         | Railway health check; `revision` reflects the library-level token |
| POST   | `/api/presence`   | Heartbeat / immediate presence update; `?leave=1&id=` drops a client |

> **Identity headers**: the client sends `X-VB-Client` (a `personId:tabId`
> token — persisted person id + a per-tab id so two tabs don't clobber each
> other), `X-VB-Name` (the display name, percent-encoded so non-Latin1 names are
> ByteString-safe), `X-VB-Editing` (the uid of the row it's focused on), and
> **`X-VB-Set`** (the open set's id — set-scoped routes carry it in the URL, so
> this header is only needed for `POST /api/presence` and the `sendBeacon` leave
> path). Presence is **per-set**, **ephemeral** (in-memory, 12s TTL), and never
> affects any `revision`; attribution is persisted as row metadata, excluded
> from `data`.

## Run locally

```bash
npm install
npm start            # http://localhost:3000  (data at ./data/)
npm run test:unit    # lib/store.js unit tests (no server needed)
npm run smoke        # self-contained API test (boots its own throwaway server)
npm run test:browser # Playwright two-user UI test (needs `npx playwright install chromium` once)
```

Open two browser windows on `localhost:3000` to see shared editing — create a
set, open it in both, and watch presence + live edits.

## Deploy to Railway

1. Push this folder to a Git repo and create a Railway service from it
   (or `railway up` with the CLI). Nixpacks builds it from `package.json`.
2. **Attach a Volume** to the service and mount it (e.g. at `/data`). This is
   required — Railway's container disk is ephemeral and would lose all data on
   each redeploy. `server.js` reads `RAILWAY_VOLUME_MOUNT_PATH` automatically.
   An existing `variables.json` on the volume is migrated into a set on first
   boot (see **Migration** above); the `/data` volume is otherwise unchanged.
3. Health check path is `/health` (already set in `railway.toml`).
4. Open the generated URL and share it with your stakeholders.

> **Access**: the MVP is open (anyone with the link can read + edit). If the
> link spreads beyond a trusted group, add a shared-secret check on the write
> routes in `server.js`. Data integrity is already protected by version checks.

## Files

- `variable-builder.html` — the editor UI + client logic (two views: library home + set editor, filter/sort, presence, attribution).
- `server.js` — Express routing + per-set presence + wire-format helpers.
- `lib/store.js` — pure, synchronous storage: library index, one file per set, soft-delete trash, legacy migration, in-memory set map.
- `shared/validate.js` — type coercion, id-uniqueness, validation (client + server).
- `shared/defaults.js` — the 21 seed variables (only used by legacy migration).
- `railway.toml` — build/deploy/health config.
- `test/store.test.js` — `lib/store.js` unit tests (migration, atomic IO, soft-delete/restore/duplicate).
- `test/smoke.js` — API + concurrency + library-CRUD smoke test (scoped to sets).
- `test/run-smoke.js` — boots a throwaway server on a temp dir + spare port, runs `smoke.js`, tears down.
- `test/browser.mjs` — Playwright two-user scenario (library ↔ editor, per-set presence, delete-recovery). Run `npm run test:browser` (needs `npx playwright install chromium` once).
