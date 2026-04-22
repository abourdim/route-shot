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
const EXPORTS_SUBDIR = 'exports';

// Social media canvas presets — width × height at 1× (actual pixels).
const PROMO_FORMATS = {
  twitter:   { w: 1200, h:  675 },   // Twitter/X card, LinkedIn post
  'ig-square': { w: 1080, h: 1080 }, // Instagram feed
  'ig-story':  { w: 1080, h: 1920 }, // Instagram/TikTok story + reel
  youtube:   { w: 1280, h:  720 },   // YouTube thumbnail
  og:        { w: 1200, h:  630 },   // Open Graph / Facebook share
  'ph-gallery': { w: 1270, h: 760 }, // Product Hunt gallery
};
const VIDEO_FORMATS = {
  reel:    { w: 1080, h: 1920 },
  square:  { w: 1080, h: 1080 },
  feed:    { w: 1920, h: 1080 },
  youtube: { w: 1920, h: 1080 },
};

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
  if (manual.pollHandle) { clearInterval(manual.pollHandle); manual.pollHandle = null; }
  try { if (manual.context) await manual.context.close(); } catch {}
  try { if (manual.browser) await manual.browser.close(); } catch {}
  manual.browser = manual.context = manual.page = null;
  manual.url = null;
  manual.count = 0;
}
process.on('exit', () => { try { manual.browser?.close(); } catch {} });

// Hide / show the injected snap widget around screenshots so it doesn't
// appear in the captured image. display:none instead of removing so the
// element and its event handlers survive to be clicked again.
async function hideWidget(page) {
  try {
    await page.evaluate(() => {
      const w = document.getElementById('__routeShotWidget'); if (w) w.style.display = 'none';
      const b = document.getElementById('__routeShotCaptionBar'); if (b) b.dataset.prevDisplay = b.style.display, b.style.display = 'none';
    });
  } catch {}
}
async function showWidget(page) {
  try {
    await page.evaluate(() => {
      const w = document.getElementById('__routeShotWidget'); if (w) w.style.display = '';
      const b = document.getElementById('__routeShotCaptionBar'); if (b) b.style.display = b.dataset.prevDisplay || 'none';
    });
  } catch {}
}

// Draw an on-page caption bar so annotations become part of the screenshot.
// Placed top-center with a generous contrast background so it's readable
// against any site. Removed immediately after the screenshot is taken.
async function showOverlay(page, text) {
  if (!text) return;
  try {
    await page.evaluate((t) => {
      const d = document.createElement('div');
      d.id = '__routeShotOverlay';
      d.textContent = t;
      d.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);' +
        'z-index:2147483646;max-width:80vw;padding:10px 18px;background:rgba(0,0,0,0.82);' +
        'color:#fff;font:15px/1.35 system-ui;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.5);' +
        'white-space:pre-wrap;text-align:center;';
      document.documentElement.appendChild(d);
    }, text);
  } catch {}
}
async function removeOverlay(page) {
  try { await page.evaluate(() => { const d = document.getElementById('__routeShotOverlay'); if (d) d.remove(); }); } catch {}
}

// Write a sidecar .json next to each screenshot with the capture metadata
// (label, caption, url, timestamp). Useful for later review / regeneration.
function writeSidecar(imgPath, meta) {
  try {
    const sidecar = imgPath.replace(/\.png$/i, '.json');
    fs.writeFileSync(sidecar, JSON.stringify(meta, null, 2));
  } catch {}
}

