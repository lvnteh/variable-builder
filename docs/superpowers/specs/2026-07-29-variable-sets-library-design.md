# Variable Sets & Library — Design

**Date:** 2026-07-29
**Status:** Approved (design); pending implementation plan
**Feature:** Turn the single shared variable list into many named **sets**, shown
in a shared **library**. Any user can save the current list as a set, start a new
set, open/duplicate/rename/delete sets, and collaborate live within a set.

---

## 1. Problem & goals

Today the app owns **one** canonical variable list that everyone edits together
(`store = { seq, rows: [] }` in a single `data/variables.json`). Stakeholders want
to maintain **multiple** variable lists — e.g. one per campaign or brand — and
switch between them, while keeping the real-time collaboration the app was rebuilt
for.

**Goals**
- A **library** of named sets is the home screen; all sets are accessible to all.
- "Save the current list as a set" and "start a new set" are first-class actions.
- Opening a set makes it your live working list; edits **auto-save** exactly as
  today (no draft/Save-button model).
- Real-time collaboration continues **within** a set (per-variable versioning,
  presence, reconcile) — unchanged, just scoped.
- The 21 variables currently live migrate into the first set with no data loss.

**Non-goals**
- No accounts / auth (the app stays open, matching its current posture).
- No per-set permissions beyond guarded destructive actions.
- No global variable-id uniqueness across sets (sets are independent).

---

## 2. Locked decisions

| Decision | Choice |
|---|---|
| What a "set" is | A re-openable snapshot: archive by default, promote-to-live to edit |
| Whose "current set" | **Per-user** — each person opens their own; live collab when two open the same set |
| New set contents | **Empty** (blank canvas) |
| Save semantics | **Live auto-save**, updates the open set **in place** (no manual Save) |
| Storage layout | **One JSON file per set** + a shared `library.json` index |
| Set id | Server-generated **UUID** |
| Permissions | Open to all; destructive actions (rename/delete/clear) guarded by `confirm()` |
| Delete safety | **Soft-delete to `sets/.trash/`** (reversible for a grace period) |
| Existing 21 vars | **Migrate** into the first set, named "AI Brand Identity" |
| Home screen | **Library** is the landing view |
| Fresh deploy (no legacy) | **Empty library** + "create your first set" CTA |
| Concurrency | All sets **pre-loaded in memory**; handlers stay **await-free** (atomicity preserved) |
| Presence & view state | **Per-set** |

---

## 3. Data model

Storage on the Railway volume (`/data`):

```
/data
├── library.json              # shared index, one entry per set
├── sets/
│   ├── <uuid>.json           # one file per set
│   └── .trash/
│       └── <uuid>.json       # soft-deleted sets (restorable)
└── variables.json.bak        # legacy file, renamed after migration (never deleted)
```

### library.json — the index (source of truth for display)

```jsonc
{
  "seq": 1,                          // monotonic counter (informational; ids are UUIDs)
  "sets": [
    {
      "setId": "550e8400-e29b-41d4-a716-446655440000",
      "name": "AI Brand Identity",
      "version": 1,                  // optimistic-lock token for RENAME only
      "variable_count": 21,          // denormalized, display-only (recompute on open)
      "created_by": "migration",
      "created_at": "2026-07-29T...",
      "updated_by": "Alice",
      "updated_at": "2026-07-29T..."
    }
  ]
}
```

- `variable_count` is **denormalized** for cheap card rendering; it is updated on
  every variable create/delete/bulk/clear. Never trust it for logic — the set file
  is authoritative; recompute when the set is opened.
- **No presence field.** Presence is ephemeral/in-memory and must never be
  persisted (it would write to disk on every poll and pollute the revision). The
  library overlays live presence counts from the in-memory map at request time.

### sets/&lt;uuid&gt;.json — one set (mirrors today's store shape exactly)

