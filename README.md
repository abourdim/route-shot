# route-shot

Visit every route of a web app and save a full-page screenshot of each one. Built on [Playwright](https://playwright.dev/). Ships with an interactive bash menu for install / launch / cleanup.

![shell](https://img.shields.io/badge/shell-bash-4EAA25) ![node](https://img.shields.io/badge/node-%3E%3D18-339933) ![license](https://img.shields.io/badge/license-MIT-blue)

## What it does

Starting from a URL you provide, `route-shot` does a breadth-first walk of every `<a href>` it finds on the same origin, takes a full-page screenshot of each unique page, and writes an `index.json` mapping URLs → screenshot files + HTTP status.

Stops at a configurable page cap (default 200) so a linky site can't run forever.

## Quick start

```bash
git clone https://github.com/abourdim/route-shot.git
cd route-shot
chmod +x menu.sh
./menu.sh
```

From the menu: **2) Install dependencies** once, then **3) Launch route-shot** any time.

## Requirements

- Node.js 18 or newer
- npm
- Linux or macOS for the menu (the crawler itself runs anywhere Node + Playwright run, including Windows)

## Menu options

| # | Action |
|---|--------|
| 1 | Check install — verifies Node, npm, Playwright module, Chromium |
| 2 | Install dependencies — runs `npm install` + downloads Chromium |
| 3 | Launch route-shot — prompts for a start URL, writes screenshots to `./screenshots/` |
| 4 | Open screenshots folder |
| 5 | Clean screenshots |
| 6 | Exit |

## Specifying the URL

Four ways, in priority order:

```bash
./menu.sh https://example.com              # 1. CLI arg to menu
START_URL=https://example.com ./menu.sh    # 2. env var
./menu.sh                                  # 3. last-used URL (remembered in .last-url)
./menu.sh                                  # 4. default http://localhost:3000
```

The prompt always shows the current best guess as the default — press Enter to accept.

## Running without the menu

```bash
npm install
node route-shot.js https://example.com            # positional arg
START_URL=https://example.com node route-shot.js  # or env var
```

Or install globally and use the `route-shot` command:

```bash
npm install -g .
route-shot https://example.com
```

## Configuration

All options are environment variables — no flags to remember:

| Variable | Default | Meaning |
|---|---|---|
| `START_URL` | `http://localhost:3000` | Where to start the crawl |
| `OUTPUT_DIR` | `screenshots` | Where PNGs and `index.json` land |
| `MAX_PAGES` | `200` | Safety cap on total pages visited |
| `NAV_TIMEOUT` | `15000` | ms per page load |
| `INCLUDE_HASH` | `0` | Set `1` for hash-based routes (`#/about`) |
| `DISMISS_SELECTOR` | _(none)_ | CSS selector(s) to click after each page load — e.g. a welcome modal or cookie banner. Comma-separated for multiple. Missing selectors are silently skipped. |
| `DISMISS_WAIT` | `400` | ms to wait after a dismiss click before screenshotting |
| `CLICK_SELECTORS` | _(none)_ | Comma-separated CSS selectors clicked **after** the main screenshot. Each click is captured as a variant screenshot, applied sequentially on the same page — useful for SPA tabs/buttons that change view state without changing URL. |
| `CLICK_WAIT` | `500` | ms to wait after each click-variant before screenshotting |

Example:

```bash
START_URL=https://example.com MAX_PAGES=50 OUTPUT_DIR=./out node route-shot.js
```

Dismiss a welcome modal before capturing:

```bash
DISMISS_SELECTOR='button:has-text("Let'"'"'s Go")' node route-shot.js https://example.com
```

Capture each SPA tab as a variant screenshot (same URL, different view state):

```bash
DISMISS_SELECTOR='button:has-text("Let'"'"'s Go")' \
CLICK_SELECTORS='button:has-text("Sensors"),button:has-text("Motors"),button:has-text("GamePad"),button:has-text("Graph")' \
node route-shot.js https://abourdim.github.io/bit-playground/
```

## Batch mode (many apps)

Describe every app you want to snapshot in a JSON file, then run:

```bash
node route-shot.js --batch apps.json
```

See [apps.example.json](apps.example.json). Each app supports:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Used for the output subfolder |
| `url` | yes | Start URL |
| `dismiss` | no | Selector(s) clicked after each page load (string or array) |
| `clicks` | no | Selector(s) to capture as variants (string or array) |
| `clickMode` | no | `sequential` (default — clicks accumulate) or `independent` (reload between each, so each click is captured in isolation) |
| `maxPages` | no | Per-app override of `MAX_PAGES` |

Output layout:

```
screenshots/
├── bit-playground/
│   ├── 001_..._bit_playground.png
│   ├── 001_..._bit_playground__v01_button_has_text_Sensors.png
│   ├── ...
│   └── index.json
├── face-quest/
└── index.json            ← roll-up summary
```

Use **`clickMode: "independent"`** when each click should be its own isolated case (icon buttons, sound buttons) and **`"sequential"`** for true tab navigation where state accumulates.

## Output

```
screenshots/
├── 001_localhost_3000.png
├── 002_localhost_3000_about.png
├── 003_localhost_3000_contact.png
└── index.json
```

`index.json` looks like:

```json
{
  "start": "http://localhost:3000",
  "count": 3,
  "pages": [
    { "url": "http://localhost:3000",         "status": 200, "screenshot": "001_localhost_3000.png" },
    { "url": "http://localhost:3000/about",   "status": 200, "screenshot": "002_localhost_3000_about.png" },
    { "url": "http://localhost:3000/contact", "status": 200, "screenshot": "003_localhost_3000_contact.png" }
  ]
}
```

## Limitations

- Follows `<a href>` links only — routes reachable only via button clicks or JS navigation won't be discovered. A click-exploration mode is on the roadmap.
- No login handling out of the box. Add a `page.goto → fill → click` block before the crawl loop; the browser context's cookies will carry through.
- Same-origin only. External links are ignored by design.
- Does not respect `robots.txt` — assumes you own the target.

## Roadmap

- [ ] Multi-viewport capture (desktop / tablet / mobile in one run)
- [ ] Optional button-exploration mode with DOM-diff deduplication
- [ ] HTML report with thumbnails instead of raw folder
- [ ] Auth helper (env-driven login flow)

## License

MIT — see [LICENSE](LICENSE).
