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
const GALLERIES  = path.join(ROOT, 'galleries');
const VIDEOS     = path.join(ROOT, 'videos');
const AUDIO_LIB  = path.join(ROOT, 'audio', 'library');
const AUDIO_UP   = path.join(ROOT, 'audio', 'uploads');
const AUDIO_CACHE = path.join(ROOT, 'audio', 'cache');

// Filesystem-safe slug for gallery/video folder names (letters, digits, -, _).
function slugName(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}
// Timestamp in YYYYMMDD-HHMMSS (local time) for run folder names.
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

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

// --- video batch state ------------------------------------------------------
// Sequential multi-mode renders: same shots + format, different style per
// render. Populated by POST /api/export/video/batch, read by the progress
// polling endpoint, mutated by /stop.
const videoBatch = {
  running:       false,
  runName:       null,
  runDir:        null,
  modes:         [],        // remaining modes to render (drained as we go)
  total:         0,
  done:          [],        // [{ mode, webm, mp4?, ms }]
  failed:        [],        // [{ mode, error }]
  current:       null,      // currently-rendering mode name
  startedAt:     null,
  modeStartedAt: null,
  stopRequested: false,
  transcodes:    [],        // pending ffmpeg promises, awaited at end
};

function resetVideoBatch() {
  Object.assign(videoBatch, {
    running: false, runName: null, runDir: null,
    modes: [], total: 0, done: [], failed: [], current: null,
    startedAt: null, modeStartedAt: null, stopRequested: false,
    transcodes: [],
  });
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
  '.mp3':  'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a':  'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
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

// List audio tracks under audio/library/ + audio/uploads/. Returns
// [{ path: 'library/foo.mp3', name: 'foo.mp3', source: 'library'|'uploads' }].
function listAudioTracks() {
  const out = [];
  for (const [dir, source] of [[AUDIO_LIB, 'library'], [AUDIO_UP, 'uploads']]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(mp3|wav|m4a|ogg)$/i.test(f)) continue;
      out.push({ path: `${source}/${f}`, name: f, source });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Resolve an audio spec → absolute file path the renderer can feed to ffmpeg.
// Accepts:
//   - 'library/foo.mp3' | 'uploads/bar.wav'  (relative to audio/)
//   - 'http(s)://...'                        (downloads to audio/cache/ on first use)
// Returns { ok: true, path } or { ok: false, error }.
async function resolveAudioSource(spec) {
  if (!spec || typeof spec !== 'string') return { ok: false, error: 'no audio' };
  if (/^https?:\/\//i.test(spec)) {
    fs.mkdirSync(AUDIO_CACHE, { recursive: true });
    // Hash the URL into a stable filename. Keep the extension if present.
    let ext = '.mp3';
    try { const u = new URL(spec); const m = u.pathname.match(/\.(mp3|wav|m4a|ogg)$/i); if (m) ext = m[0]; } catch {}
    const hash = require('crypto').createHash('sha1').update(spec).digest('hex').slice(0, 16);
    const cached = path.join(AUDIO_CACHE, hash + ext);
    if (fs.existsSync(cached)) return { ok: true, path: cached };
    try {
      await new Promise((resolve, reject) => {
        const https = require(spec.startsWith('https') ? 'https' : 'http');
        const file = fs.createWriteStream(cached);
        https.get(spec, (r) => {
          if (r.statusCode !== 200) {
            fs.unlink(cached, () => {});
            return reject(new Error('HTTP ' + r.statusCode));
          }
          r.pipe(file);
          file.on('finish', () => file.close(resolve));
        }).on('error', (e) => { fs.unlink(cached, () => {}); reject(e); });
      });
      return { ok: true, path: cached };
    } catch (e) { return { ok: false, error: 'download failed: ' + e.message }; }
  }
  // Relative spec — only allow library/uploads/cache subdirs. Filenames may
  // contain spaces (hence safeJoin + prefix check rather than a tight regex).
  if (!/^(library|uploads|cache)[\\/]/.test(spec)) {
    return { ok: false, error: 'invalid audio path' };
  }
  const abs = safeJoin(path.join(ROOT, 'audio'), spec);
  if (!abs) return { ok: false, error: 'path traversal blocked' };
  if (!fs.existsSync(abs)) return { ok: false, error: 'audio not found: ' + spec };
  return { ok: true, path: abs };
}

// Render one slideshow video. Pure function — no dependency on req/res, used
// both by the single-mode /api/export/video endpoint and the batch loop.
// Returns { ok, webm, mp4?, ms } on success or { error } on failure.
// mp4Promise (ffmpeg transcode) runs in the background — push the returned
// promise onto videoBatch.transcodes and resolve it later.
async function renderOneVideoMode({ shotPaths, fmt, frameMs, fps, watermark, style, bgMusic, outDir, baseName, silent, audioPath, volume, fadeInMs, fadeOutMs }) {
  const cfg = {
    fps,
    watermark: watermark || '',
    style:     style     || 'minimal',
    bgMusic:   silent ? '' : (bgMusic || ''),
    frames: shotPaths.map((rel) => {
      const abs = safeJoin(SHOTS, rel);
      let meta = {};
      const sidecar = abs.replace(/\.[^.]+$/, '.json');
      if (fs.existsSync(sidecar)) { try { meta = JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch {} }
      return {
        img: '/screenshots/' + rel.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'),
        caption: meta.caption || '',
        note:    meta.note    || '',
        durationMs: frameMs,
      };
    }),
  };
  const webmOut = path.join(outDir, `${baseName}.webm`);
  const startedAt = Date.now();
  try {
    const { chromium } = require('playwright');
    const q = encodeURIComponent(JSON.stringify(cfg));
    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const ctx = await browser.newContext({
      viewport: { width: fmt.w, height: fmt.h },
      deviceScaleFactor: 2,
      recordVideo: { dir: outDir, size: { width: fmt.w, height: fmt.h } },
    });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${ACTIVE_PORT}/slideshow.html?config=${q}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__slideshowReady === true', null, { timeout: 60000 });
    const duration = await page.evaluate('window.__slideshowDurationMs');
    await page.evaluate('window.__slideshowStart = true');
    await page.waitForFunction('window.__slideshowDone === true', null, { timeout: duration + 10000 });
    const video = page.video();
    await page.close();
    const tempPath = await video.path();
    await ctx.close();
    await browser.close();
    fs.renameSync(tempPath, webmOut);
    // Fire ffmpeg transcode in the background — do NOT await, so the caller
    // can move on to the next render immediately. Caller collects the Promise.
    const mp4Out = webmOut.replace(/\.webm$/, '.mp4');
    // Build ffmpeg args. If audio is provided (and silent is not set), add
    // a second input + audio filter + aac encoding. Otherwise mp4 ships
    // silent (video-only, same as before).
    const useAudio = !silent && audioPath && fs.existsSync(audioPath);
    const args = ['-y', '-i', webmOut];
    if (useAudio) {
      // Loop the audio so it covers videos longer than the track, then
      // -shortest clips to video length.
      args.push('-stream_loop', '-1', '-i', audioPath);
    }
    args.push(
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    );
    if (useAudio) {
      const videoSeconds = (shotPaths.length * frameMs) / 1000;
      const vol     = Math.max(0, Math.min(1, (volume ?? 70) / 100));
      const fadeIn  = Math.max(0, (fadeInMs  ?? 500) / 1000);
      const fadeOut = Math.max(0, (fadeOutMs ?? 500) / 1000);
      const fadeOutStart = Math.max(0, videoSeconds - fadeOut).toFixed(2);
      const afilter = [
        `volume=${vol}`,
        fadeIn  > 0 ? `afade=t=in:st=0:d=${fadeIn}` : null,
        fadeOut > 0 ? `afade=t=out:st=${fadeOutStart}:d=${fadeOut}` : null,
      ].filter(Boolean).join(',');
      args.push('-c:a', 'aac', '-b:a', '192k', '-af', afilter, '-shortest');
    }
    args.push(mp4Out);
    const mp4Promise = new Promise((resolve) => {
      const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
      ff.on('error', () => resolve({ ok: false }));
      ff.on('exit', (code) => resolve({ ok: code === 0, path: mp4Out, audio: useAudio }));
    });
    return { ok: true, webm: webmOut, mp4Promise, ms: Date.now() - startedAt };
  } catch (e) {
    return { error: e.message, ms: Date.now() - startedAt };
  }
}

// All video mode values that appear in the UI <select>. Kept in sync with
// web/ui.html's optgroups — add new modes in both places.
const ALL_VIDEO_MODES = [
  // Minimal
  'minimal','dynamic','3d','cinematic','documentary','museum','magazine','paper',
  // Tech/Dev
  'hacker','maker','anonymous','terminal','cyberpunk','oscilloscope','blueprint','neon-outline',
  // Space/Science
  'nasa','cosmos','starfield','nebula','wormhole','satellite','particle','lab-notebook','radar',
  // Retro/Art
  'retro-80s','vhs','film-noir','polaroid','chalkboard','comic','holographic',
];

// Accept only http(s) URLs — reject javascript:, file:, data:, etc. before
// they ever reach the spawned crawler / headful Playwright page.
function isSafeHttpUrl(s) {
  if (typeof s !== 'string' || s.length > 2048) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

// Escape HTML for safe embedding in server-generated pages (compare.html etc).
function escapeHtmlSafe(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
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
// List of themeable styles — serious sci/NASA/maker/hacker vibes, no confetti.
// Kept in sync with web/effects.css and the slideshow palette.
const GALLERY_STYLES = [
  'minimal','dynamic','3d','cinematic','documentary',
  'hacker','maker','anonymous','terminal','cyberpunk','oscilloscope','blueprint',
  'nasa','cosmos','starfield','nebula','wormhole','satellite','particle','lab-notebook',
  'retro-80s','vhs','film-noir','polaroid','chalkboard','comic',
  'holographic','neon-outline','magazine','museum','paper','radar',
];
const GALLERY_TRANSITIONS = [
  't-fade-in','t-slideL-in','t-slideR-in','t-slideU-in','t-zoom-in',
  't-cubeY-in','t-cubeX-in','t-flip-in','t-glitch-in','t-pop-in',
  't-iris-in','t-blinds-in',
];

function buildGalleryHtml(title, slides) {
  const safe = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const slidesJson = JSON.stringify(slides);
  // Inline the shared effects stylesheet so the generated gallery.html is
  // self-contained (works offline, over email, on USB, on GitHub Pages).
  let effectsCss = '';
  try { effectsCss = fs.readFileSync(path.join(WEB, 'effects.css'), 'utf8'); } catch {}
  const styleOptions = GALLERY_STYLES.map((s) => `<option value="${s}">${s}</option>`).join('');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${safe(title)} — gallery</title>
<style>
/* ===== inlined effects.css ===== */
${effectsCss}
/* ===== gallery shell ===== */
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; height:100%; font-family:system-ui,-apple-system,sans-serif;
    overflow:hidden; perspective:1600px; }
  html { background:#0d1117; color:#f0f6fc; }
  body.print { overflow:visible; }
  header { position:relative; z-index:10; display:flex; align-items:center; justify-content:space-between;
    padding:10px 18px; border-bottom:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.55); backdrop-filter: blur(10px); }
  header h1 { margin:0; font-size:16px; font-weight:700; }
  header .meta { color:#aaa; font-size:12px; }
  header .ctl { display:flex; gap:6px; align-items:center; }
  header button, header select { padding:5px 10px; font-size:12px; background:#30363d; color:#f0f6fc;
    border:0; border-radius:4px; cursor:pointer; }
  header button.on { background:#58a6ff; color:#000; }
  main { display:grid; grid-template-rows:1fr 92px; height:calc(100vh - 50px); }
  .stage { position:relative; display:flex; align-items:center; justify-content:center;
    padding:24px; overflow:hidden; transform-style:preserve-3d; }
  .stage img { max-width:94%; max-height:94%; object-fit:contain; border-radius:6px;
    box-shadow:0 12px 40px rgba(0,0,0,0.5); background:#000; cursor:zoom-in;
    will-change:transform, opacity; backface-visibility:hidden; }
  #cap.lower { position:absolute; left:4%; right:4%; bottom:6%; text-align:center;
    padding:6px 20px; }
  .note { position:absolute; left:20px; top:20px; max-width:40%; font-size:12px;
    color:#8b949e; background:rgba(0,0,0,0.4); padding:6px 10px; border-radius:4px; z-index:3; }
  .rail { display:flex; gap:6px; overflow-x:auto; padding:10px; border-top:1px solid rgba(255,255,255,0.1);
    background:rgba(0,0,0,0.55); backdrop-filter: blur(10px); }
  .rail img { height:72px; width:auto; border-radius:3px; opacity:0.55; cursor:pointer;
    transition:opacity 0.15s, transform 0.15s; flex:0 0 auto; }
  .rail img.active { opacity:1; outline:2px solid #58a6ff; }
  .rail img:hover { opacity:0.9; }
  .hint { position:fixed; right:12px; bottom:108px; font-size:11px; color:#aaa;
    background:rgba(0,0,0,0.6); padding:6px 10px; border-radius:4px; pointer-events:none; z-index:10; }
  @media print {
    html, body { overflow:visible; height:auto; background:white; color:black; }
    header, .rail, .hint { display:none !important; }
    main { display:block !important; height:auto; }
    .stage { page-break-after:always; display:flex; flex-direction:column;
      align-items:center; justify-content:center; width:100vw; height:100vh; padding:20px; }
    .stage img { max-height:85vh; max-width:90vw; box-shadow:none; background:transparent; }
    #cap.lower { position:static; color:#222; margin-top:12px; }
    .note { position:static; color:#555; background:transparent; margin-top:4px; max-width:none; }
  }
  .lightbox { position:fixed; inset:0; background:rgba(0,0,0,0.95); display:none;
    align-items:center; justify-content:center; z-index:100; }
  .lightbox.show { display:flex; }
  .lightbox img { max-width:96vw; max-height:96vh; }
</style>
</head><body>
<header>
  <h1>${safe(title)}</h1>
  <div class="meta"><span id="idx">1</span> / ${slides.length} · ← → space · F fullscreen · S shuffle style</div>
  <div class="ctl">
    <select id="styleSel" title="Visual theme">${styleOptions}</select>
    <button id="playBtn" title="Auto-advance (space)">▶ Play</button>
    <button id="demoBtn" title="Demo mode: random style + transitions on every slide">✨ Demo</button>
  </div>
</header>
<main id="main">
  <div class="stage">
    <img id="shot" alt="">
    <div id="note" class="note"></div>
    <div id="cap" class="lower"></div>
  </div>
  <div class="rail" id="rail"></div>
</main>
<div class="hint">← / → navigate · space play · S shuffle · F fullscreen · Esc exit</div>
<div id="lb" class="lightbox"><img id="lbImg"></div>
<script>
const slides = ${slidesJson};
const STYLES = ${JSON.stringify(GALLERY_STYLES)};
const TRANSITIONS = ${JSON.stringify(GALLERY_TRANSITIONS)};
const rail = document.getElementById('rail');
const shot = document.getElementById('shot');
const cap  = document.getElementById('cap');
const note = document.getElementById('note');
const idx  = document.getElementById('idx');
let i = 0, playing = false, playTimer = null;

function setStyle(name) {
  if (!STYLES.includes(name)) return;
  STYLES.forEach((s) => document.body.classList.remove('style-' + s));
  document.body.classList.add('style-' + name);
  const sel = document.getElementById('styleSel'); if (sel) sel.value = name;
}
setStyle('minimal');

// Print mode: emit every slide inline, one per page, so @media print paginates.
if (new URLSearchParams(location.search).get('print') === '1') {
  document.body.classList.add('print');
  const m = document.getElementById('main'); m.innerHTML = '';
  slides.forEach((s) => {
    const d = document.createElement('div'); d.className = 'stage';
    d.innerHTML = '<img src="' + s.src + '"><div class="lower" id="cap-p">' + (s.caption || s.name) + '</div>' +
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
  function clearAnim() { TRANSITIONS.forEach((c) => shot.classList.remove(c)); }
  function triggerEntry(trans) {
    clearAnim(); void shot.offsetWidth;  // force reflow
    shot.style.setProperty('--tin',  '800ms');
    shot.style.setProperty('--tout', '800ms');
    shot.classList.add(trans);
  }
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
    if (document.body.classList.contains('demo')) {
      // Pick a random transition per slide, and a random style every 3 slides.
      triggerEntry(TRANSITIONS[(Math.random() * TRANSITIONS.length) | 0]);
      if (i % 3 === 0) setStyle(STYLES[(Math.random() * STYLES.length) | 0]);
    } else {
      // Even outside demo mode give a small fade on swap.
      triggerEntry('t-fade-in');
    }
  }
  show(0);
  shot.onclick = () => { document.getElementById('lbImg').src = shot.src; document.getElementById('lb').classList.add('show'); };
  document.getElementById('lb').onclick = () => document.getElementById('lb').classList.remove('show');
  function togglePlay() {
    playing = !playing;
    const pb = document.getElementById('playBtn');
    if (pb) { pb.classList.toggle('on', playing); pb.textContent = playing ? '⏸ Pause' : '▶ Play'; }
    if (playing) playTimer = setInterval(() => { show((i + 1) % slides.length); }, 3000);
    else { clearInterval(playTimer); playTimer = null; }
  }
  function toggleDemo() {
    document.body.classList.toggle('demo');
    const db = document.getElementById('demoBtn');
    const on = document.body.classList.contains('demo');
    if (db) db.classList.toggle('on', on);
    if (on) {
      if (!playing) togglePlay();
      setStyle(STYLES[(Math.random() * STYLES.length) | 0]);
      show(i);
    }
  }
  document.getElementById('styleSel')?.addEventListener('change', (e) => setStyle(e.target.value));
  document.getElementById('playBtn')?.addEventListener('click', togglePlay);
  document.getElementById('demoBtn')?.addEventListener('click', toggleDemo);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') show(i + 1);
    else if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key.toLowerCase() === 'f') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    } else if (e.key.toLowerCase() === 's') {
      setStyle(STYLES[(Math.random() * STYLES.length) | 0]);
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
    if (pathname === '/effects.css')    return serveFile(res, path.join(WEB, 'effects.css'));
    if (pathname === '/favicon.ico')    return serveFile(res, path.join(WEB, 'logos', 'favicon.ico'));
    if (pathname.startsWith('/logos/')) {
      const rel = pathname.slice('/logos/'.length);
      const full = safeJoin(path.join(WEB, 'logos'), rel);
      if (!full) { res.writeHead(403); res.end(); return; }
      return serveFile(res, full);
    }

    // static: screenshots
    if (pathname.startsWith('/screenshots/')) {
      const rel = pathname.slice('/screenshots/'.length);
      const full = safeJoin(SHOTS, rel);
      if (!full) { res.writeHead(403); res.end(); return; }
      return serveFile(res, full);
    }

    // static: galleries/<name_YYYYMMDD-HHMMSS>/*  (built by /api/export/gallery)
    if (pathname.startsWith('/galleries/')) {
      const rel = pathname.slice('/galleries/'.length);
      const full = safeJoin(GALLERIES, rel);
      if (!full) { res.writeHead(403); res.end(); return; }
      return serveFile(res, full);
    }
    // static: videos/<name_YYYYMMDD-HHMMSS>/*  (built by /api/export/video)
    if (pathname.startsWith('/videos/')) {
      const rel = pathname.slice('/videos/'.length);
      const full = safeJoin(VIDEOS, rel);
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
      // Body may include a relative path to a folder under ROOT (e.g.
      // 'videos/bit_playground_20260422-191524'). Omitted body = open SHOTS.
      let target = SHOTS;
      try {
        const body = await readBody(req);
        if (body && typeof body.path === 'string' && body.path) {
          const abs = safeJoin(ROOT, body.path);
          if (!abs) return json(res, 400, { error: 'invalid path' });
          target = abs;
        }
      } catch {}
      if (!fs.existsSync(target)) {
        // If the target was a file inside a run dir, open its parent instead.
        const parent = path.dirname(target);
        if (fs.existsSync(parent)) target = parent;
        else return json(res, 404, { error: 'not found' });
      }
      if (fs.statSync(target).isFile()) target = path.dirname(target);
      const platform = process.platform;
      const cmd = platform === 'win32' ? 'explorer'
                : platform === 'darwin' ? 'open'
                : 'xdg-open';
      try {
        const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
        child.unref();
        return json(res, 200, { ok: true, opened: target });
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
        await page.goto(`http://localhost:${ACTIVE_PORT}/promo.html?${q.toString()}`, { waitUntil: 'networkidle' });
        await page.waitForFunction('window.__promoReady === true', null, { timeout: 15000 });
        await page.screenshot({ path: outPath, type: 'png' });
        await browser.close();
        return json(res, 200, { ok: true, file: `${app}/${EXPORTS_SUBDIR}/${outFile}`, w: fmt.w, h: fmt.h });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    // POST /api/export/gallery  body: { app, title }
    // Builds a self-contained gallery.html (all screenshots inlined as base64)
    // into galleries/<slug>_<YYYYMMDD-HHMMSS>/.
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
      // Timestamped run folder under galleries/, so each build keeps its own
      // copy instead of overwriting the previous one.
      const runName = slugName(title || app) + '_' + stamp();
      const runDir = path.join(GALLERIES, runName);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'gallery.html'), buildGalleryHtml(title, slides));
      fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({
        title, app, ts: Date.now(), count: slides.length,
        sources: files,
      }, null, 2));
      return json(res, 200, { ok: true, file: `galleries/${runName}/gallery.html`, run: runName, count: slides.length });
    }

    // POST /api/export/pdf  body: { run }  or legacy { app }
    // run = gallery run folder (as returned by /api/export/gallery).
    if (pathname === '/api/export/pdf' && req.method === 'POST') {
      const body = await readBody(req);
      const run = String(body.run || '').replace(/[^\w.-]/g, '');
      if (!run) return json(res, 400, { error: 'run (gallery folder) required' });
      const runDir = path.join(GALLERIES, run);
      const galleryAbs = path.join(runDir, 'gallery.html');
      if (!fs.existsSync(galleryAbs)) return json(res, 400, { error: 'gallery.html not found in run folder' });
      const outPath = path.join(runDir, 'gallery.pdf');
      try {
        const { chromium } = require('playwright');
        const browser = await chromium.launch();
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`http://localhost:${ACTIVE_PORT}/galleries/${encodeURIComponent(run)}/gallery.html?print=1`, { waitUntil: 'networkidle' });
        await page.pdf({ path: outPath, format: 'Letter', printBackground: true, landscape: true, margin: { top: '0.3in', bottom: '0.3in', left: '0.3in', right: '0.3in' } });
        await browser.close();
        return json(res, 200, { ok: true, file: `galleries/${run}/gallery.pdf` });
      } catch (e) { return json(res, 500, { error: 'PDF export failed: ' + e.message }); }
    }

    // GET /api/audio/list — populate the dashboard's audio dropdown from
    // audio/library/ and audio/uploads/.
    if (pathname === '/api/audio/list' && req.method === 'GET') {
      return json(res, 200, { tracks: listAudioTracks() });
    }
    // GET /audio/<library|uploads|cache>/<file> — serve audio files for
    // preview / browser playback (small 50 MB cap).
    if (pathname.startsWith('/audio/') && req.method === 'GET') {
      const rel = pathname.slice('/audio/'.length);
      const abs = safeJoin(path.join(ROOT, 'audio'), rel);
      if (!abs) { res.writeHead(400); return res.end(); }
      if (!/^(library|uploads|cache)[\\/]/.test(decodeURIComponent(rel))) { res.writeHead(400); return res.end(); }
      return serveFile(res, abs);
    }

    // GET /api/export/video/batch/status
    // Poll this to drive the batch progress UI — cheap, no side effects.
    if (pathname === '/api/export/video/batch/status' && req.method === 'GET') {
      return json(res, 200, {
        running:   videoBatch.running,
        runName:   videoBatch.runName,
        current:   videoBatch.current,
        done:      videoBatch.done.length,
        failed:    videoBatch.failed.length,
        total:     videoBatch.total,
        remaining: videoBatch.modes.length,
        stopRequested: videoBatch.stopRequested,
        elapsedMs: videoBatch.startedAt ? Date.now() - videoBatch.startedAt : 0,
        doneList:   videoBatch.done.map((d) => ({ mode: d.mode, ms: d.ms })),
        failedList: videoBatch.failed,
      });
    }
    if (pathname === '/api/export/video/batch/stop' && req.method === 'POST') {
      if (!videoBatch.running) return json(res, 200, { ok: true, nothing: true });
      videoBatch.stopRequested = true;
      return json(res, 200, { ok: true });
    }

    // POST /api/export/video/batch
    // body: { modes?: ['minimal','nasa',...], all?: bool, silent?: bool, ...same shape as single export (shots/app/format/frameMs/fps/watermark/title/bgMusic) }
    // Renders each mode sequentially into one run folder, then emits a
    // compare.html grid and batch.json summary.
    if (pathname === '/api/export/video/batch' && req.method === 'POST') {
      if (videoBatch.running) return json(res, 409, { error: 'a batch render is already running' });
      const body = await readBody(req);
      // Resolve modes
      let modes;
      if (body.all === true) modes = [...ALL_VIDEO_MODES];
      else if (Array.isArray(body.modes) && body.modes.length) {
        modes = body.modes.filter((m) => ALL_VIDEO_MODES.includes(m));
      } else {
        return json(res, 400, { error: 'modes[] or all:true required' });
      }
      if (!modes.length) return json(res, 400, { error: 'no valid modes selected' });
      // Resolve shots (shared across modes)
      const fmt = VIDEO_FORMATS[body.format] || VIDEO_FORMATS.reel;
      let shotPaths = [];
      let outApp = '';
      if (Array.isArray(body.shots) && body.shots.length) {
        shotPaths = body.shots.map(String).filter((s) => safeJoin(SHOTS, s) && fs.existsSync(safeJoin(SHOTS, s)));
        if (!shotPaths.length) return json(res, 400, { error: 'no valid shots in selection' });
        outApp = shotPaths[0].split(/[\\/]/)[0] || 'manual';
      } else {
        const app = String(body.app || '').replace(/[^\w.-]/g, '');
        if (!app) return json(res, 400, { error: 'shots[] or app required' });
        const dir = path.join(SHOTS, app);
        if (!fs.existsSync(dir)) return json(res, 404, { error: 'app folder not found' });
        const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
        if (!files.length) return json(res, 400, { error: 'no screenshots to export' });
        shotPaths = files.map((f) => `${app}/${f}`);
        outApp = app;
      }
      // Resolve audio once for the whole batch — all modes share the same track
      let audioPath = null;
      if (!body.silent && body.audio) {
        const ar = await resolveAudioSource(body.audio);
        if (ar.ok) audioPath = ar.path;
        else console.warn('[audio] resolve failed for', body.audio, '→', ar.error);
      }
      // Set up the run folder
      const runName = slugName(body.title || outApp) + '_batch_' + stamp();
      const runDir  = path.join(VIDEOS, runName);
      fs.mkdirSync(runDir, { recursive: true });
      const errDir = path.join(runDir, 'errors');
      // Prime batch state and kick off the loop in the background. Respond
      // immediately — caller polls /batch/status for progress.
      resetVideoBatch();
      Object.assign(videoBatch, {
        running: true, runName, runDir,
        modes: [...modes], total: modes.length,
        startedAt: Date.now(),
      });
      (async () => {
        try {
          while (videoBatch.modes.length && !videoBatch.stopRequested) {
            const mode = videoBatch.modes.shift();
            videoBatch.current = mode;
            videoBatch.modeStartedAt = Date.now();
            const base = `video-${slugName(mode)}`;
            const r = await renderOneVideoMode({
              shotPaths, fmt,
              frameMs:   Number(body.frameMs || 2500),
              fps:       Number(body.fps || 30),
              watermark: body.watermark || '',
              style:     mode,
              bgMusic:   body.bgMusic || '',
              outDir:    runDir,
              baseName:  base,
              silent:    !!body.silent,
              audioPath,
              volume:    Number(body.volume    ?? 70),
              fadeInMs:  Number(body.fadeInMs  ?? 500),
              fadeOutMs: Number(body.fadeOutMs ?? 500),
            });
            if (r.ok) {
              videoBatch.done.push({ mode, webm: `${base}.webm`, ms: r.ms });
              // collect transcode promise; attach mode so we can link mp4 later
              videoBatch.transcodes.push(r.mp4Promise.then((mp4) => ({ mode, ...mp4 })));
            } else {
              videoBatch.failed.push({ mode, error: r.error });
              try {
                fs.mkdirSync(errDir, { recursive: true });
                fs.writeFileSync(path.join(errDir, `${slugName(mode)}.txt`), r.error || 'unknown error');
              } catch {}
            }
          }
          // drain transcodes (fire-and-forget while we were rendering)
          const transcodeResults = await Promise.all(videoBatch.transcodes);
          // attach mp4 names to done entries
          for (const tr of transcodeResults) {
            const d = videoBatch.done.find((x) => x.mode === tr.mode);
            if (d && tr.ok) d.mp4 = `video-${slugName(tr.mode)}.mp4`;
          }
          // batch.json summary
          fs.writeFileSync(path.join(runDir, 'batch.json'), JSON.stringify({
            title: body.title || '', app: outApp, format: body.format, fmt, fps: Number(body.fps || 30),
            frameMs: Number(body.frameMs || 2500), watermark: body.watermark || '', silent: !!body.silent,
            ts: Date.now(), modes, done: videoBatch.done, failed: videoBatch.failed,
            stopped: videoBatch.stopRequested, elapsedMs: Date.now() - videoBatch.startedAt,
            sources: shotPaths,
          }, null, 2));
          // compare.html — grid of all successful renders, autoplay muted loop
          try {
            const tiles = videoBatch.done.map((d) => {
              const src = d.mp4 || d.webm;
              return `<figure><video src="${src}" autoplay muted loop playsinline></video><figcaption>${escapeHtmlSafe(d.mode)}</figcaption></figure>`;
            }).join('\n    ');
            const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>video modes — ${escapeHtmlSafe(runName)}</title>
<style>
  html,body{margin:0;background:#0f1419;color:#e6edf3;font:13px/1.4 system-ui,sans-serif;}
  header{padding:14px 20px;border-bottom:1px solid #30363d;}
  header h1{margin:0;font-size:18px;} header p{margin:4px 0 0;color:#8b949e;font-size:12px;}
  main{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;padding:20px;}
  figure{margin:0;background:#161b22;border:1px solid #30363d;border-radius:6px;overflow:hidden;}
  figure video{width:100%;display:block;background:#000;}
  figcaption{padding:6px 10px;color:#58a6ff;font-family:monospace;font-size:12px;border-top:1px solid #30363d;}
</style></head>
<body>
  <header>
    <h1>video modes — ${escapeHtmlSafe(body.title || outApp)}</h1>
    <p>${videoBatch.done.length} ok · ${videoBatch.failed.length} failed · ${fmt.w}×${fmt.h} · ${shotPaths.length} frame(s) · rendered ${new Date().toISOString()}</p>
  </header>
  <main>
    ${tiles}
  </main>
</body></html>`;
            fs.writeFileSync(path.join(runDir, 'compare.html'), html);
          } catch (e) { console.error('compare.html write failed:', e.message); }
        } catch (e) {
          videoBatch.failed.push({ mode: videoBatch.current || '(batch)', error: e.message });
        } finally {
          videoBatch.running = false;
          videoBatch.current = null;
        }
      })();
      return json(res, 202, { ok: true, runName, total: modes.length });
    }

    // POST /api/export/video
    // body: { app, format: 'reel'|'square'|'feed'|'youtube', frameMs, fps, watermark }
    // Renders web/slideshow.html in Playwright at the chosen size and records
    // it via MediaRecorder. If ffmpeg is on PATH, auto-transcodes to mp4.
    if (pathname === '/api/export/video' && req.method === 'POST') {
      const body = await readBody(req);
      const fmt = VIDEO_FORMATS[body.format] || VIDEO_FORMATS.reel;
      // Two selection modes:
      //   shots: ["app/file.png", ...] — pick a specific ordered list of
      //                                  screenshots (may span multiple apps).
      //   app:   "folder"              — every png/jpg under screenshots/<app>/.
      // At least one is required.
      let shotPaths = [];
      let outApp = '';
      if (Array.isArray(body.shots) && body.shots.length) {
        shotPaths = body.shots
          .map((s) => String(s))
          .filter((s) => safeJoin(SHOTS, s) && fs.existsSync(safeJoin(SHOTS, s)));
        if (!shotPaths.length) return json(res, 400, { error: 'no valid shots in selection' });
        outApp = shotPaths[0].split(/[\\/]/)[0] || 'manual';
      } else {
        const app = String(body.app || '').replace(/[^\w.-]/g, '');
        if (!app) return json(res, 400, { error: 'shots[] or app required' });
        const dir = path.join(SHOTS, app);
        if (!fs.existsSync(dir)) return json(res, 404, { error: 'app folder not found' });
        const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
        if (!files.length) return json(res, 400, { error: 'no screenshots to export' });
        shotPaths = files.map((f) => `${app}/${f}`);
        outApp = app;
      }
      const frameMs = Number(body.frameMs || 2500);
      const fps = Number(body.fps || 30);
      const cfg = {
        fps,
        watermark: body.watermark || '',
        style:     body.style     || 'minimal',
        bgMusic:   body.bgMusic   || '',
        frames: shotPaths.map((rel) => {
          const abs = safeJoin(SHOTS, rel);
          let meta = {};
          const sidecar = abs.replace(/\.[^.]+$/, '.json');
          if (fs.existsSync(sidecar)) { try { meta = JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch {} }
          return {
            img: '/screenshots/' + rel.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'),
            caption: meta.caption || '',
            note:    meta.note    || '',
            durationMs: frameMs,
          };
        }),
      };
      // Resolve audio (optional) — the mp4 transcode will mux it over the video.
      let audioPath = null;
      if (!body.silent && body.audio) {
        const ar = await resolveAudioSource(body.audio);
        if (ar.ok) audioPath = ar.path;
        else console.warn('[audio] resolve failed for', body.audio, '→', ar.error);
      }
      // Timestamped run folder under videos/, like galleries/ — each render
      // keeps its own directory with webm/mp4/meta.json.
      const runName = slugName(body.title || outApp) + '_' + stamp();
      const outDir = path.join(VIDEOS, runName);
      fs.mkdirSync(outDir, { recursive: true });
      const webmOut = path.join(outDir, `video-${body.format}.webm`);
      try {
        const { chromium } = require('playwright');
        const q = encodeURIComponent(JSON.stringify(cfg));
        const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
        const ctx = await browser.newContext({
          viewport: { width: fmt.w, height: fmt.h },
          // 2× DPR so text + UI chrome render crisp; video file stays at the
          // target w×h because recordVideo.size is fixed below, but the
          // rasterization is from a 2× surface — much sharper images.
          deviceScaleFactor: 2,
          recordVideo: { dir: outDir, size: { width: fmt.w, height: fmt.h } },
        });
        const page = await ctx.newPage();
        // domcontentloaded + explicit readiness signal — 'networkidle' can
        // hang because Playwright keeps HTTP/1.1 connections alive.
        await page.goto(`http://localhost:${ACTIVE_PORT}/slideshow.html?config=${q}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('window.__slideshowReady === true', null, { timeout: 60000 });
        const duration = await page.evaluate('window.__slideshowDurationMs');
        await page.evaluate('window.__slideshowStart = true');
        await page.waitForFunction('window.__slideshowDone === true', null, { timeout: duration + 10000 });
        const video = page.video();
        await page.close();
        const tempPath = await video.path();
        await ctx.close();
        await browser.close();
        fs.renameSync(tempPath, webmOut);
        // Try mp4 transcode if ffmpeg is on PATH — mux audio in if provided.
        let finalFile = `videos/${runName}/video-${body.format}.webm`;
        try {
          const mp4Out = webmOut.replace(/\.webm$/, '.mp4');
          const useAudio = !!audioPath;
          const args = ['-y', '-i', webmOut];
          if (useAudio) args.push('-stream_loop', '-1', '-i', audioPath);
          args.push(
            '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
          );
          if (useAudio) {
            const videoSeconds = (shotPaths.length * frameMs) / 1000;
            const vol     = Math.max(0, Math.min(1, Number(body.volume    ?? 70) / 100));
            const fadeIn  = Math.max(0, Number(body.fadeInMs  ?? 500) / 1000);
            const fadeOut = Math.max(0, Number(body.fadeOutMs ?? 500) / 1000);
            const fadeOutStart = Math.max(0, videoSeconds - fadeOut).toFixed(2);
            const afilter = [
              `volume=${vol}`,
              fadeIn  > 0 ? `afade=t=in:st=0:d=${fadeIn}` : null,
              fadeOut > 0 ? `afade=t=out:st=${fadeOutStart}:d=${fadeOut}` : null,
            ].filter(Boolean).join(',');
            args.push('-c:a', 'aac', '-b:a', '192k', '-af', afilter, '-shortest');
          }
          args.push(mp4Out);
          await new Promise((resolve, reject) => {
            const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
            ff.on('error', reject);
            ff.on('exit', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)));
          });
          finalFile = `videos/${runName}/video-${body.format}.mp4`;
        } catch { /* ffmpeg missing or failed — keep webm */ }
        fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
          title: body.title || '', app: outApp, format: body.format, style: body.style || 'minimal',
          ts: Date.now(), frames: cfg.frames.length, w: fmt.w, h: fmt.h, frameMs,
          sources: shotPaths,
        }, null, 2));
        return json(res, 200, { ok: true, file: finalFile, run: runName, w: fmt.w, h: fmt.h, frames: cfg.frames.length });
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
    ACTIVE_PORT = p;
    console.log(`route-shot dashboard  →  http://localhost:${p}`);
  });
}
let ACTIVE_PORT = PORT;   // updated by listenWithFallback once bound
listenWithFallback(PORT);