```jsonc
{
  "setId": "550e8400-...",
  "name": "AI Brand Identity",       // denormalized copy; lets the index be rebuilt if lost
  "seq": 31,                          // per-set uid counter (was store.seq)
  "rows": [
    { "uid": 1, "position": 0, "version": 3,
      "data": { "id": "primary_brand_color", "display_name": "...", "default_value": "#1A1A2E",
                "is_overridable": true, "type": "color", "category": "AI Brand Identity" },
      "meta": { "created_by": "Alice", "created_at": "...", "updated_by": "cleanup", "updated_at": "..." } }
  ]
}
```

- The row shape (`uid, position, version, data, meta`) is **identical to today**, so
  the entire versioning/reconcile/attribution engine carries over unchanged.
- `seq` is **per-set** and copied **verbatim** on migration (today it is 31 for 21
  rows because deletes advanced it — that is correct; do not reset to row count).
- `uid` is unique **within a set**, not globally. Client structures keyed by uid
  (`saveTimers`, presence `editingUid`) are always scoped to the one open set.
- On the wire, `rowToRecord` keeps emitting `_meta` (underscored) unchanged — the
  client already strips it before export.

---

## 4. API surface

Set-scoped variable routes are **today's routes with `/api/sets/:setId` prefixed** —
same request bodies, same status codes, same per-variable 409 concurrency.

### Library CRUD (new)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/library` | — | `{ sets: [IndexEntry + live presence count], revision, presence }` |
| POST | `/api/library` | `{ name }` | `201 { set, revision }` — creates an **empty** set |
| PUT | `/api/library/:setId` | `{ name, version }` | `{ set, revision }` / `409` on stale index version |
| DELETE | `/api/library/:setId` | — | `{ ok }` / `404` — **soft-delete** (moves file to `.trash/`) |
| POST | `/api/library/:setId/restore` | — | `{ set, revision }` / `404` — restore from `.trash/` |
| POST | `/api/library/:setId/duplicate` | `{ name? }` | `201 { set, revision }` — server-side atomic copy, fresh row uids |

### Set-scoped variable routes (1:1 with current routes)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/sets/:setId/variables` | `{ variables, revision, presence }`; `404 {error:"set_not_found"}` if deleted |
| POST | `/api/sets/:setId/variables` | create; `201` |
| PUT | `/api/sets/:setId/variables/:uid` | optimistic concurrency; `409` with current record |
| DELETE | `/api/sets/:setId/variables/:uid` | `404` if row/set gone |
| PUT | `/api/sets/:setId/order` | `{ order: [uid, ...] }` |
| POST | `/api/sets/:setId/variables/bulk` | append semantics unchanged |
| DELETE | `/api/sets/:setId/variables` | clear set (guarded on client) |

### Presence & health

| Method | Path | Notes |
|---|---|---|
| POST | `/api/presence` | headers `X-VB-Client` / `X-VB-Name` / `X-VB-Editing` + **`X-VB-Set`**; `?leave=1&id=` beacon path unchanged |
| GET | `/health` | unchanged; `revision` reflects library-level token |

**Library revision token:** `${library.seq}:${sets.length}:${hash of set updated_at/counts}`
— changes on any create/rename/delete so the home screen polls for library changes
the same way the editor polls a set today.

**Header naming:** standardize on **`X-VB-Set`**. Set-scoped routes carry the setId
in the URL; the header is only needed for the header-only `POST /api/presence` and
the `sendBeacon` leave path.

---

## 5. Migration (idempotent, on boot)

Runs **synchronously before `app.listen()`** — the socket binds only after migration
completes, so no request can arrive mid-migration (no lock file needed).

```
1. mkdir -p DATA_DIR, DATA_DIR/sets, DATA_DIR/sets/.trash
2. shouldMigrate = exists(variables.json) && !exists(variables.json.bak) && !exists(library.json)
3. if shouldMigrate:
   a. read + JSON.parse(variables.json). If parse fails or rows empty →
      treat as NO legacy (log a warning; do NOT create a set from garbage).
   b. setId = uuid()
   c. write sets/<setId>.json.tmp = { setId, name:"AI Brand Identity",
        seq: <copied verbatim>, rows: <copied verbatim> }  → rename (atomic)
   d. write library.json.tmp = { seq:1, sets:[{ setId, name, version:1,
        variable_count: rows.length, created_by:"migration", created_at,
        updated_by:"migration", updated_at }] }  → rename (atomic)
   e. rename variables.json → variables.json.bak   ← COMMIT MARKER (last)
4. load library.json; pre-load every sets/<id>.json into the in-memory Map
5. if library.sets is empty → do nothing (empty library is valid)
6. sweep leftover *.tmp files (crash cleanup)
7. app.listen()
```

