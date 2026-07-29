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
