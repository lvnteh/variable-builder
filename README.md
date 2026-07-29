# Variable Builder

A tiny collaborative app for building a **comprehensive, shared variable list**
with stakeholders. One canonical list lives on the server; everyone edits it
together in the browser. Export the result as JSON (`{ custom: [...] }`).

Originally a single-file local tool (state in `localStorage`); now server-backed
so multiple contributors edit **one shared list** instead of trading JSON files.

## What it does

- Add variables of 6 types: `string`, `integer`, `decimal`, `color`, `image`, `select`.
- Inline-edit `display_name`, `default_value`, `category`, `is_overridable`, and
  (for `select`) an options table of `{ id, value, name }`.
- Live JSON preview, **Copy**, **Download**, and **Import** (append) JSON.
- **Shared state**: edits save to the server per-variable; other contributors'
  changes appear within a few seconds (polling), without disrupting the field
  you're typing in.
- **Safe concurrency**: each variable has its own version. Two people editing
  *different* variables never conflict; editing the *same* one shows a conflict
  and reloads just that row.
- **Presence & attribution**: pick a display name once; every row shows a small
  avatar for *who last edited it and when*, and a header cluster shows *who else
  is here right now*. The row someone is actively editing gets a pulsing avatar
  and a highlighted edge, so contributors don't stomp each other. Names are
  anonymous-but-chosen (no accounts); attribution is stored server-side but
  **never included in the exported JSON**.

## Architecture

```
browser (variable-builder.html)
   │  GET/POST/PUT/DELETE /api/variables
   ▼
Express (server.js)  ──►  JSON file, one record per variable (own version)
                                └── file on the Railway Volume (durable)
shared/validate.js   ← loaded by BOTH server and client (one schema, no drift)
shared/defaults.js   ← seed list, inserted server-side once when empty
```

> **Why a JSON file, not a database?** Node serves one request at a time, and
> the version check→write critical section has no `await`, so it's atomic
> without SQL. Writes go through a temp file + `rename()` (atomic on POSIX) so a
> crash can't corrupt the store. Zero native dependencies — builds nowhere,
> runs on any Node version and on Railway out of the box.

### API

| Method | Path                     | Purpose |
|--------|--------------------------|---------|
| GET    | `/health`                | Railway health check |
| GET    | `/api/variables`         | All variables + a `revision` token + live `presence` |
| POST   | `/api/variables`         | Create one (returns record with `uid`, `version`) |
| PUT    | `/api/variables/:uid`    | Update one — body `{ version, data }`; `409` on stale version |
| DELETE | `/api/variables/:uid`    | Delete one |
| PUT    | `/api/order`             | Persist row order — body `{ order: [uid,...] }` |
| POST   | `/api/variables/bulk`    | Import (append) — body `{ variables\|custom: [...] }` |
| DELETE | `/api/variables`         | Clear all |
| POST   | `/api/presence`          | Heartbeat / immediate presence update; `?leave=1&id=` drops a client |

> **Identity headers**: the client sends `X-VB-Client` (a `personId:tabId`
> token — persisted person id + a per-tab id so two tabs don't clobber each
> other), `X-VB-Name` (the display name, percent-encoded so non-Latin1 names are
> ByteString-safe), and `X-VB-Editing` (the uid of the row it's focused on).
> Presence is **ephemeral** (in-memory, 12s TTL) and never affects the data
> `revision`; attribution is persisted as row metadata, excluded from `data`.

## Run locally

```bash
npm install
npm start            # http://localhost:3000  (store at ./data/variables.json)
npm run smoke        # scripted API + concurrency test (server must be running)
```

Open two browser windows on `localhost:3000` to see shared editing.

## Deploy to Railway

1. Push this folder to a Git repo and create a Railway service from it
   (or `railway up` with the CLI). Nixpacks builds it from `package.json`.
2. **Attach a Volume** to the service and mount it (e.g. at `/data`). This is
   required — Railway's container disk is ephemeral and would lose all data on
   each redeploy. `server.js` reads `RAILWAY_VOLUME_MOUNT_PATH` automatically.
3. Health check path is `/health` (already set in `railway.toml`).
4. Open the generated URL and share it with your stakeholders.

> **Access**: the MVP is open (anyone with the link can read + edit). If the
> link spreads beyond a trusted group, add a shared-secret check on the write
> routes in `server.js`. Data integrity is already protected by version checks.

## Files

- `variable-builder.html` — the editor UI + client logic (filter/sort, presence, attribution).
- `server.js` — Express + JSON-file backend (per-variable versioning, presence map).
- `shared/validate.js` — type coercion, id-uniqueness, validation (client + server).
- `shared/defaults.js` — the 21 seed variables.
- `railway.toml` — build/deploy/health config.
- `test/smoke.js` — local API + concurrency + attribution/presence smoke test (34 assertions).