**Why backup last (step 3e):** the `.bak` rename is the transaction commit. If we
renamed the legacy file away *first* and then crashed before writing the set,
`shouldMigrate` would flip to false and orphan the data. Backing up last makes the
existence of `.bak` proof that the new files were written — safe to re-run.

**Fresh deploy (no legacy file):** `library.json` is created as `{seq:0, sets:[]}`.
The 21 defaults in `shared/defaults.js` are used **only** by legacy migration, never
on fresh boot (they were a single-list artifact, not a product requirement).

**Corrupt/empty legacy file** is treated as "no legacy" and logged — the app starts
with an empty library rather than failing to boot.

---

## 6. Concurrency & atomicity

Today's guarantee: the read-compare-write in `PUT /api/variables/:uid` has **no
`await`**, so Node's single-threaded event loop cannot interleave a second write
between the version check and the persist. This is why no database is needed.

**To preserve it:** pre-load all sets into an in-memory `Map<setId, store>` at boot.
- `getStore(setId)` → synchronous Map lookup.
- `findRow(setId, uid)` → synchronous `.find()`.
- `persistSet(setId)` → synchronous `writeFileSync` + `renameSync`.
- **Hard rule: never `await` inside a critical section.** Lazy-loading with
  `await` would open an event-loop tick between check and write and break atomicity.
  At this scale, pre-loading everything at boot is trivial and sidesteps the issue.

**New benefit:** two users editing *different* sets write to *different* files and
never serialize against each other. Same-set edits still 409 exactly as today.

**Library index atomicity:** `library.json` mutations (create/rename/delete/restore)
are also synchronous (Map + writeFileSync + rename), so they're atomic on the event
loop the same way. Rename additionally uses an optimistic `version` (last-write-wins
on a name is user-visibly wrong); create/delete are append/remove and don't need it.

---

## 7. Presence (per-set)

- `identity(req)` gains `setId` from the **`X-VB-Set`** header (or `req.params.setId`
  on set-scoped routes; `null` when on the library home screen).
- Storage: `presenceBySet = Map<setId, Map<clientId, {name, editingUid, lastSeen}>>`.
  TTL stays 12s, still ephemeral, still never persisted, still never affects any
  revision.
- `presenceList(setId)` returns only that set's live clients, so row-edit highlights
  only show people in the **same** set.
- **Library home** (`GET /api/library`) walks `presenceBySet` and emits a live count
  per set (computed at request time, never stored). A user with `setId === null`
  (browsing the library) counts toward no set.
- **Leave/unload:** `sendBeacon` can't set headers, so the leave path stays
  `POST /api/presence?leave=1&id=<clientId>` and removes that client from whichever
  set-map holds it (reverse index `clientId → setId`, or scan all maps).

---

## 8. Client changes (single-list assumptions to unwind)

Two views in the one single-file app: **library home** and **editor**.

- **New global state:** `currentSetId` (nullable = library home). `vars`, `localRev`,
  `saveTimers` are reset on every set switch (only one set is open at a time, so no
  per-set Map is needed for them).
- **`api()`** — send `X-VB-Set: currentSetId`.
- **`addVar` / `saveVar` / `deleteVar` / `clearAll` / `importJson`** — target
  `/api/sets/${currentSetId}/...`; block with "select or create a set first" when
  `currentSetId` is null.
- **`loadFromServer` / `poll`** — if `currentSetId` is null, fetch `/api/library`
  and render the home screen; else fetch the set. Guard the path against a null id.
- **`applyServerList`** — unchanged logic; runs only when a set is open; sets
  `localRev` for the current set (the localRev invariant is unchanged).