// Drain the window.__routeShot.queue the injected widget fills — no network
// calls from the page to the server, so this works regardless of CORS, mixed
// content, or sandbox isolation in Playwright chromium.
async function drainManualQueue() {
  if (!manual.page) return;
  let jobs;
  try {
    jobs = await manual.page.evaluate(() => {
      if (!window.__routeShot) return [];
      const out = window.__routeShot.queue.splice(0, window.__routeShot.queue.length);
      return out;
    });
  } catch { return; }   // page navigating / closed — next tick will retry
  for (const job of jobs) {
    try {
      manual.count++;
      const outDir = path.join(SHOTS, manual.appName);
      fs.mkdirSync(outDir, { recursive: true });
      const labelPart = String(job.label || '').trim().replace(/[^\w.-]+/g, '_').slice(0, 60);
      const fname = `${String(manual.count).padStart(3, '0')}${labelPart ? '_' + labelPart : ''}.png`;
      const imgPath = path.join(outDir, fname);
      // Caption is already live on the page (user-positioned). Just hide the
      // widget chrome so it doesn't appear in the shot.
      await hideWidget(manual.page);
      try {
        await manual.page.screenshot({ path: imgPath, fullPage: true });
      } finally {
        await showWidget(manual.page);
      }
      const currentUrl = manual.page.url();
      const filename = `${manual.appName}/${fname}`;
      writeSidecar(imgPath, { ts: Date.now(), url: currentUrl, label: job.label || '', caption: job.caption || '', note: job.note || '' });
      // Post the result back into the page so snap() can resolve.
      await manual.page.evaluate((r) => {
        window.__routeShot.results[r.id] = r;
      }, { id: job.id, ok: true, filename, count: manual.count, url: currentUrl });
    } catch (e) {
      try {
        await manual.page.evaluate((r) => { window.__routeShot.results[r.id] = r; }, { id: job.id, error: e.message });
      } catch {}
    }
  }
}

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
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  // Reject absolute paths and any '..' segment outright — don't rely solely on
  // normalize+startsWith since edge cases (encoded slashes, symlinks) can slip.
  if (!decoded || decoded.includes('\0')) return null;
  if (path.isAbsolute(decoded)) return null;
  const parts = decoded.split(/[/\\]/);
  if (parts.some((p) => p === '..')) return null;
  const full = path.normalize(path.join(base, decoded));
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (full !== base && !full.startsWith(baseWithSep)) return null;
  return full;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;   // 10MB cap — defense against DoS via giant JSON

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Accept only http(s) URLs — reject javascript:, file:, data:, etc. before
// they ever reach the spawned crawler / headful Playwright page.
function isSafeHttpUrl(s) {
  if (typeof s !== 'string' || s.length > 2048) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
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

// Build a self-contained gallery.html — every image inlined as base64 so
// the file can be dropped anywhere (USB, email, GitHub Pages) and still work
// offline. Keyboard nav (arrows, space, F), click-to-zoom, thumbnail rail.
function buildGalleryHtml(title, slides) {
  const safe = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const slidesJson = JSON.stringify(slides);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${safe(title)} — gallery</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: #0d1117; color: #f0f6fc;
    font-family: system-ui, -apple-system, sans-serif; overflow: hidden; }
  body.print { overflow: visible; }
  header { display: flex; align-items: center; justify-content: space-between;
    padding: 12px 20px; border-bottom: 1px solid #30363d; background: #161b22; }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header .meta { color: #8b949e; font-size: 13px; }
  main { display: grid; grid-template-rows: 1fr 100px; height: calc(100vh - 54px); }
  .stage { position: relative; display: flex; align-items: center; justify-content: center;
    padding: 24px; overflow: hidden; }
  .stage img { max-width: 94%; max-height: 94%; object-fit: contain; border-radius: 6px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.5); background: #000; cursor: zoom-in; }
  .caption { position: absolute; left: 0; right: 0; bottom: 16px; text-align: center;
    font-size: 18px; font-weight: 600; padding: 6px 20px; text-shadow: 0 2px 4px rgba(0,0,0,0.7); }
  .note { position: absolute; left: 20px; top: 20px; max-width: 40%;
    font-size: 12px; color: #8b949e; background: rgba(0,0,0,0.4); padding: 6px 10px; border-radius: 4px; }
  .rail { display: flex; gap: 6px; overflow-x: auto; padding: 10px; border-top: 1px solid #30363d; background: #161b22; }
  .rail img { height: 80px; width: auto; border-radius: 3px; opacity: 0.55; cursor: pointer;
    transition: opacity 0.15s, transform 0.15s; flex: 0 0 auto; }
  .rail img.active { opacity: 1; outline: 2px solid #58a6ff; }
  .rail img:hover { opacity: 0.9; }
  .hint { position: fixed; right: 12px; bottom: 120px; font-size: 11px; color: #8b949e;
    background: rgba(0,0,0,0.6); padding: 6px 10px; border-radius: 4px; pointer-events: none; }
  /* Print / PDF layout: one slide per page. */
  @media print {
    html, body { overflow: visible; height: auto; background: white; color: black; }
    header, .rail, .hint { display: none !important; }
    main { display: block !important; height: auto; }
    .stage { page-break-after: always; display: flex; flex-direction: column;
      align-items: center; justify-content: center; width: 100vw; height: 100vh; padding: 20px; }
    .stage img { max-height: 85vh; max-width: 90vw; box-shadow: none; background: transparent; }
    .caption { position: static; color: #222; text-shadow: none; margin-top: 12px; }
    .note { position: static; color: #555; background: transparent; margin-top: 4px; max-width: none; }
  }
  .lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.95); display: none;
    align-items: center; justify-content: center; z-index: 100; }
  .lightbox.show { display: flex; }
  .lightbox img { max-width: 96vw; max-height: 96vh; }
</style>
</head><body>
<header>
  <h1>${safe(title)}</h1>
  <div class="meta"><span id="idx">1</span> / ${slides.length} · ← → space · F fullscreen</div>
</header>
<main id="main">
  <div class="stage">
    <img id="shot" alt="">
    <div id="note" class="note"></div>
    <div id="cap" class="caption"></div>
  </div>
  <div class="rail" id="rail"></div>
</main>
<div class="hint">← / → navigate · space play · F fullscreen · Esc exit</div>
<div id="lb" class="lightbox"><img id="lbImg"></div>
<script>
const slides = ${slidesJson};
const rail = document.getElementById('rail');
const shot = document.getElementById('shot');
const cap  = document.getElementById('cap');
const note = document.getElementById('note');
const idx  = document.getElementById('idx');
let i = 0, playing = false, playTimer = null;
// Print mode: emit every slide inline, one per page, so @media print paginates.
if (new URLSearchParams(location.search).get('print') === '1') {
  document.body.classList.add('print');
  const m = document.getElementById('main'); m.innerHTML = '';
  slides.forEach((s) => {
    const d = document.createElement('div'); d.className = 'stage';
    d.innerHTML = '<img src="' + s.src + '"><div class="caption">' + (s.caption || s.name) + '</div>' +
      (s.note ? '<div class="note">' + s.note + '</div>' : '');
    m.appendChild(d);
  });
} else {
  slides.forEach((s, ii) => {
    const t = document.createElement('img');
    t.src = s.src; t.title = s.name;
    t.onclick = () => show(ii);
    rail.appendChild(t);
  });
  function show(n) {
    i = Math.max(0, Math.min(slides.length - 1, n));
    const s = slides[i];
    shot.src = s.src;
    cap.textContent = s.caption || s.name;
    note.textContent = s.note || '';
    idx.textContent = i + 1;
    [...rail.children].forEach((t, tt) => t.classList.toggle('active', tt === i));
    const active = rail.children[i];
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }
  show(0);
  shot.onclick = () => { document.getElementById('lbImg').src = shot.src; document.getElementById('lb').classList.add('show'); };
  document.getElementById('lb').onclick = () => document.getElementById('lb').classList.remove('show');
  function togglePlay() {
    playing = !playing;
    if (playing) playTimer = setInterval(() => { show((i + 1) % slides.length); }, 2500);
    else { clearInterval(playTimer); playTimer = null; }
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') show(i + 1);
    else if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key.toLowerCase() === 'f') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    } else if (e.key === 'Escape') {
      document.getElementById('lb').classList.remove('show');
      if (playing) togglePlay();
    }
  });
}
</script>
</body></html>`;
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
    if (pathname === '/promo.html')     return serveFile(res, path.join(WEB, 'promo.html'));
    if (pathname === '/slideshow.html') return serveFile(res, path.join(WEB, 'slideshow.html'));

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
      if (!isSafeHttpUrl(body.url)) return json(res, 400, { error: 'valid http(s) url required' });
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
      if (!isSafeHttpUrl(body.url)) return json(res, 400, { error: 'valid http(s) url required' });
      if (manual.page) await manualStop();
      try {
        const { chromium } = require('playwright');
        manual.browser = await chromium.launch({
          headless: false,
          // Force the window to the foreground at launch. Without these flags,
          // Playwright's chromium frequently opens behind the current terminal
          // / dashboard window on Windows.
          args: ['--start-maximized', '--new-window'],
        });
        manual.context = await manual.browser.newContext({ viewport: null });
        // Pre-grant camera + mic so the webcam-overlay annotation can
        // start streaming without a permission prompt interrupting the flow.
        try { await manual.context.grantPermissions(['camera', 'microphone']); } catch {}
        // Inject a floating 📸 widget + Ctrl/Cmd+Shift+S hotkey into every page
        // so the user never has to leave the Chromium window to trigger a snap.
        await manual.context.addInitScript({ path: path.join(ROOT, 'web', 'manual-widget.js') });
        manual.page    = await manual.context.newPage();
        manual.url     = body.url;
        manual.appName = (body.appName || 'manual').replace(/[^\w.-]/g, '_');
        manual.count   = 0;
        // Poll the page's queue of snap requests every 150ms.
        manual.pollHandle = setInterval(drainManualQueue, 150);
        await manual.page.goto(body.url, { waitUntil: 'networkidle', timeout: 20000 });
        // Raise the tab/window so the user can start interacting immediately
        // instead of hunting for it behind the terminal.
        try { await manual.page.bringToFront(); } catch {}
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
      let labelRaw = '', captionRaw = '', noteRaw = '';
      if (req.method === 'GET') {
        labelRaw   = u.searchParams.get('label')   || '';
        captionRaw = u.searchParams.get('caption') || '';
        noteRaw    = u.searchParams.get('note')    || '';
      } else {
        const body = (await readBody(req)) || {};
        labelRaw   = body.label   || '';
        captionRaw = body.caption || '';
        noteRaw    = body.note    || '';
      }
      try {
        manual.count++;
        const outDir = path.join(SHOTS, manual.appName);
        fs.mkdirSync(outDir, { recursive: true });
        const labelPart = String(labelRaw).trim().replace(/[^\w.-]+/g, '_').slice(0, 60);
        const fname = `${String(manual.count).padStart(3, '0')}${labelPart ? '_' + labelPart : ''}.png`;
        const imgPath = path.join(outDir, fname);
        await hideWidget(manual.page);
        await showOverlay(manual.page, captionRaw);
        try {
          await manual.page.screenshot({ path: imgPath, fullPage: true });
        } finally {
          await removeOverlay(manual.page);
          await showWidget(manual.page);
        }
        const currentUrl = manual.page.url();
        writeSidecar(imgPath, { ts: Date.now(), url: currentUrl, label: labelRaw, caption: captionRaw, note: noteRaw });
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
      if (!isSafeHttpUrl(body.url)) return json(res, 400, { error: 'valid http(s) url required' });
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

    // --- EXPORTS: promo / gallery / pdf / video -----------------------------

    // POST /api/export/promo
    // body: { shot: "app/file.png", format, title, tagline, cta, frame, theme, accent, logo, credits }
    // Renders web/promo.html at the chosen social format size, grabs a PNG.
    if (pathname === '/api/export/promo' && req.method === 'POST') {
      const body = await readBody(req);
      const fmt = PROMO_FORMATS[body.format] || PROMO_FORMATS.twitter;
      const shotAbs = safeJoin(SHOTS, body.shot || '');
      if (!shotAbs || !fs.existsSync(shotAbs)) return json(res, 400, { error: 'shot not found' });
      const app = (body.shot || '').split(/[\\/]/)[0] || 'manual';
      const outDir = path.join(SHOTS, app, EXPORTS_SUBDIR);
      fs.mkdirSync(outDir, { recursive: true });
      const base = path.basename(body.shot).replace(/\.[^.]+$/, '');
      const outFile = `promo-${body.format}-${base}.png`;
      const outPath = path.join(outDir, outFile);
      try {
        const { chromium } = require('playwright');
        const browser = await chromium.launch();
        const ctx = await browser.newContext({ viewport: { width: fmt.w, height: fmt.h }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        const q = new URLSearchParams({
          img: '/screenshots/' + body.shot.replace(/\\/g, '/'),
          title:   body.title   || '',
          tagline: body.tagline || '',
          cta:     body.cta     || '',
          frame:   body.frame   || 'browser',
          theme:   body.theme   || 'dark',
          accent:  body.accent  || '#58a6ff',
          logo:    body.logo    || '',
          credits: body.credits || '',
        });
        await page.goto(`http://localhost:${PORT}/promo.html?${q.toString()}`, { waitUntil: 'networkidle' });
        await page.waitForFunction('window.__promoReady === true', null, { timeout: 15000 });
        await page.screenshot({ path: outPath, type: 'png' });
        await browser.close();
        return json(res, 200, { ok: true, file: `${app}/${EXPORTS_SUBDIR}/${outFile}`, w: fmt.w, h: fmt.h });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    // POST /api/export/gallery  body: { app, title }
    // Builds a self-contained gallery.html (all screenshots inlined as base64).
    if (pathname === '/api/export/gallery' && req.method === 'POST') {
      const body = await readBody(req);
      const app = String(body.app || '').replace(/[^\w.-]/g, '');
      if (!app) return json(res, 400, { error: 'app required' });
      const dir = path.join(SHOTS, app);
      if (!fs.existsSync(dir)) return json(res, 404, { error: 'app folder not found' });
      const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
      if (!files.length) return json(res, 400, { error: 'no screenshots to export' });
      const slides = files.map((f) => {
        const b64 = fs.readFileSync(path.join(dir, f)).toString('base64');
        const mime = /\.png$/i.test(f) ? 'image/png' : 'image/jpeg';
        let meta = {};
        const sidecar = path.join(dir, f.replace(/\.[^.]+$/, '.json'));
        if (fs.existsSync(sidecar)) {
          try { meta = JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch {}
        }
        return { name: f, src: `data:${mime};base64,${b64}`, caption: meta.caption || '', note: meta.note || '', url: meta.url || '' };
      });
      const title = body.title || app;
      const html = buildGalleryHtml(title, slides);
      const outPath = path.join(dir, 'gallery.html');
      fs.writeFileSync(outPath, html);
      return json(res, 200, { ok: true, file: `${app}/gallery.html`, count: slides.length });
    }

    // POST /api/export/pdf  body: { app }  — requires gallery.html to exist (or regenerates).
    if (pathname === '/api/export/pdf' && req.method === 'POST') {
      const body = await readBody(req);
      const app = String(body.app || '').replace(/[^\w.-]/g, '');
      if (!app) return json(res, 400, { error: 'app required' });
      const galleryAbs = path.join(SHOTS, app, 'gallery.html');
      if (!fs.existsSync(galleryAbs)) return json(res, 400, { error: 'gallery.html not found — export gallery first' });
      const outFile = `gallery-${app}.pdf`;
      const outPath = path.join(SHOTS, app, outFile);
      try {
        const { chromium } = require('playwright');
        const browser = await chromium.launch();
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`http://localhost:${PORT}/screenshots/${encodeURIComponent(app)}/gallery.html?print=1`, { waitUntil: 'networkidle' });
        await page.pdf({ path: outPath, format: 'Letter', printBackground: true, landscape: true, margin: { top: '0.3in', bottom: '0.3in', left: '0.3in', right: '0.3in' } });
        await browser.close();
        return json(res, 200, { ok: true, file: `${app}/${outFile}` });
      } catch (e) { return json(res, 500, { error: 'PDF export failed: ' + e.message }); }
    }

    // POST /api/export/video
    // body: { app, format: 'reel'|'square'|'feed'|'youtube', frameMs, fps, watermark }
    // Renders web/slideshow.html in Playwright at the chosen size and records
    // it via MediaRecorder. If ffmpeg is on PATH, auto-transcodes to mp4.
    if (pathname === '/api/export/video' && req.method === 'POST') {
      const body = await readBody(req);
      const fmt = VIDEO_FORMATS[body.format] || VIDEO_FORMATS.reel;
      const app = String(body.app || '').replace(/[^\w.-]/g, '');
      if (!app) return json(res, 400, { error: 'app required' });
      const dir = path.join(SHOTS, app);
      if (!fs.existsSync(dir)) return json(res, 404, { error: 'app folder not found' });
      const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
      if (!files.length) return json(res, 400, { error: 'no screenshots to export' });
      const frameMs = Number(body.frameMs || 2500);
      const fps = Number(body.fps || 30);
      const cfg = {
        fps,
        watermark: body.watermark || '',
        frames: files.map((f) => {
          let meta = {};
          const sidecar = path.join(dir, f.replace(/\.[^.]+$/, '.json'));
          if (fs.existsSync(sidecar)) { try { meta = JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch {} }
          return {
            img: `/screenshots/${app}/${encodeURIComponent(f)}`,
            caption: meta.caption || '',
            note:    meta.note    || '',
            durationMs: frameMs,
          };
        }),
      };
      const outDir = path.join(dir, EXPORTS_SUBDIR);
      fs.mkdirSync(outDir, { recursive: true });
      const webmOut = path.join(outDir, `video-${body.format}.webm`);
      try {
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
        const ctx = await browser.newContext({ viewport: { width: fmt.w, height: fmt.h }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        const q = encodeURIComponent(JSON.stringify(cfg));
        await page.goto(`http://localhost:${PORT}/slideshow.html?config=${q}`, { waitUntil: 'networkidle' });
        await page.waitForFunction('window.__slideshowReady === true', null, { timeout: 30000 });
        const duration = await page.evaluate('window.__slideshowDurationMs');
        // Start MediaRecorder inside the page (captures the visible viewport
        // via captureStream on a canvas that mirrors the body). For the full
        // page body, we use document.documentElement rendered onto a canvas
        // each frame — simpler: use the MediaRecorder on a <canvas> tied via
        // requestAnimationFrame to snapshot html2canvas-style? Too heavy.
        // Instead: capture the page via CDP video recording? Playwright
        // has page.video() but needs recordVideo at context-create. Easiest
        // path: use ctx with recordVideo and let the slideshow play.
        await browser.close();
        // Re-launch with recordVideo so we get a webm out-of-the-box.
        const rbrowser = await chromium.launch();
        const rctx = await rbrowser.newContext({
          viewport: { width: fmt.w, height: fmt.h },
          deviceScaleFactor: 1,
          recordVideo: { dir: outDir, size: { width: fmt.w, height: fmt.h } },
        });
        const rpage = await rctx.newPage();
        await rpage.goto(`http://localhost:${PORT}/slideshow.html?config=${q}`, { waitUntil: 'networkidle' });
        await rpage.waitForFunction('window.__slideshowReady === true', null, { timeout: 30000 });
        await rpage.evaluate('window.__slideshowStart = true');
        await rpage.waitForFunction('window.__slideshowDone === true', null, { timeout: duration + 10000 });
        const video = rpage.video();
        await rpage.close();
        const tempPath = await video.path();
        await rctx.close();
        await rbrowser.close();
        fs.renameSync(tempPath, webmOut);
        // Try mp4 transcode if ffmpeg is on PATH.
        let finalFile = `${app}/${EXPORTS_SUBDIR}/video-${body.format}.webm`;
        try {
          const mp4Out = webmOut.replace(/\.webm$/, '.mp4');
          await new Promise((resolve, reject) => {
            const ff = spawn('ffmpeg', ['-y', '-i', webmOut, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4Out], { stdio: 'ignore' });
            ff.on('error', reject);
            ff.on('exit', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)));
          });
          finalFile = `${app}/${EXPORTS_SUBDIR}/video-${body.format}.mp4`;
        } catch { /* ffmpeg missing — keep webm */ }
        return json(res, 200, { ok: true, file: finalFile, w: fmt.w, h: fmt.h, frames: cfg.frames.length });
      } catch (e) { return json(res, 500, { error: 'Video export failed: ' + e.message }); }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404');
  } catch (e) {
    console.error(e);
    const status = /body too large/i.test(String(e.message)) ? 413 : 500;
    json(res, status, { error: String(e.message || e) });
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
  // Default bind (dual-stack) — explicit 0.0.0.0 triggers EACCES on
  // Windows for ports in excluded ranges (Hyper-V / WSL reservations).
  // The injected widget retries multiple host aliases client-side, so
  // dual-stack is good enough.
  server.listen(p, () => {
    console.log(`route-shot dashboard  →  http://localhost:${p}`);
  });
}
listenWithFallback(PORT);
