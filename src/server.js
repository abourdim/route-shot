#!/usr/bin/env node
// route-shot web dashboard — zero-dependency Node HTTP server.
// Run:  node server.js  [port]
// Open: http://localhost:8080

const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const { spawn }  = require('child_process');
const { URL }    = require('url');

const PORT     = Number(process.argv[2] || process.env.PORT || 8080);
const ROOT     = path.resolve(__dirname, '..');   // project root (src/ lives one level down)
const WEB      = path.join(ROOT, 'web');
const CRAWLER  = path.join(__dirname, 'route-shot.js');
const APPS_CFG = path.join(ROOT, 'apps.json');
const SHOTS    = path.join(ROOT, 'screenshots');
const HISTORY  = path.join(ROOT, '.history.json');
const HISTORY_CAP = 50;
const PRESETS_DIR = path.join(ROOT, 'presets');

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY, 'utf8')); }
  catch { return { runs: [], scans: [] }; }
}
function saveHistory(h) {
  try { fs.writeFileSync(HISTORY, JSON.stringify(h, null, 2)); } catch {}
}
function pushHistory(kind, url) {
  if (!url) return;
  const h = loadHistory();
  const list = h[kind] || (h[kind] = []);
  const i = list.findIndex((e) => e.url === url);
  if (i !== -1) list.splice(i, 1);       // move to top if exists
  list.unshift({ url, ts: Date.now() });
  if (list.length > HISTORY_CAP) list.length = HISTORY_CAP;
  saveHistory(h);
}

// --- manual session state ---------------------------------------------------
// A persistent headful Playwright page the user drives themselves; each
// /api/manual/snapshot call captures the page's current state. Closes when
// the user explicitly stops or the dashboard process exits.
const manual = {
  browser: null, context: null, page: null,
  url: null, appName: 'manual', count: 0,
};

async function manualStop() {
  try { if (manual.context) await manual.context.close(); } catch {}
  try { if (manual.browser) await manual.browser.close(); } catch {}
  manual.browser = manual.context = manual.page = null;
  manual.url = null;
  manual.count = 0;
}
process.on('exit', () => { try { manual.browser?.close(); } catch {} });

// --- run state --------------------------------------------------------------
const run = {
  proc:    null,
  logs:    [],        // array of { ts, line }
  running: false,
  command: null,
  exit:    null,
  paused:  false,
  pauseMessage: null,
};

function pushLog(line) {
  const text = String(line).replace(/\r/g, '');
  // detect pause / resume sentinels emitted by the crawler so the dashboard
  // can surface a "Run paused" banner with a Resume button
  const pauseMatch = text.match(/^\[pause\]⏸\s*(.*)$/);
  if (pauseMatch) { run.paused = true; run.pauseMessage = pauseMatch[1] || 'Resume when ready'; }
  if (text.startsWith('[pause]▶')) { run.paused = false; run.pauseMessage = null; }
  run.logs.push({ ts: Date.now(), line: text });
  if (run.logs.length > 5000) run.logs.splice(0, 1000);
}

function spawnCrawler(args, label) {
  if (run.running) return { error: 'a run is already in progress' };
  run.logs = [];
  run.running = true;
  run.paused = false;
  run.pauseMessage = null;
  run.command = label;
  run.exit = null;
  pushLog(`$ node route-shot.js ${args.join(' ')}`);
  const proc = spawn(process.execPath, [CRAWLER, ...args], {
    cwd: ROOT,
    env: { ...process.env, ROUTE_SHOT_DASHBOARD: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],   // explicit so stdin is writable for resume
  });
  proc.stdout.on('data', (d) => d.toString().split('\n').forEach((l) => l && pushLog(l)));
  proc.stderr.on('data', (d) => d.toString().split('\n').forEach((l) => l && pushLog(`[stderr] ${l}`)));
  proc.on('exit', (code) => {
    pushLog(`--- exited with code ${code} ---`);
    run.running = false;
    run.paused = false;
    run.pauseMessage = null;
    run.exit = code;
    run.proc = null;
  });
  run.proc = proc;
  return { ok: true };
}