- **localStorage:** suffix `CACHE_KEY` and `VIEW_KEY` with `-${setId}` so cache and
  sort/filter state don't bleed across sets; add `CURRENT_SET_KEY` to restore the
  last-open set on reload.
- **Empty-state copy:** distinguish "No variables in this set yet" (set open, empty)
  from "No sets yet — create one" / "Select a set" (library home).
- **New UI:** library home (set cards: name, count, last-editor, presence badge;
  actions Open / Duplicate / Rename / Delete; a **+ New set** button; trash/restore
  affordance), and an editor **breadcrumb** (`← Library / [Set Name]`, name editable
  inline). A **set-switch routine** clears state and loads the target.

---

## 9. Edge cases & handling (drives the test plan)

| # | Race | Server | Client |
|---|---|---|---|
| 1 | Edit a set someone else deleted | `404 {error:"set_not_found"}` | Stop auto-save; stash in-flight work to `draft_<setId>`; banner "Set deleted by someone else" + "Save my changes as a new set"; go home |
| 2 | Two users rename same set | `409` + current index (optimistic `version`) | Refetch index; toast "renamed by someone"; let user re-apply |
| 3 | PUT to set deleted mid-edit | `404` | Same as #1; pause auto-save on first 404; do not retry |
| 4 | Duplicate a set while original is edited | Duplicate reads the in-memory store in one synchronous tick (atomic snapshot) | "Duplicating…"; verify new count |
| 5 | Poll returns 404 (set gone) | `404` | Poll loop try/catch: stop polling this set, fire `setDeleted` once, go home; never throw |
| 6 | Empty library (all sets deleted) | `{sets:[]}` | "No sets yet — create one" |
| 7 | Presence for a set nobody opened | `{presence:[]}`; TTL prunes | no-op |
| 8 | Repeated 404s / delete storms | `404` | Backoff only on 5xx/network, **never** on 404 |
| 9 | Set id collision | UUID; check file non-exist before create | retry (≈never happens) |
| 10 | Migration vs first request on boot | Migration is synchronous **before** `listen()` | n/a |

**Draft recovery (#1):** cache-to-localStorage-before-clear only. Do not auto-recreate
the set or restore server-side (no auth to attribute it, and "anyone can delete" means
undelete would fight the delete). Offer an explicit "save my in-flight changes as a
new set."

---

## 10. Testing

**Smoke suite (`test/smoke.js`) — extended; runs against a throwaway instance
(`RAILWAY_VOLUME_MOUNT_PATH=<tmpdir> PORT=<spare>`), production data untouched.**

- Keep all 34 existing assertions, now scoped to a set.
- **Library CRUD:** create empty → in index; rename → index updates; duplicate →
  new set, fresh row uids, original untouched; soft-delete → gone from index, file
  in `.trash/`; restore → back in index.
- **Set-scoped variables:** full existing CRUD / coercion / 409 / bulk cycle against
  `/api/sets/:setId/variables`.
- **Isolation:** two sets with same-named variables don't collide (per-set id
  uniqueness); editing set A never changes set B's revision.
- **Deleted-set handling:** PUT/GET to a deleted set → `404 {error:"set_not_found"}`.
- **Migration (idempotent):** temp dir with a legacy `variables.json` → boot →
  `set_1` exists with 21 rows + `seq` preserved, `library.json` points at it, legacy
  renamed to `.bak`; **boot again** → no double-migration.
- **Presence per-set:** two clients in different sets don't see each other; library
  reports per-set presence counts.

**Browser (Playwright, isolated instance, two `browser.newContext()` for two real
users):** library home renders cards; new set → empty editor; open/switch preserves
per-set view state; two contexts in the same set see each other's row-edit
highlights; deleting a set the other context has open → banner + draft recovery +
return to library, no console errors.

---

## 11. Deployment note

No new dependencies (UUID via `crypto.randomUUID()`, built into Node ≥ 14.17). The
existing Railway service + `/data` volume are unchanged; the migration runs on the
next deploy's boot. Auto-deploy is **not** wired (CLI-upload); redeploy via
`railway up` from the project dir, or connect the GitHub repo for push-to-deploy.
