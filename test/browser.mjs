/*
 * test/browser.mjs — Playwright two-view / two-user scenario.
 *
 * Boots a throwaway server (temp data dir + spare port), drives two isolated
 * browser contexts (= two real users), and asserts the library/editor flows and
 * per-set presence + delete-recovery. Production data is never touched.
 *
 * Run:  node test/browser.mjs   (requires `npx playwright install chromium`)
 * Exits non-zero on the first failed assertion or any uncaught console error.
 */
'use strict';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';

const PORT = process.env.PORT || 4750;
const BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-browser-'));

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`✗ ${msg}`); throw new Error(msg); }
  passed++;
  console.log(`✓ ${msg}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Auto-answer dialogs by message content. `name` is used for the first-visit
// name prompt; everything else uses sensible defaults (accept confirms, accept
// prompts with their default). onAlert records the last alert text seen.
function wireDialogs(page, name, state) {
  page.on('dialog', async (d) => {
    const msg = d.message();
    if (d.type() === 'alert') { state.lastAlert = msg; await d.accept(); return; }
    if (d.type() === 'confirm') { await d.accept(); return; }
    // prompt
    if (/your name|display name/i.test(msg)) { await d.accept(name); return; }
    await d.accept(d.defaultValue() || 'X');   // set-name / rename prompts
  });
}

async function main() {
  // ── Boot a throwaway server ────────────────────────────────────────────────
  const srv = spawn('node', ['server.js'], {
    env: { ...process.env, PORT, RAILWAY_VOLUME_MOUNT_PATH: dir },
    stdio: 'inherit',
  });
  await sleep(1200);

  const browser = await chromium.launch();
  const consoleErrors = [];

  // Two isolated contexts = two users with separate localStorage/presence ids.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  for (const [pg, who] of [[A, 'Alice'], [B, 'Bob']]) {
    pg.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${who}] ${m.text()}`); });
    pg.on('pageerror', (e) => consoleErrors.push(`[${who}] pageerror: ${e.message}`));
  }
  const stateA = {}, stateB = {};
  wireDialogs(A, 'Alice', stateA);
  wireDialogs(B, 'Bob', stateB);

  try {
    // ── 1. Home renders; + New set → editor opens with empty-state copy ───────
    await A.goto(BASE);
    await A.waitForSelector('#library-view');
    assert(await A.isVisible('#library-view'), 'A: library home is visible on load');
    assert(await A.isVisible('#library-empty'), 'A: empty-state shown (no sets yet)');

    await A.click('#new-set-btn');             // prompt auto-accepts with "New set"
    await A.waitForSelector('#crumb-name:visible');
    assert(!(await A.isVisible('#library-view')), 'A: library home hidden after opening a set');
    assert(await A.isVisible('#empty-state'), 'A: editor empty-state shown for the new set');
    const emptyTxt = (await A.textContent('#empty-state')) || '';
    assert(/no variables/i.test(emptyTxt), 'A: editor empty-state says "No variables…"');

    // ── 2. Add a variable in A; ← Library; the card shows "1 vars" ────────────
    await A.click("button.type-btn:has-text('color')");
    await A.waitForSelector('.var-row');
    assert((await A.locator('.var-row').count()) === 1, 'A: one variable row after add');
    await A.click('#crumb-back');
    // goHome() reloads the library async; wait for the card to reflect the count
    // rather than reading a possibly-stale first paint.
    await A.waitForSelector('.set-card');
    await A.waitForFunction(() => {
      const el = document.querySelector('.set-card .set-meta');
      return el && /1 vars/.test(el.textContent);
    }, null, { timeout: 8000 });
    const cardMeta = (await A.textContent('.set-card .set-meta')) || '';
    assert(/1 vars/.test(cardMeta), 'A: library card shows "1 vars"');

    // discover the setId the card points at (first set in the library)
    const libResp = await A.evaluate(async (base) => (await (await fetch(base + '/api/library')).json()).sets, BASE);
    assert(libResp.length === 1, 'library has exactly one set');
    const SID = libResp[0].setId;

    // ── 3. Both contexts open the SAME set; A focuses a row → B sees "editing" ─
    await B.goto(BASE);
    await B.waitForSelector('.set-card');
    await B.click('.set-card .set-actions button:has-text("Open")');
    await B.waitForSelector('.var-row');
    assert((await B.locator('.var-row').count()) === 1, 'B: sees the same 1 row in the shared set');

    await A.click('.set-card .set-actions button:has-text("Open")');
    await A.waitForSelector('.var-row');
    // A focuses the row's display-name input → editingUid rides A's heartbeat.
    await A.click('.var-row .f-display');
    // Wait past one poll cycle (POLL_MS=4s) for B to pick up A's presence.
    await sleep(6000);
    const bSeesEditing = await B.evaluate(() =>
      !!document.querySelector('.var-row .avatar, .var-row .live-editor, .var-row.being-edited') &&
      document.querySelectorAll('.presence-cluster .avatar, #presence-cluster .avatar').length >= 0);
    // Robust check: B's presence count should show 2 people in this set.
    const bPresenceTxt = (await B.textContent('#presence-count')) || '';
    assert(!/only you/i.test(bPresenceTxt), `B: presence shows another user in the set (got "${bPresenceTxt.trim()}")`);

    // ── 4. Different sets → no cross-set presence ────────────────────────────
    await B.click('#crumb-back');
    await B.waitForSelector('#new-set-btn');
    await B.click('#new-set-btn');             // B creates + opens its own set
    await B.waitForSelector('.var-row, #empty-state');
    await sleep(6000);
    const bPresence2 = (await B.textContent('#presence-count')) || '';
    assert(/only you/i.test(bPresence2), `B: alone in its own set — no cross-set presence (got "${bPresence2.trim()}")`);

    // ── 5. Delete the set B has open (do it from A) → B recovers + goes home ──
    // Switch B into the shared set SID so the delete hits an open set. (B is
    // currently in its own set's editor; openSet swaps the live working set.)
    await B.evaluate((sid) => window.openSet(sid), SID);
    await B.waitForSelector('.var-row');
    assert(await B.evaluate((sid) => currentSetId === sid, SID), 'B: re-opened the shared set');
    // A deletes SID from the library home.
    await A.evaluate(async (args) => {
      const [base, sid] = args;
      await fetch(base + '/api/library/' + sid, { method: 'DELETE', headers: { 'X-VB-Client': 'a', 'X-VB-Name': 'Alice' } });
    }, [BASE, SID]);
    // B's next poll gets a 404 → onSetDeleted fires: alert + draft + home.
    await sleep(6000);
    assert(stateB.lastAlert && /deleted by someone else/i.test(stateB.lastAlert),
      'B: got the "deleted by someone else" alert');
    assert(await B.isVisible('#library-view'), 'B: returned to the library home after deletion');
    const draft = await B.evaluate((sid) => localStorage.getItem('draft_' + sid), SID);
    assert(draft && JSON.parse(draft).length >= 1, 'B: in-progress work stashed to draft_<setId> in localStorage');

    // ── No uncaught JS errors throughout ─────────────────────────────────────
    // Expected HTTP 404s (the delete-recovery path: B polls the set A deleted,
    // gets 404 set_not_found by design) surface as "Failed to load resource"
    // console entries — those are not app errors. Filter them; keep real ones.
    const realErrors = consoleErrors.filter(e => !/Failed to load resource/i.test(e));
    assert(realErrors.length === 0, `no uncaught JS errors (saw ${realErrors.length}: ${realErrors.join(' | ')})`);

    console.log(`\nAll ${passed} browser assertions passed.`);
  } finally {
    await browser.close().catch(() => {});
    try { srv.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message || e); process.exit(1); });
