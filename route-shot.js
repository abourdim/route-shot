#!/usr/bin/env node
// route-shot — visit every same-origin route from a start URL and screenshot each one.
//
// Single app:
//   node route-shot.js https://example.com
//
// Batch (many apps, each with its own dismiss/click selectors):
//   node route-shot.js --batch apps.json

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// --- defaults (used when a field is missing from the app config) ------------
const DEFAULTS = {
  outputDir:   process.env.OUTPUT_DIR   || 'screenshots',
  maxPages:    Number(process.env.MAX_PAGES   || 200),
  navTimeout:  Number(process.env.NAV_TIMEOUT || 15000),
  includeHash: process.env.INCLUDE_HASH === '1',
  dismiss:     process.env.DISMISS_SELECTOR || '',
  dismissWait: Number(process.env.DISMISS_WAIT || 400),
  clicks:      process.env.CLICK_SELECTORS || '',
  clickWait:   Number(process.env.CLICK_WAIT || 500),
  clickMode:   process.env.CLICK_MODE || 'sequential', // 'sequential' | 'independent'
  autoButtons: process.env.AUTO_BUTTONS === '1',
  autoButtonsSelector: process.env.AUTO_BUTTONS_SELECTOR ||
    'button, [role=button], input[type=button], input[type=submit]',
  autoButtonsBlocklist: process.env.AUTO_BUTTONS_BLOCKLIST ||
    'delete|remove|clear|stop|reset|pay|confirm|send|logout|sign.?out',
  autoButtonsMax: Number(process.env.AUTO_BUTTONS_MAX || 40),
  // Recursive auto-exploration: after each auto-click, optionally discover
  // newly-revealed buttons and click them too (BFS over click paths).
  // 0 = off (flat), 1 = click-then-click, etc. Kept low to bound state space.
  maxDepth:    Number(process.env.MAX_DEPTH || 0),
  // Launch visible Chromium instead of headless — handy for debugging modals.
  headful:     process.env.HEADFUL === '1',
};

function slugify(s, fallback = 'item') {
  return (
    String(s)
      .replace(/^https?:\/\//, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || fallback
  );
}

// Short, stable hash for when slugify() empties a label (emoji-only text, etc).
function shortHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 6);
}

function normalize(href, origin, includeHash) {
  try {
    const u = new URL(href, origin);
    if (u.origin !== origin) return null;
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (!includeHash) u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

function toList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

// Replay a list of setup steps (login flow, onboarding dismissal, etc.).
// Supports the subset of actions DevTools Recorder exports commonly produce.
async function runSteps(page, steps, navTimeout) {
  for (const step of steps) {
    const { action } = step;
    if (action === 'goto')            await page.goto(step.value || step.url, { waitUntil: 'networkidle', timeout: navTimeout });
    else if (action === 'click')      await page.locator(step.selector).first().click({ timeout: 5000 });
    else if (action === 'fill')       await page.locator(step.selector).first().fill(step.value ?? '', { timeout: 5000 });
    else if (action === 'press')      await page.locator(step.selector).first().press(step.value || 'Enter', { timeout: 5000 });
    else if (action === 'waitForSelector') await page.waitForSelector(step.selector, { timeout: step.timeout || 10000 });
    else if (action === 'waitForURL') await page.waitForURL(step.value || step.url, { timeout: step.timeout || 10000 });
    else if (action === 'wait')       await page.waitForTimeout(Number(step.value || step.ms || 500));
    else throw new Error(`unknown preStep action: ${action}`);
  }
}

async function dismissAll(page, selectors, waitMs) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ timeout: 1000 });
        // wait for the dismiss target to disappear (modal fade-out) before moving on
        await page.waitForSelector(sel, { state: 'hidden', timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(waitMs);
      }
    } catch { /* ignore */ }
  }
}

