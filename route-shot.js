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

  // Build click list: explicit clicks (as selectors) + auto-discovered (as
  // {label, role-name} objects for exact role-based matching).
  const autoItems = [];
  if (cfg.autoButtons) {
    const block = new RegExp(cfg.autoButtonsBlocklist, 'i');
    const explicitLabels = new Set(clicks
      .map((s) => (s.match(/has-text\(["'](.+?)["']\)/) || s.match(/text-is\(["'](.+?)["']\)/) || [])[1])
      .filter(Boolean));
    const texts = await page.$$eval(cfg.autoButtonsSelector, (els) =>
      els.map((e) => {
        const raw = (e.innerText || e.value || e.getAttribute('aria-label') || '').trim();
        return raw.replace(/\s+/g, ' ');
      })
    );
    const seenText = new Set();
    for (const t of texts) {
      if (!t) continue;
      if (block.test(t)) continue;
      if (explicitLabels.has(t)) continue;
      if (seenText.has(t)) continue;
      seenText.add(t);
      autoItems.push({ auto: true, label: t });
      if (autoItems.length >= cfg.autoButtonsMax) break;
    }
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

// --- entry ------------------------------------------------------------------
(async () => {
  const args = process.argv.slice(2);
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
  const browser = await chromium.launch();
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
