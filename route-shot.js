#!/usr/bin/env node
// route-shot — visit every same-origin route from START_URL and screenshot each one.
//
// Setup:
//   npm install
//   npx playwright install chromium
//
// Run:
//   node route-shot.js
//   START_URL=http://localhost:8080 node route-shot.js
//   # or, after `npm install -g .`:
//   START_URL=http://localhost:8080 route-shot

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// --- config -----------------------------------------------------------------
// URL precedence: CLI arg > $START_URL > default
const START_URL    = process.argv[2] || process.env.START_URL || 'http://localhost:3000';
const OUTPUT_DIR   = process.env.OUTPUT_DIR || 'screenshots';
const MAX_PAGES    = Number(process.env.MAX_PAGES || 200);
const NAV_TIMEOUT  = Number(process.env.NAV_TIMEOUT || 15000);
const INCLUDE_HASH = process.env.INCLUDE_HASH === '1';
// Optional CSS selector(s) to click after each navigation (e.g. "Let's Go" button,
// cookie banner). Comma-separated for multiple selectors, each tried in order.
const DISMISS_SELECTOR = process.env.DISMISS_SELECTOR || '';
const DISMISS_WAIT     = Number(process.env.DISMISS_WAIT || 400);
// Optional comma-separated CSS selectors to click *after* the main screenshot,
// capturing a variant screenshot for each. Useful for SPA tabs/buttons that
// change view state without changing URL. Clicks are applied sequentially on
// the same page, matching tab-like navigation.
const CLICK_SELECTORS = process.env.CLICK_SELECTORS || '';
const CLICK_WAIT      = Number(process.env.CLICK_WAIT || 500);
// ----------------------------------------------------------------------------

function slugify(url) {
  return (
    url
      .replace(/^https?:\/\//, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'index'
  );
}

function normalize(href, origin) {
  try {
    const u = new URL(href, origin);
    if (u.origin !== origin) return null;           // same-origin only
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (!INCLUDE_HASH) u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);         // trim trailing slash
    }
    return u.toString();
  } catch {
    return null;
  }
}

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page    = await context.newPage();

  const origin  = new URL(START_URL).origin;
  const seed    = normalize(START_URL, origin);
  const queue   = [seed];
  const seen    = new Set([seed]);
  const results = [];

  while (queue.length && results.length < MAX_PAGES) {
    const url = queue.shift();
    const idx = results.length + 1;
    process.stdout.write(`[${idx}] ${url} ... `);

    try {
      const resp   = await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
      const status = resp ? resp.status() : 0;

      if (DISMISS_SELECTOR) {
        for (const sel of DISMISS_SELECTOR.split(',').map((s) => s.trim()).filter(Boolean)) {
          try {
            const el = await page.$(sel);
            if (el) {
              await el.click({ timeout: 1000 });
              await page.waitForTimeout(DISMISS_WAIT);
            }
          } catch { /* ignore — selector not present or not clickable */ }
        }
      }

      const baseSlug = slugify(url);
      const filename = `${String(idx).padStart(3, '0')}_${baseSlug}.png`;
      await page.screenshot({
        path: path.join(OUTPUT_DIR, filename),
        fullPage: true,
      });

      const variants = [];
      if (CLICK_SELECTORS) {
        const sels = CLICK_SELECTORS.split(',').map((s) => s.trim()).filter(Boolean);
        let vi = 0;
        for (const sel of sels) {
          vi++;
          try {
            const el = await page.$(sel);
            if (!el) { variants.push({ selector: sel, skipped: 'not found' }); continue; }
            await el.click({ timeout: 2000 });
            await page.waitForTimeout(CLICK_WAIT);
            const vname = `${String(idx).padStart(3, '0')}_${baseSlug}__v${String(vi).padStart(2, '0')}_${slugify(sel)}.png`;
            await page.screenshot({ path: path.join(OUTPUT_DIR, vname), fullPage: true });
            variants.push({ selector: sel, screenshot: vname });
          } catch (e) {
            variants.push({ selector: sel, error: e.message });
          }
        }
      }

      const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
      let discovered = 0;
      for (const href of hrefs) {
        const n = normalize(href, origin);
        if (n && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
          discovered++;
        }
      }

      const entry = { url, status, screenshot: filename };
      if (variants.length) entry.variants = variants;
      results.push(entry);
      const vnote = variants.length ? `, ${variants.length} variant(s)` : '';
      console.log(`${status} (+${discovered} new${vnote})`);
    } catch (err) {
      results.push({ url, error: err.message });
      console.log(`✗ ${err.message}`);
    }
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'index.json'),
    JSON.stringify({ start: START_URL, count: results.length, pages: results }, null, 2)
  );

  console.log(`\nDone. ${results.length} pages captured in ./${OUTPUT_DIR}/`);
  await browser.close();
})();