// Capture one URL: main screenshot + click variants. Returns a page-result object.
async function captureUrl(page, url, idx, cfg, outDir) {
  const dismiss = toList(cfg.dismiss);
  const clicks  = toList(cfg.clicks);
  const mode    = cfg.clickMode || 'sequential';

  const resp   = await page.goto(url, { waitUntil: 'networkidle', timeout: cfg.navTimeout });
  const status = resp ? resp.status() : 0;
  await dismissAll(page, dismiss, cfg.dismissWait);

  const baseSlug = slugify(url);
  const filename = `${String(idx).padStart(3, '0')}_${baseSlug}.png`;
  await page.screenshot({ path: path.join(outDir, filename), fullPage: true });

  const variants = [];
  let vi = 0;

  // Discover auto-buttons on the current page state. Dedupes by outerHTML-hash
  // (stricter than text — two buttons with same label but different attrs are
  // treated as distinct) AND by visible label (so we don't re-click the same
  // stateful button after a rerender changed its outerHTML).
  async function discoverAutoButtons(seenHtmlHashes, seenLabels, explicitLabels) {
    const block = new RegExp(cfg.autoButtonsBlocklist, 'i');
    const rows = await page.$$eval(cfg.autoButtonsSelector, (els) =>
      els.map((e) => {
        const raw = (e.innerText || e.value || e.getAttribute('aria-label') || '').trim();
        return {
          label: raw.replace(/\s+/g, ' '),
          html: e.outerHTML.replace(/\s+/g, ' ').slice(0, 200),
        };
      })
    );
    const out = [];
    for (const r of rows) {
      if (!r.label) continue;
      if (block.test(r.label)) continue;
      if (explicitLabels.has(r.label)) continue;
      const hh = shortHash(r.html);
      if (seenHtmlHashes.has(hh)) continue;
      if (seenLabels.has(r.label)) continue;
      seenHtmlHashes.add(hh);
      seenLabels.add(r.label);
      out.push({ auto: true, label: r.label });
      if (out.length + seenHtmlHashes.size >= cfg.autoButtonsMax) break;
    }
    return out;
  }

  const autoItems = [];
  let autoSeenHtml = new Set();
  let autoSeenLabel = new Set();
  const explicitLabels = new Set(clicks
    .map((s) => (s.match(/has-text\(["'](.+?)["']\)/) || s.match(/text-is\(["'](.+?)["']\)/) || [])[1])
    .filter(Boolean));
  if (cfg.autoButtons) {
    autoItems.push(...(await discoverAutoButtons(autoSeenHtml, autoSeenLabel, explicitLabels)));
  }

  const explicitItems = clicks.map((sel) => {
    const m = sel.match(/has-text\(["'](.+?)["']\)/) || sel.match(/text-is\(["'](.+?)["']\)/);
    return { auto: false, selector: sel, label: m ? m[1] : null };
  });
  const items = [...explicitItems, ...autoItems];

  for (let ci = 0; ci < items.length; ci++) {
    const item = items[ci];
    const effectiveMode = item.auto ? 'independent' : mode;
    vi++;
    if (effectiveMode === 'independent') {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: cfg.navTimeout });
        await dismissAll(page, dismiss, cfg.dismissWait);
      } catch (e) {
        variants.push({ label: item.label, error: `reload failed: ${e.message}` });
        continue;
      }
    }
    try {
      // For auto items use exact role-based match (resolves ambiguity when
      // multiple elements share text). For explicit, use the raw selector.
      const locator = item.auto
        ? page.getByRole('button', { name: item.label, exact: true }).first()
        : page.locator(item.selector).first();
      const count = await locator.count();
      if (!count) { variants.push({ label: item.label, selector: item.selector, skipped: 'not found', auto: item.auto || undefined }); continue; }
      await locator.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      await locator.click({ timeout: 3000 });
      await page.waitForTimeout(cfg.clickWait);
      const labelSlug = item.label ? slugify(item.label, '') : '';
      const selSlug   = item.selector ? slugify(item.selector, '').slice(0, 40) : '';
      // if slugify stripped everything (emoji-only label), append a short hash
      // of the raw label so each icon gets a unique, readable suffix
      const hashPart  = item.label && !labelSlug ? `emoji_${shortHash(item.label)}` : '';
      const suffix    = labelSlug || hashPart || selSlug || `v${vi}`;
      const vname = `${String(idx).padStart(3, '0')}_${baseSlug}__v${String(vi).padStart(2, '0')}_${suffix}.png`;
      await page.screenshot({ path: path.join(outDir, vname), fullPage: true });
      const entry = { label: item.label, screenshot: vname };
      if (item.selector) entry.selector = item.selector;
      if (item.auto) entry.auto = true;
      variants.push(entry);
    } catch (e) {
      variants.push({ label: item.label, selector: item.selector, error: e.message, auto: item.auto || undefined });
    }
  }

  // Recursive depth exploration (opt-in, auto-only). BFS over click paths:
  // after an auto-click, re-discover clickables and queue each as depth+1.
  // State restore = reload + dismiss + replay path.
  if (cfg.autoButtons && cfg.maxDepth > 0) {
    // seed queue with depth-1 paths (each successful flat click becomes a seed)
    const depthQueue = autoItems.map((it) => [it.label]);
    while (depthQueue.length) {
      const pathLabels = depthQueue.shift();
      if (pathLabels.length > cfg.maxDepth) continue;
      // restore state: reload → dismiss → replay path
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: cfg.navTimeout });
        await dismissAll(page, dismiss, cfg.dismissWait);
        for (const lab of pathLabels) {
          const loc = page.getByRole('button', { name: lab, exact: true }).first();
          if (!(await loc.count())) throw new Error(`path step not found: ${lab}`);
          await loc.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
          await loc.click({ timeout: 3000 });
          await page.waitForTimeout(cfg.clickWait);
        }
      } catch (e) {
        continue; // path no longer reachable — skip children
      }
      // discover newly-revealed buttons, click each one as a leaf
      const newItems = await discoverAutoButtons(autoSeenHtml, autoSeenLabel, explicitLabels);
      for (const it of newItems) {
        vi++;
        try {
          const loc = page.getByRole('button', { name: it.label, exact: true }).first();
          if (!(await loc.count())) { variants.push({ label: it.label, skipped: 'not found', auto: true, depth: pathLabels.length + 1 }); continue; }
          await loc.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
          await loc.click({ timeout: 3000 });
          await page.waitForTimeout(cfg.clickWait);
          const labelSlug = slugify(it.label, '');
          const hashPart  = labelSlug ? '' : `emoji_${shortHash(it.label)}`;
          const suffix    = labelSlug || hashPart || `v${vi}`;
          const pathSlug  = pathLabels.map((l) => slugify(l, '').slice(0, 12)).join('-');
          const vname = `${String(idx).padStart(3, '0')}_${baseSlug}__v${String(vi).padStart(2, '0')}_d${pathLabels.length + 1}_${pathSlug}__${suffix}.png`;
          await page.screenshot({ path: path.join(outDir, vname), fullPage: true });
          variants.push({ label: it.label, screenshot: vname, auto: true, depth: pathLabels.length + 1, path: pathLabels });
          // queue for deeper exploration; restore from fresh for each child
          if (pathLabels.length + 1 < cfg.maxDepth) depthQueue.push([...pathLabels, it.label]);
          // next sibling: restore state again
          await page.goto(url, { waitUntil: 'networkidle', timeout: cfg.navTimeout });
          await dismissAll(page, dismiss, cfg.dismissWait);
          for (const lab of pathLabels) {
            const loc2 = page.getByRole('button', { name: lab, exact: true }).first();
            if (await loc2.count()) { await loc2.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(cfg.clickWait); }
          }
        } catch (e) {
          variants.push({ label: it.label, error: e.message, auto: true, depth: pathLabels.length + 1, path: pathLabels });
        }
      }
    }
  }

  const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
  const entry = { url, status, screenshot: filename };
  if (variants.length) entry.variants = variants;
  return { entry, hrefs };
}

// Crawl one app (BFS over same-origin links).
async function crawlApp(browser, app) {
  const cfg = { ...DEFAULTS, ...app };
  const outDir = path.join(DEFAULTS.outputDir, app.name ? slugify(app.name) : '');
  fs.mkdirSync(outDir, { recursive: true });

  const context = await browser.newContext();
  const page    = await context.newPage();

  const origin  = new URL(cfg.url).origin;
  const seed    = normalize(cfg.url, origin, cfg.includeHash);
  const queue   = [seed];
  const seen    = new Set([seed]);
  const results = [];

  console.log(`\n=== ${app.name || cfg.url} ===`);

  // Run preSteps once (login / onboarding / setup) before crawling.
  // Session cookies and localStorage persist in the context, so subsequent
  // BFS navigations and independent-mode reloads stay authenticated.
  if (Array.isArray(cfg.preSteps) && cfg.preSteps.length) {
    try {
      await page.goto(cfg.url, { waitUntil: 'networkidle', timeout: cfg.navTimeout });
      await runSteps(page, cfg.preSteps, cfg.navTimeout);
      console.log(`  preSteps: ${cfg.preSteps.length} step(s) completed`);
    } catch (e) {
      console.error(`  preSteps failed: ${e.message}`);
    }
  }

  while (queue.length && results.length < cfg.maxPages) {
    const url = queue.shift();
    const idx = results.length + 1;
    process.stdout.write(`[${idx}] ${url} ... `);
    try {
      const { entry, hrefs } = await captureUrl(page, url, idx, cfg, outDir);
      let discovered = 0;
      for (const h of hrefs) {
        const n = normalize(h, origin, cfg.includeHash);
        if (n && !seen.has(n)) { seen.add(n); queue.push(n); discovered++; }
      }
      results.push(entry);
      const vnote = entry.variants ? `, ${entry.variants.length} variant(s)` : '';
      console.log(`${entry.status} (+${discovered} new${vnote})`);
    } catch (err) {
      results.push({ url, error: err.message });
      console.log(`✗ ${err.message}`);
    }
  }

  fs.writeFileSync(
    path.join(outDir, 'index.json'),
    JSON.stringify({ app: app.name || null, start: cfg.url, count: results.length, pages: results }, null, 2)
  );
  await context.close();
  return { name: app.name || null, url: cfg.url, outDir, count: results.length };
}

// Convert a Chrome DevTools Recorder JSON export into route-shot preSteps.
// Recorder schema: { title, steps: [{ type, url?, selectors?, value?, ... }] }
// See https://developer.chrome.com/docs/devtools/recorder/reference
function importRecording(recordingPath, { appName, startUrl } = {}) {
  const rec = JSON.parse(fs.readFileSync(recordingPath, 'utf8'));
  const steps = Array.isArray(rec.steps) ? rec.steps : [];
  const pickSelector = (sels) => {
    if (!Array.isArray(sels) || !sels.length) return null;
    // Recorder stores selectors as [[css], [xpath], ['aria/...', 'aria/...'], ...]
    // Prefer the shortest css-looking one (avoid aria/ and xpath prefixes).
    const flat = sels.map((s) => Array.isArray(s) ? s : [s]).flat();
    const css  = flat.find((s) => typeof s === 'string' && !s.startsWith('aria/') && !s.startsWith('xpath/') && !s.startsWith('pierce/') && !s.startsWith('text/'));
    return css || flat[0];
  };
  const pre = [];
  let inferredUrl = startUrl || null;
  for (const s of steps) {
    switch (s.type) {
      case 'setViewport': // ignore — size isn't a preStep
        break;
      case 'navigate':
        if (!inferredUrl) inferredUrl = s.url;
        pre.push({ action: 'goto', value: s.url });
        break;
      case 'click':
      case 'doubleClick':
        pre.push({ action: 'click', selector: pickSelector(s.selectors) });
        break;
      case 'change':
        pre.push({ action: 'fill', selector: pickSelector(s.selectors), value: s.value ?? '' });
        break;
      case 'keyDown':
      case 'keyUp':
        if (s.key) pre.push({ action: 'press', selector: pickSelector(s.selectors) || 'body', value: s.key });
        break;
      case 'waitForElement':
        pre.push({ action: 'waitForSelector', selector: pickSelector(s.selectors), timeout: s.timeout });
        break;
      case 'waitForURL':
      case 'navigateBack': // approximate
        if (s.url) pre.push({ action: 'waitForURL', value: s.url });
        break;
      default:
        // unrecognized — skip with a comment so user can see what was dropped
        pre.push({ action: 'wait', value: 0, _skipped: `unsupported type: ${s.type}` });
        break;
    }
  }
  return {
    name: appName || rec.title || 'imported-flow',
    url: inferredUrl || 'http://localhost:3000',
    preSteps: pre.filter((s) => !s._skipped),
    autoButtons: true,
  };
}

// --- entry ------------------------------------------------------------------
(async () => {
  const args = process.argv.slice(2);

  // Subcommand: import a DevTools Recorder JSON → apps.json entry (stdout, or merge)
  const importIdx = args.indexOf('--import-recording');
  if (importIdx !== -1) {
    const recPath  = args[importIdx + 1];
    if (!recPath) { console.error('--import-recording requires a path'); process.exit(1); }
    const nameIdx  = args.indexOf('--name');
    const urlIdx   = args.indexOf('--url');
    const mergeIdx = args.indexOf('--merge');
    const appEntry = importRecording(recPath, {
      appName:  nameIdx !== -1 ? args[nameIdx + 1] : undefined,
      startUrl: urlIdx  !== -1 ? args[urlIdx  + 1] : undefined,
    });
    if (mergeIdx !== -1) {
      const target = args[mergeIdx + 1] || 'apps.json';
      const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : { apps: [] };
      const list = existing.apps || existing;
      const i = list.findIndex((a) => a.name === appEntry.name);
      if (i >= 0) list[i] = { ...list[i], ...appEntry }; else list.push(appEntry);
      fs.writeFileSync(target, JSON.stringify(existing.apps ? existing : { apps: list }, null, 2));
      console.log(`Merged into ${target}: ${appEntry.name} (${appEntry.preSteps.length} preSteps)`);
    } else {
      console.log(JSON.stringify(appEntry, null, 2));
    }
    return;
  }

  const batchIdx = args.indexOf('--batch');
  const isBatch  = batchIdx !== -1;

  let apps;
  if (isBatch) {
    const cfgPath = args[batchIdx + 1];
    if (!cfgPath) { console.error('--batch requires a config path'); process.exit(1); }
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    apps = raw.apps || raw; // allow top-level array too
  } else {
    const url = args.find((a) => !a.startsWith('-')) || process.env.START_URL || 'http://localhost:3000';
    apps = [{ url, name: null }];
  }

  fs.mkdirSync(DEFAULTS.outputDir, { recursive: true });
  // headful if any app (or the env var) asks for it — simpler than relaunching per-app
  const headful = DEFAULTS.headful || apps.some((a) => a.headful);
  const browser = await chromium.launch({ headless: !headful });
  const summary = [];
  for (const app of apps) {
    try {
      summary.push(await crawlApp(browser, app));
    } catch (e) {
      console.error(`\n[${app.name || app.url}] failed: ${e.message}`);
      summary.push({ name: app.name || null, url: app.url, error: e.message });
    }
  }
  await browser.close();

  if (isBatch) {
    fs.writeFileSync(
      path.join(DEFAULTS.outputDir, 'index.json'),
      JSON.stringify({ count: summary.length, apps: summary }, null, 2)
    );
  }

  const total = summary.reduce((n, s) => n + (s.count || 0), 0);
  console.log(`\nDone. ${summary.length} app(s), ${total} page(s) total in ./${DEFAULTS.outputDir}/`);
})();