// --- tiny static helpers ----------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif':  'image/gif', '.svg': 'image/svg+xml',
};

function serveFile(res, filePath, fallbackType) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('404'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || fallbackType || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function safeJoin(base, rel) {
  const full = path.normalize(path.join(base, decodeURIComponent(rel)));
  if (!full.startsWith(base)) return null;  // path traversal guard
  return full;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function rmrf(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) { rmrf(p); fs.rmdirSync(p); }
    else fs.unlinkSync(p);
  }
}

function listShots() {
  if (!fs.existsSync(SHOTS)) return [];
  const out = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      const relPath = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) walk(p, relPath);
      else if (/\.(png|jpe?g|gif)$/i.test(name)) out.push(relPath);
    }
  };
  walk(SHOTS, '');
  return out.sort();
}

// Find every index.json file under screenshots/ and return a summary for each.
function listIndexes() {
  if (!fs.existsSync(SHOTS)) return [];
  const out = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      const relPath = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) walk(p, relPath);
      else if (name === 'index.json' || name === 'plan.json') {
        try {
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          const isDry = !!j.dryRun;
          let stats = { ok: 0, skipped: 0, errors: 0, planned: 0 };
          if (Array.isArray(j.pages)) {
            for (const page of j.pages) {
              if (page.screenshot) stats.ok++;
              else if (page.plannedFilename) stats.planned++;
              for (const v of page.variants || []) {
                if (v.screenshot)           stats.ok++;
                else if (v.plannedFilename) stats.planned++;
                else if (v.skipped)         stats.skipped++;
                else if (v.error)           stats.errors++;
              }
            }
          }
          out.push({ path: relPath, app: j.app || null, start: j.start || null, pageCount: j.count || 0, dryRun: isDry, ...stats });
        } catch {}
      }
    }
  };
  walk(SHOTS, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// --- routes -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = u;

  try {
    // static: dashboard
    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(res, path.join(WEB, 'ui.html'));
    }
    if (pathname === '/userguide.html') {
      return serveFile(res, path.join(WEB, 'userguide.html'));
    }

    // static: screenshots
    if (pathname.startsWith('/screenshots/')) {
      const rel = pathname.slice('/screenshots/'.length);
      const full = safeJoin(SHOTS, rel);
      if (!full) { res.writeHead(403); res.end(); return; }
      return serveFile(res, full);
    }

    // API: status
    if (pathname === '/api/status' && req.method === 'GET') {
      return json(res, 200, { running: run.running, command: run.command, exit: run.exit, paused: run.paused, pauseMessage: run.pauseMessage });
    }

    // resume a paused run by writing a newline to the child's stdin
    if (pathname === '/api/resume' && req.method === 'POST') {
      if (!run.proc || !run.paused) return json(res, 200, { ok: true, nothing: true });
      try { run.proc.stdin.write('\n'); } catch (e) { return json(res, 500, { error: e.message }); }
      return json(res, 200, { ok: true });
    }

    // API: logs (since?=timestamp)
    if (pathname === '/api/logs' && req.method === 'GET') {
      const since = Number(u.searchParams.get('since') || 0);
      const entries = run.logs.filter((l) => l.ts > since);
      return json(res, 200, { running: run.running, exit: run.exit, paused: run.paused, pauseMessage: run.pauseMessage, entries });
    }

    // API: read apps.json
    if (pathname === '/api/apps' && req.method === 'GET') {
      if (!fs.existsSync(APPS_CFG)) return json(res, 200, { apps: [] });
      return json(res, 200, JSON.parse(fs.readFileSync(APPS_CFG, 'utf8')));
    }

    // API: presets list + CRUD
    if (pathname === '/api/presets' && req.method === 'GET') {
      if (!fs.existsSync(PRESETS_DIR)) return json(res, 200, { presets: [] });
      const items = fs.readdirSync(PRESETS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const name = f.replace(/\.json$/, '');
          let description = '';
          try {
            const c = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8'));
            description = c._description || '';
          } catch {}
          return { name, description };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, { presets: items.map((p) => p.name), descriptions: Object.fromEntries(items.map((p) => [p.name, p.description])) });
    }
    if (pathname.startsWith('/api/presets/') && req.method === 'GET') {
      const name = decodeURIComponent(pathname.slice('/api/presets/'.length));
      if (!/^[\w.-]+$/.test(name)) return json(res, 400, { error: 'bad name' });
      const p = path.join(PRESETS_DIR, name + '.json');
      if (!fs.existsSync(p)) return json(res, 404, { error: 'not found' });
      return json(res, 200, JSON.parse(fs.readFileSync(p, 'utf8')));
    }
    if (pathname.startsWith('/api/presets/') && req.method === 'POST') {
      const name = decodeURIComponent(pathname.slice('/api/presets/'.length));
      if (!/^[\w.-]+$/.test(name)) return json(res, 400, { error: 'bad name (letters, digits, _ . - only)' });
      const body = await readBody(req);
      if (!body || !Array.isArray(body.apps)) return json(res, 400, { error: 'expected { apps: [...] }' });
      fs.mkdirSync(PRESETS_DIR, { recursive: true });
      fs.writeFileSync(path.join(PRESETS_DIR, name + '.json'), JSON.stringify(body, null, 2) + '\n');
      return json(res, 200, { ok: true });
    }
    if (pathname.startsWith('/api/presets/') && req.method === 'DELETE') {
      const name = decodeURIComponent(pathname.slice('/api/presets/'.length));
      if (!/^[\w.-]+$/.test(name)) return json(res, 400, { error: 'bad name' });
      const p = path.join(PRESETS_DIR, name + '.json');
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return json(res, 200, { ok: true });
    }

    // API: write apps.json
    if (pathname === '/api/apps' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.apps)) return json(res, 400, { error: 'expected { apps: [...] }' });
      fs.writeFileSync(APPS_CFG, JSON.stringify(body, null, 2) + '\n');
      return json(res, 200, { ok: true });
    }

    // API: list screenshots
    if (pathname === '/api/shots' && req.method === 'GET') {
      return json(res, 200, { files: listShots() });
    }

    // API: list every index.json with stats
    if (pathname === '/api/indexes' && req.method === 'GET') {
      return json(res, 200, { indexes: listIndexes() });
    }

    // API: serve a specific index.json / plan.json raw
    if (pathname === '/api/index' && req.method === 'GET') {
      const rel = u.searchParams.get('path');
      if (!rel) return json(res, 400, { error: 'path required' });
      const full = safeJoin(SHOTS, rel);
      if (!full || !fs.existsSync(full)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return fs.createReadStream(full).pipe(res);
    }

    // API: clean screenshots
    if (pathname === '/api/clean' && req.method === 'POST') {
      rmrf(SHOTS);
      return json(res, 200, { ok: true });
    }

    // API: open the screenshots folder in the OS file manager
    if (pathname === '/api/open-folder' && req.method === 'POST') {
      if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
      const platform = process.platform;
      const cmd = platform === 'win32' ? 'explorer'
                : platform === 'darwin' ? 'open'
                : 'xdg-open';
      try {
        const child = spawn(cmd, [SHOTS], { detached: true, stdio: 'ignore' });
        child.unref();
        return json(res, 200, { ok: true, opened: SHOTS });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    // API: delete one screenshot
    if (pathname === '/api/shot' && req.method === 'DELETE') {
      const rel = u.searchParams.get('path');
      if (!rel) return json(res, 400, { error: 'path required' });
      const full = safeJoin(SHOTS, rel);
      if (!full || !fs.existsSync(full)) return json(res, 404, { error: 'not found' });
      fs.unlinkSync(full);
      // also remove empty parent dirs
      let dir = path.dirname(full);
      while (dir !== SHOTS && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      }
      return json(res, 200, { ok: true });
    }

    // API: history (read + clear)
    if (pathname === '/api/history' && req.method === 'GET') {
      return json(res, 200, loadHistory());
    }
    if (pathname === '/api/history' && req.method === 'DELETE') {
      const kind = u.searchParams.get('kind');
      const url  = u.searchParams.get('url');
      const h = loadHistory();
      if (kind && url && h[kind]) h[kind] = h[kind].filter((e) => e.url !== url);
      else if (kind) h[kind] = [];
      else { h.runs = []; h.scans = []; }
      saveHistory(h);
      return json(res, 200, { ok: true });
    }

    // API: run single URL
    if (pathname === '/api/run/single' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return json(res, 400, { error: 'url required' });
      pushHistory('runs', body.url);
      const r = spawnCrawler([body.url], `single: ${body.url}`);
      return json(res, r.error ? 409 : 200, r);
    }

    // API: run batch (optional ?dry=1 for a dry-run plan instead of screenshots)
    if (pathname === '/api/run/batch' && req.method === 'POST') {
      if (!fs.existsSync(APPS_CFG)) return json(res, 400, { error: 'apps.json not found' });
      const args = ['--batch', 'apps.json'];
      let label = 'batch: apps.json';
      if (u.searchParams.get('dry') === '1') { args.unshift('--dry-run'); label = 'dry-run: apps.json'; }
      const r = spawnCrawler(args, label);
      return json(res, r.error ? 409 : 200, r);
    }

    // API: stop
    if (pathname === '/api/stop' && req.method === 'POST') {
      if (run.proc) { run.proc.kill('SIGTERM'); return json(res, 200, { ok: true }); }
      return json(res, 200, { ok: true, nothing: true });
    }

    // API: manual — user-driven snapshot session (headful Playwright page kept
    // alive across requests so the user can navigate/click by hand and fire
    // /api/manual/snapshot at key moments).
    if (pathname === '/api/manual/start' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return json(res, 400, { error: 'url required' });
      if (manual.page) await manualStop();
      try {
        const { chromium } = require('playwright');
        manual.browser = await chromium.launch({ headless: false });
        manual.context = await manual.browser.newContext();
        // Inject a floating 📸 widget + Ctrl/Cmd+Shift+S hotkey into every page
        // so the user never has to leave the Chromium window to trigger a snap.
        const dashboardPort = server.address()?.port || PORT;
        await manual.context.addInitScript({
          content: `
            (function() {
              if (window.top !== window) return;  // only in top frame
              const PORT = ${dashboardPort};
              // Try several hosts — IPv4, IPv6, hostname aliases — in case
              // 'localhost' resolves to a family the server isn't bound on.
              const HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
              function tryFetch(host, label) {
                return fetch('http://' + host + ':' + PORT + '/api/manual/snapshot', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ label: label || '' }),
                  mode: 'cors',
                }).then(r => r.json());
              }
              function tryImgPing(host, label) {
                return new Promise((resolve) => {
                  const img = new Image();
                  const url = 'http://' + host + ':' + PORT + '/api/manual/snapshot?label=' +
                              encodeURIComponent(label || '') + '&t=' + Date.now();
                  img.onload  = () => resolve({ ok: true, filename: '(via image-ping @ ' + host + ')' });
                  img.onerror = () => resolve(null);
                  img.src = url;
                });
              }
              async function snap(label) {
                for (const h of HOSTS) { try { return await tryFetch(h, label); } catch {} }
                for (const h of HOSTS) { const r = await tryImgPing(h, label); if (r) return r; }
                return { error: 'dashboard unreachable — tried ' + HOSTS.map(h => h + ':' + PORT).join(', ') };
              }
              function flash(msg, ok) {
                const b = document.createElement('div');
                b.textContent = msg;
                b.style.cssText = 'position:fixed;top:60px;right:16px;z-index:2147483647;padding:8px 14px;background:' +
                  (ok?'#1a7f38':'#8a1f1f') + ';color:#fff;font:13px/1.4 system-ui;border-radius:4px;' +
                  'box-shadow:0 4px 12px rgba(0,0,0,0.4);pointer-events:none;opacity:0.95;';
                document.documentElement.appendChild(b);
                setTimeout(() => b.remove(), 2200);
              }
              function setup() {
                if (document.getElementById('__routeShotWidget')) return;
                const w = document.createElement('div');
                w.id = '__routeShotWidget';
                w.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;' +
                  'display:flex;gap:6px;font:13px/1 system-ui;user-select:none;';
                const input = document.createElement('input');
                input.placeholder = 'label (optional)';
                input.style.cssText = 'padding:8px 10px;border:1px solid #444;background:#222;color:#fff;border-radius:6px;outline:none;';
                const btn = document.createElement('button');
                btn.textContent = '📸 Snap';
                btn.style.cssText = 'padding:8px 14px;border:0;background:#58a6ff;color:#000;font-weight:600;border-radius:6px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
                btn.onclick = async () => {
                  const r = await snap(input.value);
                  if (r.error) flash('✗ ' + r.error, false);
                  else { flash('📸 saved #' + r.count + ' — ' + r.filename, true); input.value = ''; }
                };
                w.appendChild(input); w.appendChild(btn);
                document.documentElement.appendChild(w);
              }
              if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', setup);
              } else setup();
              document.addEventListener('keydown', async (e) => {
                // Ctrl/Cmd + Shift + S — avoid clashing with browser's native Ctrl+S (save page)
                if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
                  e.preventDefault();
                  const r = await snap();
                  if (r.error) flash('✗ ' + r.error, false);
                  else flash('📸 saved #' + r.count, true);
                }
              }, true);
            })();
          `,
        });
        manual.page    = await manual.context.newPage();
        manual.url     = body.url;
        manual.appName = (body.appName || 'manual').replace(/[^\w.-]/g, '_');
        manual.count   = 0;
        await manual.page.goto(body.url, { waitUntil: 'networkidle', timeout: 20000 });
        if (body.dismiss) {
          for (const sel of String(body.dismiss).split(',').map((s) => s.trim()).filter(Boolean)) {
            try { const el = await manual.page.$(sel); if (el) await el.click({ timeout: 1000 }); } catch {}
          }
        }
        return json(res, 200, { ok: true, url: manual.url, appName: manual.appName });
      } catch (e) { await manualStop(); return json(res, 500, { error: e.message }); }
    }

    if (pathname === '/api/manual/snapshot' && (req.method === 'POST' || req.method === 'OPTIONS' || req.method === 'GET')) {
      // CORS + Private Network Access (Chrome blocks HTTPS-origin → http://localhost
      // without this extra header). Widget runs on github.io/any origin.
      res.setHeader('Access-Control-Allow-Origin',          '*');
      res.setHeader('Access-Control-Allow-Methods',         'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers',         'Content-Type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Access-Control-Max-Age',               '86400');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (!manual.page) return json(res, 400, { error: 'no manual session — start one first' });
      const labelRaw = req.method === 'GET'
        ? (u.searchParams.get('label') || '')
        : (((await readBody(req)) || {}).label || '');
      try {
        manual.count++;
        const outDir = path.join(SHOTS, manual.appName);
        fs.mkdirSync(outDir, { recursive: true });
        const labelPart = String(labelRaw).trim().replace(/[^\w.-]+/g, '_').slice(0, 60);
        const fname = `${String(manual.count).padStart(3, '0')}${labelPart ? '_' + labelPart : ''}.png`;
        await manual.page.screenshot({ path: path.join(outDir, fname), fullPage: true });
        const currentUrl = manual.page.url();
        // GET fallback (image-ping) expects a tiny response — serve a 1x1 GIF
        if (req.method === 'GET') {
          const gif = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');
          res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': gif.length });
          return res.end(gif);
        }
        return json(res, 200, { ok: true, filename: `${manual.appName}/${fname}`, count: manual.count, url: currentUrl });
      } catch (e) {
        if (req.method === 'GET') { res.writeHead(500); return res.end(); }
        return json(res, 500, { error: e.message });
      }
    }

    if (pathname === '/api/manual/stop' && req.method === 'POST') {
      await manualStop();
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/manual/status' && req.method === 'GET') {
      let currentUrl = null;
      if (manual.page) { try { currentUrl = manual.page.url(); } catch {} }
      return json(res, 200, {
        running: !!manual.page,
        url: manual.url,
        currentUrl,
        appName: manual.appName,
        count: manual.count,
      });
    }

    // API: scan — launch Playwright, goto URL, dismiss, enumerate clickables
    if (pathname === '/api/scan' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return json(res, 400, { error: 'url required' });
      pushHistory('scans', body.url);
      try {
        const { chromium } = require('playwright');
        const browser = await chromium.launch();
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(body.url, { waitUntil: 'networkidle', timeout: 20000 });
        // dismiss modal(s) if provided
        if (body.dismiss) {
          for (const sel of String(body.dismiss).split(',').map((s) => s.trim()).filter(Boolean)) {
            try {
              const el = await page.$(sel);
              if (el) { await el.click({ timeout: 1000 }); await page.waitForTimeout(400); }
            } catch {}
          }
        }
        // optional: run a short preSteps list before scanning (for auth, expert-mode, etc)
        if (Array.isArray(body.preSteps)) {
          for (const s of body.preSteps) {
            try {
              if (s.action === 'click' && s.selector) await page.locator(s.selector).first().click({ timeout: 3000 });
              else if (s.action === 'fill')           await page.locator(s.selector).first().fill(s.value || '', { timeout: 3000 });
              else if (s.action === 'wait')           await page.waitForTimeout(Number(s.value || 500));
            } catch {}
          }
        }
        const items = await page.$$eval(
          'button, [role=button], input[type=button], input[type=submit], a',
          (els) => els.map((e, i) => {
            const text = (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
            const id   = e.id || '';
            const cls  = (e.className && typeof e.className === 'string') ? e.className.trim().split(/\s+/).filter(Boolean).join('.') : '';
            const tag  = e.tagName.toLowerCase();
            const role = e.getAttribute('role') || '';
            const rect = e.getBoundingClientRect();
            const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
            let selector = '';
            if (id)        selector = `#${id}`;
            else if (cls)  selector = `${tag}.${cls}`;
            else if (text) selector = `${tag}:has-text(${JSON.stringify(text.slice(0, 40))})`;
            else           selector = `${tag}:nth-of-type(${i + 1})`;
            return { tag, id, text, cls, role, selector, visible };
          })
        );
        await browser.close();
        return json(res, 200, { count: items.length, items });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // API: import recording (multipart not implemented — accept JSON body)
    if (pathname === '/api/import-recording' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.recording) return json(res, 400, { error: 'recording (raw JSON string) required' });
      const tmp = path.join(ROOT, `.import-${Date.now()}.json`);
      fs.writeFileSync(tmp, typeof body.recording === 'string' ? body.recording : JSON.stringify(body.recording));
      const args = ['--import-recording', tmp, '--merge', 'apps.json'];
      if (body.name)     args.push('--name', body.name);
      if (body.asClicks) args.push('--as-clicks');
      const proc = spawn(process.execPath, [CRAWLER, ...args], { cwd: ROOT });
      let out = '', err = '';
      proc.stdout.on('data', (d) => out += d);
      proc.stderr.on('data', (d) => err += d);
      proc.on('exit', (code) => {
        fs.unlinkSync(tmp);
        if (code === 0) json(res, 200, { ok: true, stdout: out });
        else json(res, 500, { error: err || out, code });
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404');
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message || e) });
  }
});

// Try PORT; if busy, step up through the next 20 ports. Prints the final
// chosen port so launchers can discover it via stdout.
function listenWithFallback(startPort, attempt = 0) {
  const p = startPort + attempt;
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 20) {
      console.error(`port ${p} in use, trying ${p + 1}`);
      listenWithFallback(startPort, attempt + 1);
    } else {
      console.error(`failed to start: ${e.message}`);
      process.exit(1);
    }
  });
  // Bind to 0.0.0.0 so both IPv4 (127.0.0.1) and IPv6 loopback (::1) route
  // correctly — dual-stack default doesn't always accept IPv4 on Windows.
  server.listen(p, '0.0.0.0', () => {
    console.log(`route-shot dashboard  →  http://localhost:${p}`);
  });
}
listenWithFallback(PORT);
