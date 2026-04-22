// route-shot manual-mode widget — injected via addInitScript on every page.
// Provides: Snap button + keyboard shortcuts, live draggable caption,
// 30+ annotation types grouped into a tabbed palette, sidecar metadata.
// Plain IIFE: no bundler, no imports, everything captured via window.__routeShot.
(function() {
  if (window.top !== window) return;  // only in top frame
  // Communication with the dashboard is via window-level flags — Playwright's
  // page.evaluate() polls these server-side, bypassing CORS / mixed content /
  // Playwright-sandbox issues that would block http fetches from the page.
  window.__routeShot = window.__routeShot || { queue: [], results: {}, seq: 0 };
  window.__routeShot.annoStyle = window.__routeShot.annoStyle || { color: '#ff3b30', stroke: 4 };
  window.__routeShot.annoCount = window.__routeShot.annoCount || 0;

  function autoLabel() {
    const pick = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const t = pick(document.title);
    if (t) return t;
    const h1 = document.querySelector('h1');
    if (h1) { const v = pick(h1.innerText); if (v) return v; }
    const p = (location.pathname || '').replace(/^\/+|\/+$/g, '') || 'home';
    return pick(p);
  }

  async function snap(label, caption, note) {
    const finalLabel = (label && label.trim()) || autoLabel();
    const id = ++window.__routeShot.seq;
    window.__routeShot.queue.push({
      id,
      label: finalLabel,
      caption: (caption || '').trim(),
      note: (note || '').trim(),
    });
    return await new Promise((resolve) => {
      const start = Date.now();
      (function poll() {
        if (window.__routeShot.results[id]) {
          const r = window.__routeShot.results[id];
          delete window.__routeShot.results[id];
          return resolve(r);
        }
        if (Date.now() - start > 5000) return resolve({ error: 'timeout waiting for dashboard' });
        setTimeout(poll, 100);
      })();
    });
  }

  function flash(msg, ok) {
    const b = document.createElement('div');
    b.textContent = msg;
    b.style.cssText = 'position:fixed;top:60px;right:16px;z-index:2147483647;padding:8px 14px;background:' +
      (ok ? '#1a7f38' : '#8a1f1f') + ';color:#fff;font:13px/1.4 system-ui;border-radius:4px;' +
      'box-shadow:0 4px 12px rgba(0,0,0,0.4);pointer-events:none;opacity:0.95;';
    document.documentElement.appendChild(b);
    setTimeout(() => b.remove(), 2200);
  }

  // --- shared helpers used by every annotation spawner ---------------------

  function makeDraggable(el, onDrag) {
    el.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('.__rs-anno-bar')) return;
      if (ev.target.classList && ev.target.classList.contains('__rs-handle')) return;
      const rect = el.getBoundingClientRect();
      const dx = ev.clientX - rect.left, dy = ev.clientY - rect.top;
      const onMove = (e) => {
        el.style.left = (e.clientX - dx) + 'px';
        el.style.top  = (e.clientY - dy) + 'px';
        if (onDrag) onDrag();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      ev.preventDefault();
    });
  }

  // Shared per-item toolbar: color / (stroke) / opacity / extra / delete.
  function attachAnnoBar(el, applyFn, opts) {
    opts = opts || {};
    const bar = document.createElement('div');
    bar.className = '__rs-anno-bar';
    bar.style.cssText = 'position:fixed;display:none;gap:6px;z-index:2147483646;' +
      'background:rgba(20,20,20,0.92);padding:6px 8px;border-radius:6px;' +
      'font:12px/1 system-ui;color:#fff;align-items:center;user-select:none;flex-wrap:wrap;max-width:420px;';
    if (!opts.noColor) {
      const cIn = document.createElement('input'); cIn.type = 'color';
      cIn.value = window.__routeShot.annoStyle.color;
      cIn.style.cssText = 'width:24px;height:20px;border:0;background:none;padding:0;';
      cIn.oninput = () => { window.__routeShot.annoStyle.color = cIn.value; applyFn(); };
      bar.appendChild(cIn);
    }
    if (!opts.noStroke) {
      const sIn = document.createElement('input'); sIn.type = 'range';
      sIn.min = '1'; sIn.max = '20'; sIn.step = '1';
      sIn.value = String(window.__routeShot.annoStyle.stroke); sIn.style.width = '60px'; sIn.title = 'stroke';
      sIn.oninput = () => { window.__routeShot.annoStyle.stroke = Number(sIn.value); applyFn(); };
      bar.appendChild(sIn);
    }
    const opIn = document.createElement('input'); opIn.type = 'range';
    opIn.min = '0.1'; opIn.max = '1'; opIn.step = '0.05';
    opIn.value = el.style.opacity || '1'; opIn.style.width = '60px'; opIn.title = 'opacity';
    opIn.oninput = () => { el.style.opacity = opIn.value; };
    const opLbl = document.createElement('label'); opLbl.textContent = 'α'; opLbl.style.opacity = '0.7';
    bar.appendChild(opLbl); bar.appendChild(opIn);
    // Universal scale — layered onto whatever transform the element already
    // has (rotate, etc). transform-origin:top left so scaling doesn't shift
    // the element off its anchor point.
    if (!opts.noScale) {
      const scLbl = document.createElement('label'); scLbl.textContent = 'size'; scLbl.style.opacity = '0.7';
      const scIn = document.createElement('input'); scIn.type = 'range';
      scIn.min = '0.2'; scIn.max = '4'; scIn.step = '0.05';
      scIn.value = el.dataset.__rsScale || '1'; scIn.style.width = '70px'; scIn.title = 'scale';
      el.style.transformOrigin = 'top left';
      scIn.oninput = () => {
        el.dataset.__rsScale = scIn.value;
        // Preserve any existing transform (e.g. rotate) by storing the base.
        const base = el.dataset.__rsBaseTransform || el.style.transform || '';
        if (!el.dataset.__rsBaseTransform) el.dataset.__rsBaseTransform = base;
        el.style.transform = el.dataset.__rsBaseTransform + ' scale(' + scIn.value + ')';
      };
      bar.appendChild(scLbl); bar.appendChild(scIn);
    }
    if (opts.extra) opts.extra(bar, applyFn);
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '×';
    x.style.cssText = 'padding:2px 8px;border:0;background:#444;color:#fff;border-radius:4px;cursor:pointer;';
    x.onclick = () => { el.remove(); bar.remove(); };
    bar.appendChild(x);
    document.documentElement.appendChild(bar);
    function place() {
      const r = el.getBoundingClientRect();
      bar.style.left = Math.max(4, r.left) + 'px';
      bar.style.top  = Math.max(4, r.top - 40) + 'px';
    }
    el.addEventListener('click', (ev) => {
      if (ev.target.classList && ev.target.classList.contains('__rs-handle')) return;
      place(); bar.style.display = 'flex';
    });
    document.addEventListener('mousedown', (ev) => {
      if (!el.contains(ev.target) && !bar.contains(ev.target)) bar.style.display = 'none';
    }, true);
    try { new ResizeObserver(() => { if (bar.style.display !== 'none') place(); }).observe(el); } catch {}
    window.addEventListener('scroll', () => { if (bar.style.display !== 'none') place(); }, true);
    return { place, bar };
  }

  // --- widget setup --------------------------------------------------------

  function setup() {
    if (document.getElementById('__routeShotWidget')) return;
    const w = document.createElement('div');
    w.id = '__routeShotWidget';
    w.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;' +
      'display:flex;flex-direction:column;gap:4px;font:13px/1 system-ui;user-select:none;' +
      'background:rgba(20,20,20,0.82);padding:8px;border-radius:8px;max-width:360px;';

    // Row 1 — label + Snap
    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;gap:4px;';
    const labelInput = document.createElement('input');
    labelInput.placeholder = 'label (filename)';
    labelInput.style.cssText = 'padding:8px 10px;border:1px solid #444;background:#222;color:#fff;border-radius:6px;outline:none;flex:1;min-width:0;';
    const btn = document.createElement('button');
    btn.textContent = '📸 Snap';
    btn.style.cssText = 'padding:8px 14px;border:0;background:#58a6ff;color:#000;font-weight:600;border-radius:6px;cursor:pointer;';
    row1.appendChild(labelInput); row1.appendChild(btn);

    // Row 2 — caption
    const captionRow = document.createElement('div');
    captionRow.style.cssText = 'display:flex;gap:4px;';
    const captionInput = document.createElement('input');
    captionInput.placeholder = 'caption (drag/resize on page)';
    captionInput.style.cssText = 'flex:1;padding:6px 10px;border:1px solid #444;background:#222;color:#fff;border-radius:6px;outline:none;';
    const captionClear = document.createElement('button');
    captionClear.type = 'button'; captionClear.textContent = '×';
    captionClear.title = 'remove caption';
    captionClear.style.cssText = 'padding:6px 10px;border:0;background:#333;color:#fff;border-radius:6px;cursor:pointer;';
    captionRow.appendChild(captionInput); captionRow.appendChild(captionClear);

    // Row 3 — note
    const noteInput = document.createElement('input');
    noteInput.placeholder = 'note (saved to sidecar .json)';
    noteInput.style.cssText = 'padding:6px 10px;border:1px solid #444;background:#222;color:#fff;border-radius:6px;outline:none;';

    // --- Live caption ------------------------------------------------------
    function getCaption() { return document.getElementById('__routeShotCaption'); }
    function captionState() {
      return window.__routeShot.captionStyle = window.__routeShot.captionStyle || {
        fg: '#ffffff', bg: '#000000', alpha: 0.82, size: 18,
        opacity: 1, shadow: true, font: 'system-ui',
      };
    }
    function applyCaptionStyle(el) {
      const s = captionState();
      const rgba = (hex, a) => {
        const n = parseInt(hex.slice(1), 16);
        return 'rgba(' + ((n>>16)&255) + ',' + ((n>>8)&255) + ',' + (n&255) + ',' + a + ')';
      };
      el.style.color = s.fg;
      el.style.background = rgba(s.bg, s.alpha);
      el.style.fontSize = s.size + 'px';
      el.style.opacity = String(s.opacity);
      el.style.textShadow = s.shadow ? '0 2px 4px rgba(0,0,0,0.6)' : 'none';
      el.style.fontFamily = s.font;
    }
    function ensureCaption(text) {
      let c = getCaption();
      if (!text) { if (c) c.remove(); const oldBar = document.getElementById('__routeShotCaptionBar'); if (oldBar) oldBar.remove(); return null; }
      if (!c) {
        c = document.createElement('div');
        c.id = '__routeShotCaption';
        c.contentEditable = 'true';
        c.spellcheck = false;
        c.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);' +
          'z-index:2147483646;max-width:80vw;min-width:80px;padding:10px 18px;' +
          'border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.5);font:18px/1.35 system-ui;' +
          'white-space:pre-wrap;text-align:center;cursor:move;resize:both;overflow:auto;' +
          'outline:1px dashed rgba(255,255,255,0.25);outline-offset:2px;';
        applyCaptionStyle(c);
        c.textContent = text;
        c.addEventListener('mousedown', (ev) => {
          if (ev.target.closest('#__routeShotCaptionBar')) return;
          if (ev.target !== c) return;
          const rect = c.getBoundingClientRect();
          const dx = ev.clientX - rect.left, dy = ev.clientY - rect.top;
          c.style.transform = 'none';
          const onMove = (e) => {
            c.style.left = Math.max(0, e.clientX - dx) + 'px';
            c.style.top  = Math.max(0, e.clientY - dy) + 'px';
            const bar = document.getElementById('__routeShotCaptionBar');
            if (bar && bar.style.display !== 'none') {
              const r = c.getBoundingClientRect();
              bar.style.left = Math.max(4, r.left) + 'px';
              bar.style.top  = Math.max(4, r.top - 40) + 'px';
            }
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
          };
          document.addEventListener('mousemove', onMove, true);
          document.addEventListener('mouseup', onUp, true);
          ev.preventDefault();
        });
        c.addEventListener('input', () => { captionInput.value = c.innerText; });

        const bar = document.createElement('div');
        bar.id = '__routeShotCaptionBar';
        bar.style.cssText = 'position:fixed;display:none;gap:6px;z-index:2147483646;' +
          'background:rgba(20,20,20,0.92);padding:6px 8px;border-radius:6px;' +
          'font:12px/1 system-ui;color:#fff;align-items:center;user-select:none;flex-wrap:wrap;max-width:440px;';
        function mkInput(type, val, width) {
          const e = document.createElement('input'); e.type = type;
          if (val !== undefined) e.value = val;
          if (width) e.style.width = width;
          if (type === 'color') e.style.cssText = 'width:24px;height:20px;border:0;background:none;padding:0;';
          return e;
        }
        function mkLabel(t) { const l = document.createElement('label'); l.textContent = t; l.style.opacity = '0.7'; return l; }
        const fg = mkInput('color', captionState().fg); fg.oninput = () => { captionState().fg = fg.value; applyCaptionStyle(c); };
        const bg = mkInput('color', captionState().bg); bg.oninput = () => { captionState().bg = bg.value; applyCaptionStyle(c); };
        const bga = mkInput('range', String(captionState().alpha), '50px');
        bga.min = '0'; bga.max = '1'; bga.step = '0.05'; bga.title = 'bg alpha';
        bga.oninput = () => { captionState().alpha = Number(bga.value); applyCaptionStyle(c); };
        const op = mkInput('range', String(captionState().opacity), '50px');
        op.min = '0'; op.max = '1'; op.step = '0.05'; op.title = 'opacity';
        op.oninput = () => { captionState().opacity = Number(op.value); applyCaptionStyle(c); };
        const sz = mkInput('range', String(captionState().size), '60px');
        sz.min = '10'; sz.max = '64'; sz.step = '1'; sz.title = 'size';
        sz.oninput = () => { captionState().size = Number(sz.value); applyCaptionStyle(c); };
        const shBtn = document.createElement('button'); shBtn.type = 'button';
        shBtn.textContent = captionState().shadow ? 'shadow ✓' : 'shadow';
        shBtn.style.cssText = 'padding:2px 8px;border:0;background:#444;color:#fff;border-radius:4px;cursor:pointer;';
        shBtn.onclick = () => {
          captionState().shadow = !captionState().shadow;
          shBtn.textContent = captionState().shadow ? 'shadow ✓' : 'shadow';
          applyCaptionStyle(c);
        };
        const font = document.createElement('select');
        font.style.cssText = 'background:#222;color:#fff;border:1px solid #444;border-radius:4px;padding:2px 4px;';
        [['system-ui','sans'],['Georgia, serif','serif'],['"Courier New", monospace','mono']].forEach(([v,lab]) => {
          const o = document.createElement('option'); o.value = v; o.textContent = lab;
          if (v === captionState().font) o.selected = true;
          font.appendChild(o);
        });
        font.onchange = () => { captionState().font = font.value; applyCaptionStyle(c); };
        const xBtn = document.createElement('button'); xBtn.textContent = '×';
        xBtn.style.cssText = 'padding:2px 8px;border:0;background:#444;color:#fff;border-radius:4px;cursor:pointer;';
        xBtn.onclick = () => { captionInput.value = ''; c.remove(); bar.remove(); };
        [mkLabel('fg'),fg,mkLabel('bg'),bg,mkLabel('bgα'),bga,mkLabel('α'),op,mkLabel('size'),sz,shBtn,font,xBtn]
          .forEach((e) => bar.appendChild(e));
        document.documentElement.appendChild(bar);
        document.documentElement.appendChild(c);
        function placeBar() {
          const r = c.getBoundingClientRect();
          bar.style.left = Math.max(4, r.left) + 'px';
          bar.style.top  = Math.max(4, r.top - 40) + 'px';
        }
        c.addEventListener('click', () => { placeBar(); bar.style.display = 'flex'; });
        document.addEventListener('mousedown', (ev) => {
          if (!c.contains(ev.target) && !bar.contains(ev.target)) bar.style.display = 'none';
        }, true);
        try { new ResizeObserver(placeBar).observe(c); } catch {}
        window.addEventListener('scroll', placeBar, true);
      } else if (document.activeElement !== c) {
        if (c.firstChild && c.firstChild.nodeType === 3) c.firstChild.data = text;
        else c.insertBefore(document.createTextNode(text), c.firstChild);
      }
      return c;
    }
    captionInput.addEventListener('input', () => ensureCaption(captionInput.value));
    captionClear.onclick = () => { captionInput.value = ''; ensureCaption(''); };

    btn.onclick = async () => {
      const c = getCaption();
      const capText = c ? c.innerText : captionInput.value;
      const r = await snap(labelInput.value, capText, noteInput.value);
      if (r.error) flash('✗ ' + r.error, false);
      else {
        flash('📸 saved #' + r.count + ' — ' + r.filename, true);
        labelInput.value = ''; noteInput.value = '';
      }
    };

    // --- Tabbed annotation palette -----------------------------------------
    const tabsRow = document.createElement('div');
    tabsRow.style.cssText = 'display:flex;gap:2px;flex-wrap:wrap;margin-top:4px;';
    const paletteRow = document.createElement('div');
    paletteRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;padding-top:4px;border-top:1px solid rgba(255,255,255,0.1);';

    function paletteBtn(label, title, onClick) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.title = title;
      b.style.cssText = 'padding:6px 10px;border:0;background:#333;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;min-width:34px;';
      b.onclick = onClick;
      return b;
    }

    // All spawner registrations live here. Each category is a (name, entries)
    // pair where entries are {icon,title,fn}.
    const categories = [
      { name: '📝 Text',    key: 'text',    items: [] },
      { name: '➡️ Pointer', key: 'pointer', items: [] },
      { name: '🟥 Shape',   key: 'shape',   items: [] },
      { name: '🔢 Mark',    key: 'mark',    items: [] },
      { name: '🔒 Redact',  key: 'redact',  items: [] },
      { name: '📏 Measure', key: 'measure', items: [] },
      { name: '🔌 Maker',   key: 'maker',   items: [] },
      { name: '🖼 Frame',   key: 'frame',   items: [] },
    ];
    const catBy = {}; categories.forEach((c) => (catBy[c.key] = c));
    function register(key, icon, title, fn) { catBy[key].items.push({ icon, title, fn }); }

    let activeCat = 'pointer';
    function renderPalette() {
      paletteRow.innerHTML = '';
      const cat = catBy[activeCat];
      cat.items.forEach(({ icon, title, fn }) => paletteRow.appendChild(paletteBtn(icon, title, fn)));
      // Badge-counter reset only makes sense in the Mark category.
      if (activeCat === 'mark') {
        const reset = paletteBtn('⟲', 'reset badge counter', () => {
          window.__routeShot.annoCount = 0; flash('badge counter reset', true);
        });
        paletteRow.appendChild(reset);
      }
    }
    function renderTabs() {
      tabsRow.innerHTML = '';
      categories.forEach((c) => {
        const t = document.createElement('button');
        t.type = 'button'; t.textContent = c.name;
        t.style.cssText = 'padding:3px 6px;border:0;border-radius:4px;font-size:11px;cursor:pointer;' +
          'background:' + (c.key === activeCat ? '#58a6ff' : '#2a2a2a') + ';' +
          'color:' + (c.key === activeCat ? '#000' : '#ccc') + ';';
        t.onclick = () => { activeCat = c.key; renderTabs(); renderPalette(); };
        tabsRow.appendChild(t);
      });
    }

    // --- Utility: generic bordered box / circle ----------------------------
    function spawnBorderedBox(radius, title) {
      const b = document.createElement('div');
      const S = window.__routeShot.annoStyle;
      b.style.cssText = 'position:fixed;left:40%;top:40%;width:200px;height:120px;z-index:2147483645;' +
        'border:' + S.stroke + 'px solid ' + S.color + ';' +
        'box-sizing:border-box;cursor:move;resize:both;overflow:auto;border-radius:' + radius + ';';
      const apply = () => { b.style.border = S.stroke + 'px solid ' + S.color; };
      makeDraggable(b); attachAnnoBar(b, apply);
      document.documentElement.appendChild(b);
      return b;
    }

    // --- SHAPE: Box / Circle / Highlighter / Spotlight / Polygon -----------
    register('shape', '▭', 'box', () => spawnBorderedBox('4px'));
    register('shape', '○', 'circle', () => {
      const b = spawnBorderedBox('50%'); b.style.width = '140px'; b.style.height = '140px';
    });
    register('shape', '🖍', 'highlighter (translucent rect)', () => {
      const h = document.createElement('div');
      h.style.cssText = 'position:fixed;left:40%;top:40%;width:240px;height:32px;z-index:2147483645;' +
        'background:rgba(255,235,59,0.45);cursor:move;resize:both;overflow:auto;border-radius:2px;mix-blend-mode:multiply;';
      makeDraggable(h);
      attachAnnoBar(h, () => {}, {
        noStroke: true, noColor: true,
        extra: (bar) => {
          const c = document.createElement('input'); c.type = 'color'; c.value = '#ffeb3b';
          c.style.cssText = 'width:24px;height:20px;border:0;background:none;padding:0;';
          c.oninput = () => {
            const n = parseInt(c.value.slice(1), 16);
            h.style.background = 'rgba(' + ((n>>16)&255) + ',' + ((n>>8)&255) + ',' + (n&255) + ',0.45)';
          };
          bar.insertBefore(c, bar.firstChild);
        },
      });
      document.documentElement.appendChild(h);
    });
    register('shape', '🔦', 'spotlight (dim everything else)', () => {
      const sp = document.createElement('div');
      sp.style.cssText = 'position:fixed;left:35%;top:35%;width:30%;height:30%;z-index:2147483644;' +
        'box-shadow:0 0 0 9999px rgba(0,0,0,0.65);border-radius:8px;cursor:move;resize:both;overflow:auto;' +
        'pointer-events:auto;';
      const apply = () => {};
      makeDraggable(sp);
      attachAnnoBar(sp, apply, {
        noColor: true, noStroke: true,
        extra: (bar) => {
          const dim = document.createElement('input'); dim.type = 'range';
          dim.min = '0'; dim.max = '0.95'; dim.step = '0.05'; dim.value = '0.65';
          dim.style.width = '70px'; dim.title = 'dim';
          dim.oninput = () => { sp.style.boxShadow = '0 0 0 9999px rgba(0,0,0,' + dim.value + ')'; };
          bar.insertBefore(dim, bar.firstChild);
        },
      });
      document.documentElement.appendChild(sp);
    });
    register('shape', '✏️', 'freehand pen — drag on the page to draw', () => spawnFreehand());

    function spawnFreehand() {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('style', 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483645;pointer-events:auto;cursor:crosshair;');
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('stroke', window.__routeShot.annoStyle.color);
      path.setAttribute('stroke-width', window.__routeShot.annoStyle.stroke);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('style', 'pointer-events:stroke;cursor:move;');
      svg.appendChild(path);
      document.documentElement.appendChild(svg);
      let d = '', drawing = false;
      const onDown = (ev) => {
        if (ev.target !== svg) return;
        drawing = true;
        d = 'M ' + ev.clientX + ' ' + ev.clientY;
        path.setAttribute('d', d);
      };
      const onMove = (ev) => {
        if (!drawing) return;
        d += ' L ' + ev.clientX + ' ' + ev.clientY;
        path.setAttribute('d', d);
      };
      const onUp = () => {
        if (!drawing) return;
        drawing = false;
        svg.style.pointerEvents = 'none';
        path.style.pointerEvents = 'stroke';
        svg.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        flash('freehand: done (click stroke to restyle)', true);
      };
      svg.addEventListener('mousedown', onDown, true);
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      // Toolbar on stroke click.
      const bar = document.createElement('div');
      bar.className = '__rs-anno-bar';
      bar.style.cssText = 'position:fixed;display:none;gap:6px;z-index:2147483646;background:rgba(20,20,20,0.92);' +
        'padding:6px 8px;border-radius:6px;font:12px/1 system-ui;color:#fff;align-items:center;';
      const c2 = document.createElement('input'); c2.type = 'color'; c2.value = window.__routeShot.annoStyle.color;
      c2.style.cssText = 'width:24px;height:20px;border:0;background:none;padding:0;';
      c2.oninput = () => { path.setAttribute('stroke', c2.value); };
      const s2 = document.createElement('input'); s2.type = 'range'; s2.min = '1'; s2.max = '20';
      s2.value = String(window.__routeShot.annoStyle.stroke); s2.style.width = '60px';
      s2.oninput = () => { path.setAttribute('stroke-width', s2.value); };
      const x2 = document.createElement('button'); x2.textContent = '×';
      x2.style.cssText = 'padding:2px 8px;border:0;background:#444;color:#fff;border-radius:4px;cursor:pointer;';
      x2.onclick = () => { svg.remove(); bar.remove(); };
      [c2, s2, x2].forEach((e) => bar.appendChild(e));
      document.documentElement.appendChild(bar);
      path.addEventListener('click', (ev) => {
        bar.style.left = ev.clientX + 'px'; bar.style.top = (ev.clientY - 40) + 'px';
        bar.style.display = 'flex';
      });
      document.addEventListener('mousedown', (ev) => {
        if (ev.target !== path && !bar.contains(ev.target)) bar.style.display = 'none';
      }, true);
    }

    // --- POINTER: Arrow / Curved / Crosshair / Click / Signal-flow --------
    function spawnArrow() {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('style',
        'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483645;pointer-events:none;overflow:visible;');
      const mid = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      const p1 = { x: mid.x - 80, y: mid.y }, p2 = { x: mid.x + 80, y: mid.y };
      const markerId = '__rsArrowHead_' + (++window.__routeShot.seq);
      svg.innerHTML =
        '<defs><marker id="' + markerId + '" viewBox="0 0 10 10" refX="9" refY="5" ' +
        'markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
        '<path d="M0,0 L10,5 L0,10 z" fill="' + window.__routeShot.annoStyle.color + '"/></marker></defs>' +
        '<line x1="' + p1.x + '" y1="' + p1.y + '" x2="' + p2.x + '" y2="' + p2.y + '" ' +
        'stroke="' + window.__routeShot.annoStyle.color + '" stroke-width="' + window.__routeShot.annoStyle.stroke + '" ' +
        'marker-end="url(#' + markerId + ')" style="pointer-events:stroke;cursor:move;" />';
      const line = svg.querySelector('line');
      function apply() {
        line.setAttribute('stroke', window.__routeShot.annoStyle.color);
        line.setAttribute('stroke-width', window.__routeShot.annoStyle.stroke);
        const m = svg.querySelector('marker path');
        if (m) m.setAttribute('fill', window.__routeShot.annoStyle.color);
      }
      function redraw() {
        line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
        line.setAttribute('x2', p2.x); line.setAttribute('y2', p2.y);
        h1.setAttribute('cx', p1.x); h1.setAttribute('cy', p1.y);
        h2.setAttribute('cx', p2.x); h2.setAttribute('cy', p2.y);
      }
      function mkHandle(pt) {
        const h = document.createElementNS(NS, 'circle');
        h.setAttribute('cx', pt.x); h.setAttribute('cy', pt.y); h.setAttribute('r', '7');
        h.setAttribute('fill', '#fff'); h.setAttribute('stroke', '#333'); h.setAttribute('stroke-width', '2');
        h.setAttribute('class', '__rs-handle');
        h.style.cssText = 'pointer-events:all;cursor:grab;';
        h.addEventListener('mousedown', (ev) => {
          ev.stopPropagation(); ev.preventDefault();
          const onMv = (e) => { pt.x = e.clientX; pt.y = e.clientY; redraw(); };
          const onUp = () => {
            document.removeEventListener('mousemove', onMv, true);
            document.removeEventListener('mouseup', onUp, true);
          };
          document.addEventListener('mousemove', onMv, true);
          document.addEventListener('mouseup', onUp, true);
        });
        return h;
      }
      const h1 = mkHandle(p1), h2 = mkHandle(p2);
      svg.appendChild(h1); svg.appendChild(h2);
      line.addEventListener('mousedown', (ev) => {
        if (ev.target.classList && ev.target.classList.contains('__rs-handle')) return;
        const sx = ev.clientX, sy = ev.clientY;
        const s1 = { ...p1 }, s2 = { ...p2 };
        const onMv = (e) => {
          const dx = e.clientX - sx, dy = e.clientY - sy;
          p1.x = s1.x + dx; p1.y = s1.y + dy;
          p2.x = s2.x + dx; p2.y = s2.y + dy;
          redraw();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMv, true);
          document.removeEventListener('mouseup', onUp, true);
        };
        document.addEventListener('mousemove', onMv, true);
        document.addEventListener('mouseup', onUp, true);
        ev.preventDefault();
      });
      const bar = document.createElement('div');
      bar.className = '__rs-anno-bar';
      bar.style.cssText = 'position:fixed;display:none;gap:6px;z-index:2147483646;background:rgba(20,20,20,0.92);' +
        'padding:6px 8px;border-radius:6px;font:12px/1 system-ui;color:#fff;align-items:center;flex-wrap:wrap;max-width:360px;';
      const cIn = document.createElement('input'); cIn.type = 'color'; cIn.value = window.__routeShot.annoStyle.color;
      cIn.style.cssText = 'width:24px;height:20px;border:0;background:none;padding:0;';
      cIn.oninput = () => { window.__routeShot.annoStyle.color = cIn.value; apply(); };
      const sIn = document.createElement('input'); sIn.type = 'range'; sIn.min = '1'; sIn.max = '20';
      sIn.value = String(window.__routeShot.annoStyle.stroke); sIn.style.width = '60px'; sIn.title = 'stroke';
      sIn.oninput = () => { window.__routeShot.annoStyle.stroke = Number(sIn.value); apply(); };
      const opIn = document.createElement('input'); opIn.type = 'range'; opIn.min = '0.1'; opIn.max = '1'; opIn.step = '0.05';
      opIn.value = '1'; opIn.style.width = '60px'; opIn.title = 'opacity';
      opIn.oninput = () => { svg.style.opacity = opIn.value; };
      const hIn = document.createElement('input'); hIn.type = 'range'; hIn.min = '3'; hIn.max = '20';
      hIn.value = '6'; hIn.style.width = '60px'; hIn.title = 'arrowhead';
      hIn.oninput = () => {
        const m = svg.querySelector('marker');
        if (m) { m.setAttribute('markerWidth', hIn.value); m.setAttribute('markerHeight', hIn.value); }
      };
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '×';
      x.style.cssText = 'padding:2px 8px;border:0;background:#444;color:#fff;border-radius:4px;cursor:pointer;';
      x.onclick = () => { svg.remove(); bar.remove(); };
      [cIn, sIn, opIn, hIn, x].forEach((el) => bar.appendChild(el));
      document.documentElement.appendChild(bar);
      line.addEventListener('click', (ev) => {
        ev.stopPropagation();
        bar.style.left = Math.max(4, Math.min(p1.x, p2.x)) + 'px';
        bar.style.top  = Math.max(4, Math.min(p1.y, p2.y) - 40) + 'px';
        bar.style.display = 'flex';
      });
      document.addEventListener('mousedown', (ev) => {
        if (ev.target !== line && !bar.contains(ev.target) && ev.target !== h1 && ev.target !== h2)
          bar.style.display = 'none';
      }, true);
      document.documentElement.appendChild(svg);
    }
    register('pointer', '→', 'straight arrow', spawnArrow);

    register('pointer', '↝', 'curved connector (bezier)', () => {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('style', 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483645;pointer-events:none;overflow:visible;');
      const mid = { x: innerWidth/2, y: innerHeight/2 };
      const p1 = { x: mid.x - 100, y: mid.y + 40 };
      const p2 = { x: mid.x + 100, y: mid.y - 40 };
      const cp = { x: mid.x, y: mid.y - 80 };
      const mkId = '__rsCurvedHead_' + (++window.__routeShot.seq);
      svg.innerHTML =
        '<defs><marker id="' + mkId + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">' +
        '<path d="M0,0 L10,5 L0,10 z" fill="' + window.__routeShot.annoStyle.color + '"/></marker></defs>' +
        '<path fill="none" stroke="' + window.__routeShot.annoStyle.color + '" stroke-width="' + window.__routeShot.annoStyle.stroke + '" ' +
        'marker-end="url(#' + mkId + ')" style="pointer-events:stroke;cursor:move;" />';
      const path = svg.querySelector('path');
      function redraw() { path.setAttribute('d', 'M ' + p1.x + ' ' + p1.y + ' Q ' + cp.x + ' ' + cp.y + ' ' + p2.x + ' ' + p2.y); }
      redraw();
      function mkHandle(pt, color) {
        const h = document.createElementNS(NS, 'circle');
        h.setAttribute('cx', pt.x); h.setAttribute('cy', pt.y); h.setAttribute('r', '6');
        h.setAttribute('fill', color); h.setAttribute('stroke', '#333'); h.setAttribute('stroke-width', '2');
        h.setAttribute('class', '__rs-handle');
        h.style.cssText = 'pointer-events:all;cursor:grab;';
        h.addEventListener('mousedown', (ev) => {
          ev.stopPropagation(); ev.preventDefault();
          const onMv = (e) => {
            pt.x = e.clientX; pt.y = e.clientY;
            h.setAttribute('cx', pt.x); h.setAttribute('cy', pt.y);
            redraw();
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMv, true);
            document.removeEventListener('mouseup', onUp, true);
          };
          document.addEventListener('mousemove', onMv, true);
          document.addEventListener('mouseup', onUp, true);
        });
        return h;
      }
      svg.appendChild(mkHandle(p1, '#fff'));
      svg.appendChild(mkHandle(p2, '#fff'));
      svg.appendChild(mkHandle(cp, '#58a6ff'));
      document.documentElement.appendChild(svg);
      // Simple removal: click path to get small × button
      path.addEventListener('click', () => { if (confirm('Remove curved arrow?')) svg.remove(); });
    });

    register('pointer', '＋', 'crosshair / target', () => {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:40%;top:40%;width:48px;height:48px;z-index:2147483645;cursor:move;';
      const S = window.__routeShot.annoStyle;
      function apply() {
        el.innerHTML =
          '<svg width="100%" height="100%" viewBox="0 0 48 48" style="pointer-events:none;">' +
          '<circle cx="24" cy="24" r="20" fill="none" stroke="' + S.color + '" stroke-width="' + S.stroke + '"/>' +
          '<line x1="24" y1="0" x2="24" y2="48" stroke="' + S.color + '" stroke-width="' + S.stroke + '"/>' +
          '<line x1="0" y1="24" x2="48" y2="24" stroke="' + S.color + '" stroke-width="' + S.stroke + '"/>' +
          '</svg>';
      }
      apply();
      makeDraggable(el); attachAnnoBar(el, apply);
      document.documentElement.appendChild(el);
    });

    register('pointer', '🖱', 'click ripple / cursor', () => {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:40%;top:40%;width:60px;height:60px;z-index:2147483645;cursor:move;';
      const S = window.__routeShot.annoStyle;
      function apply() {
        const col = S.color;
        el.innerHTML =
          '<svg width="100%" height="100%" viewBox="0 0 60 60">' +
          '<circle cx="20" cy="20" r="6" fill="' + col + '" />' +
          '<circle cx="20" cy="20" r="12" fill="none" stroke="' + col + '" stroke-width="2" opacity="0.7"/>' +
          '<circle cx="20" cy="20" r="20" fill="none" stroke="' + col + '" stroke-width="1.5" opacity="0.4"/>' +
          '<path d="M30 30 L30 50 L35 45 L40 55 L44 53 L39 43 L48 42 z" fill="#fff" stroke="#000" stroke-width="1.5"/>' +
          '</svg>';
      }
      apply();
      makeDraggable(el); attachAnnoBar(el, apply, { noStroke: true });
      document.documentElement.appendChild(el);
    });

    register('pointer', '🔀', 'signal-flow arrow with label', () => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;left:40%;top:40%;z-index:2147483645;cursor:move;display:flex;align-items:center;gap:0;';
      const txt = document.createElement('span');
      txt.contentEditable = 'true'; txt.textContent = 'I²C';
      const S = window.__routeShot.annoStyle;
      txt.style.cssText = 'padding:2px 10px;background:' + S.color + ';color:#fff;font:bold 12px/1.4 system-ui;' +
        'border-radius:3px 0 0 3px;outline:none;';
      const tail = document.createElement('div');
      tail.style.cssText = 'width:0;height:0;border-style:solid;border-width:12px 0 12px 16px;' +
        'border-color:transparent transparent transparent ' + S.color + ';';
      wrap.appendChild(txt); wrap.appendChild(tail);
      function apply() {
        txt.style.background = window.__routeShot.annoStyle.color;
        tail.style.borderLeftColor = window.__routeShot.annoStyle.color;
      }
      makeDraggable(wrap); attachAnnoBar(wrap, apply, { noStroke: true });
      document.documentElement.appendChild(wrap);
    });

    // --- MARK: Number / Stamp / Emoji / ✓ ✗ ⚠ / Keycap / Step rail ---------
    register('mark', '①', 'numbered badge', () => {
      window.__routeShot.annoCount++;
      const n = document.createElement('div');
      n.textContent = String(window.__routeShot.annoCount);
      const S = window.__routeShot.annoStyle;
      n.style.cssText = 'position:fixed;left:40%;top:40%;width:36px;height:36px;z-index:2147483645;' +
        'border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;' +
        'font:bold 18px/1 system-ui;cursor:move;box-shadow:0 2px 6px rgba(0,0,0,0.4);' +
        'background:' + S.color + ';user-select:none;';
      const apply = () => { n.style.background = window.__routeShot.annoStyle.color; };
      makeDraggable(n); attachAnnoBar(n, apply, {
        noStroke: true,
        extra: (bar) => {
          const sz = document.createElement('input'); sz.type = 'range'; sz.min = '20'; sz.max = '120';
          sz.value = '36'; sz.style.width = '70px'; sz.title = 'size';
          sz.oninput = () => {
            const v = Number(sz.value);
            n.style.width = v + 'px'; n.style.height = v + 'px';
            n.style.fontSize = Math.round(v * 0.5) + 'px';
          };
          bar.appendChild(sz);
        },
      });
      document.documentElement.appendChild(n);
    });

    register('mark', '🏷', 'stamp (NEW/DRAFT/BETA/…)', () => {
      const t = prompt('Stamp text:', 'NEW'); if (!t) return;
      const s = document.createElement('div');
      s.textContent = t.toUpperCase();
      s.style.cssText = 'position:fixed;left:45%;top:40%;z-index:2147483645;padding:6px 14px;' +
        'border:3px solid #d32f2f;color:#d32f2f;font:bold 22px/1 system-ui;cursor:move;' +
        'transform:rotate(-12deg);background:transparent;border-radius:4px;letter-spacing:0.1em;user-select:none;';
      const apply = () => {
        s.style.color = window.__routeShot.annoStyle.color;
        s.style.borderColor = window.__routeShot.annoStyle.color;
      };
      makeDraggable(s); attachAnnoBar(s, apply, {
        extra: (bar) => {
          const rot = document.createElement('input'); rot.type = 'range'; rot.min = '-45'; rot.max = '45';
          rot.value = '-12'; rot.style.width = '60px'; rot.title = 'rotate';
          rot.oninput = () => { s.style.transform = 'rotate(' + rot.value + 'deg)'; };
          bar.appendChild(rot);
        },
      });
      document.documentElement.appendChild(s);
    });

    register('mark', '😀', 'emoji badge', () => {
      const e = prompt('Emoji (paste one):', '⚡'); if (!e) return;
      const el = document.createElement('div');
      el.textContent = e;
      el.style.cssText = 'position:fixed;left:45%;top:45%;z-index:2147483645;font:36px/1 system-ui;' +
        'cursor:move;user-select:none;';
      const apply = () => {};
      makeDraggable(el); attachAnnoBar(el, apply, {
        noColor: true, noStroke: true,
        extra: (bar) => {
          const sz = document.createElement('input'); sz.type = 'range'; sz.min = '16'; sz.max = '120';
          sz.value = '36'; sz.style.width = '70px'; sz.title = 'size';
          sz.oninput = () => { el.style.fontSize = sz.value + 'px'; };
          bar.appendChild(sz);
        },
      });
      document.documentElement.appendChild(el);
    });

    function spawnIcon(glyph, color) {
      const el = document.createElement('div');
      el.textContent = glyph;
      el.style.cssText = 'position:fixed;left:45%;top:45%;width:48px;height:48px;z-index:2147483645;' +
        'border-radius:50%;display:flex;align-items:center;justify-content:center;' +
        'font:bold 28px/1 system-ui;cursor:move;user-select:none;color:#fff;background:' + color + ';' +
        'box-shadow:0 2px 6px rgba(0,0,0,0.4);';
      const apply = () => { el.style.background = window.__routeShot.annoStyle.color; };
      makeDraggable(el); attachAnnoBar(el, apply, { noStroke: true });
      document.documentElement.appendChild(el);
    }
    register('mark', '✓', 'check (do this)', () => spawnIcon('✓', '#2e7d32'));
    register('mark', '✗', 'cross (don\'t do this)', () => spawnIcon('✗', '#c62828'));
    register('mark', '⚠', 'warning', () => spawnIcon('⚠', '#f9a825'));

    register('mark', '⌘K', 'keycap', () => {
      const t = prompt('Key label (e.g. "⌘K", "Ctrl+Shift+S"):', 'Ctrl+S'); if (!t) return;
      const k = document.createElement('div');
      k.textContent = t;
      k.style.cssText = 'position:fixed;left:45%;top:45%;z-index:2147483645;padding:6px 12px;' +
        'background:#fafafa;color:#222;font:bold 14px/1 "SF Mono", Menlo, Consolas, monospace;' +
        'border:1px solid #bbb;border-bottom:3px solid #999;border-radius:5px;cursor:move;' +
        'box-shadow:0 1px 0 rgba(0,0,0,0.1);user-select:none;';
      const apply = () => {};
      makeDraggable(k); attachAnnoBar(k, apply, {
        noColor: true, noStroke: true,
        extra: (bar) => {
          const ed = document.createElement('button'); ed.textContent = '✎'; ed.title = 'edit text';
          ed.style.cssText = 'padding:2px 8px;border:0;background:#444;color:#fff;border-radius:4px;cursor:pointer;';
          ed.onclick = () => { const v = prompt('Key label:', k.textContent); if (v) k.textContent = v; };
          bar.appendChild(ed);
        },
      });
      document.documentElement.appendChild(k);
    });

    register('mark', '1●2●3', 'step rail', () => {
      const n = Math.max(2, Math.min(9, Number(prompt('How many steps? (2–9)', '3') || '3')));
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:30%;top:70%;z-index:2147483645;display:flex;align-items:center;gap:0;cursor:move;';
      const S = window.__routeShot.annoStyle;
      for (let i = 1; i <= n; i++) {
        const dot = document.createElement('div');
        dot.textContent = String(i);
        dot.style.cssText = 'width:32px;height:32px;border-radius:50%;background:' + S.color + ';color:#fff;' +
          'display:flex;align-items:center;justify-content:center;font:bold 14px/1 system-ui;';
        r.appendChild(dot);
        if (i < n) {
          const line = document.createElement('div');
          line.style.cssText = 'width:40px;height:3px;background:' + S.color + ';';
          r.appendChild(line);
        }
      }
      function apply() {
        const col = window.__routeShot.annoStyle.color;
        [...r.children].forEach((c) => {
          if (c.style.borderRadius === '50%') c.style.background = col;
          else c.style.background = col;
        });
      }
      makeDraggable(r); attachAnnoBar(r, apply, { noStroke: true });
      document.documentElement.appendChild(r);
    });

    // --- REDACT: Blur / Black bar / Auto-redact by selector ---------------
    register('redact', '🌫', 'blur region', () => {
      const b = document.createElement('div');
      b.style.cssText = 'position:fixed;left:40%;top:40%;width:200px;height:80px;z-index:2147483645;' +
        'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);background:rgba(255,255,255,0.02);' +
        'cursor:move;resize:both;overflow:auto;border-radius:4px;';
      makeDraggable(b);
      attachAnnoBar(b, () => {}, {
        noColor: true, noStroke: true,
        extra: (bar) => {
          const blur = document.createElement('input'); blur.type = 'range'; blur.min = '1'; blur.max = '30';
          blur.value = '10'; blur.style.width = '70px'; blur.title = 'blur radius';
          blur.oninput = () => {
            b.style.backdropFilter = 'blur(' + blur.value + 'px)';
            b.style.webkitBackdropFilter = 'blur(' + blur.value + 'px)';
          };
          bar.insertBefore(blur, bar.firstChild);
        },
      });
      document.documentElement.appendChild(b);
    });
    register('redact', '⬛', 'black redact bar', () => {
      const b = document.createElement('div');
      b.style.cssText = 'position:fixed;left:40%;top:40%;width:200px;height:24px;z-index:2147483645;' +
        'background:#000;cursor:move;resize:both;overflow:auto;';
      makeDraggable(b); attachAnnoBar(b, () => {}, {
        extra: (bar) => {
          const c = document.createElement('input'); c.type = 'color'; c.value = '#000000';
          c.style.cssText = 'width:24px;height:20px;border:0;background:none;padding:0;';
          c.oninput = () => { b.style.background = c.value; };
          bar.insertBefore(c, bar.firstChild);
        }, noColor: true, noStroke: true,
      });
      document.documentElement.appendChild(b);
    });
    register('redact', '🎯', 'auto-redact by CSS selector', () => {
      const sel = prompt('CSS selector to blur (e.g. ".user-email, [data-private]"):', '.email');
      if (!sel) return;
      let count = 0;
      document.querySelectorAll(sel).forEach((el) => {
        el.style.filter = 'blur(8px)';
        el.setAttribute('data-__rsRedacted', '1');
        count++;
      });
      flash('Redacted ' + count + ' element(s)', true);
    });

    // --- MEASURE: Dimension line / Ruler / Zoom inset ---------------------
    register('measure', '↔', 'dimension line (with px)', () => {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('style', 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483645;pointer-events:none;overflow:visible;');
      const p1 = { x: innerWidth/2 - 100, y: innerHeight/2 };
      const p2 = { x: innerWidth/2 + 100, y: innerHeight/2 };
      const S = window.__routeShot.annoStyle;
      svg.innerHTML =
        '<line stroke="' + S.color + '" stroke-width="' + S.stroke + '" style="pointer-events:stroke;cursor:move;" />' +
        '<line class="t1" stroke="' + S.color + '" stroke-width="' + S.stroke + '" />' +
        '<line class="t2" stroke="' + S.color + '" stroke-width="' + S.stroke + '" />' +
        '<text fill="' + S.color + '" font:bold 13px system-ui text-anchor="middle"></text>';
      const [line, t1, t2, label] = svg.children;
      function redraw() {
        const len = Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y));
        line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
        line.setAttribute('x2', p2.x); line.setAttribute('y2', p2.y);
        const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        const px = Math.sin(ang) * 8, py = -Math.cos(ang) * 8;
        t1.setAttribute('x1', p1.x + px); t1.setAttribute('y1', p1.y + py);
        t1.setAttribute('x2', p1.x - px); t1.setAttribute('y2', p1.y - py);
        t2.setAttribute('x1', p2.x + px); t2.setAttribute('y1', p2.y + py);
        t2.setAttribute('x2', p2.x - px); t2.setAttribute('y2', p2.y - py);
        label.setAttribute('x', (p1.x + p2.x) / 2);
        label.setAttribute('y', (p1.y + p2.y) / 2 - 8);
        label.textContent = len + 'px';
        h1.setAttribute('cx', p1.x); h1.setAttribute('cy', p1.y);
        h2.setAttribute('cx', p2.x); h2.setAttribute('cy', p2.y);
      }
      function mkHandle(pt) {
        const h = document.createElementNS(NS, 'circle');
        h.setAttribute('r', '6'); h.setAttribute('fill', '#fff'); h.setAttribute('stroke', '#333');
        h.setAttribute('stroke-width', '2'); h.setAttribute('class', '__rs-handle');
        h.style.cssText = 'pointer-events:all;cursor:grab;';
        h.addEventListener('mousedown', (ev) => {
          ev.stopPropagation(); ev.preventDefault();
          const onMv = (e) => { pt.x = e.clientX; pt.y = e.clientY; redraw(); };
          const onUp = () => {
            document.removeEventListener('mousemove', onMv, true);
            document.removeEventListener('mouseup', onUp, true);
          };
          document.addEventListener('mousemove', onMv, true);
          document.addEventListener('mouseup', onUp, true);
        });
        return h;
      }
      const h1 = mkHandle(p1), h2 = mkHandle(p2);
      svg.appendChild(h1); svg.appendChild(h2);
      redraw();
      document.documentElement.appendChild(svg);
      line.addEventListener('click', () => { if (confirm('Remove dimension line?')) svg.remove(); });
    });

    register('measure', '📏', 'ruler overlay', () => {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:20px;top:40%;width:600px;height:28px;z-index:2147483645;' +
        'background:rgba(255,235,59,0.92);border:1px solid #b5a000;cursor:move;overflow:hidden;' +
        'font:10px/1 "SF Mono", Consolas, monospace;color:#333;';
      let marks = '';
      for (let i = 0; i <= 600; i += 10) {
        const h = i % 100 === 0 ? 14 : (i % 50 === 0 ? 9 : 5);
        marks += '<div style="position:absolute;left:' + i + 'px;top:0;width:1px;height:' + h + 'px;background:#333;"></div>';
        if (i % 100 === 0) marks += '<div style="position:absolute;left:' + (i + 2) + 'px;top:14px;">' + i + '</div>';
      }
      r.innerHTML = marks;
      makeDraggable(r);
      attachAnnoBar(r, () => {}, { noColor: true, noStroke: true });
      document.documentElement.appendChild(r);
    });

    register('measure', '🔍', 'zoom inset (loupe)', () => {
      const scale = Number(prompt('Zoom factor (1.5 – 5):', '2') || '2');
      const w = Number(prompt('Width in px:', '220') || '220');
      const h = Number(prompt('Height in px:', '160') || '160');
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:30%;top:50%;width:' + w + 'px;height:' + h + 'px;z-index:2147483645;' +
        'border:3px solid #58a6ff;background:#0a0a0a;color:#ccc;display:flex;align-items:center;justify-content:center;' +
        'font:12px/1.4 system-ui;text-align:center;cursor:move;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.5);';
      box.textContent = 'Zoom inset ×' + scale + '\n(paste a zoomed screenshot here)';
      box.style.whiteSpace = 'pre';
      makeDraggable(box);
      attachAnnoBar(box, () => {}, { noColor: true, noStroke: true });
      document.documentElement.appendChild(box);
    });

    // --- MAKER: Pin pill / Wire / Voltage / LED / Chip / Hex / Hazard / BoM / QR
    function spawnPill(text, bg, fg) {
      const el = document.createElement('span');
      el.textContent = text;
      el.contentEditable = 'true';
      el.style.cssText = 'position:fixed;left:45%;top:45%;z-index:2147483645;padding:3px 10px;' +
        'background:' + bg + ';color:' + fg + ';border-radius:999px;font:bold 12px/1.6 "SF Mono", Consolas, monospace;' +
        'cursor:move;user-select:none;outline:none;letter-spacing:0.02em;box-shadow:0 1px 3px rgba(0,0,0,0.3);';
      const apply = () => { el.style.background = window.__routeShot.annoStyle.color; };
      makeDraggable(el); attachAnnoBar(el, apply, { noStroke: true });
      document.documentElement.appendChild(el);
    }
    register('maker', 'P0', 'pin label pill', () => {
      const t = prompt('Pin label:', 'P0'); if (!t) return;
      spawnPill(t, '#1e88e5', '#fff');
    });
    register('maker', '3V', 'voltage / signal badge', () => {
      const t = prompt('Badge (3V3, 5V, GND, SDA, SCL, PWM…):', '3V3'); if (!t) return;
      const col = /gnd/i.test(t) ? '#424242' : /5v|12v/i.test(t) ? '#e53935' : /3v/i.test(t) ? '#fb8c00' : '#26a69a';
      spawnPill(t, col, '#fff');
    });
    register('maker', '💡', 'LED glow marker', () => {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:45%;top:45%;width:20px;height:20px;z-index:2147483645;' +
        'border-radius:50%;background:#ff5252;box-shadow:0 0 20px 4px rgba(255,82,82,0.7);cursor:move;';
      const apply = () => {
        const col = window.__routeShot.annoStyle.color;
        const n = parseInt(col.slice(1), 16);
        const rgb = ((n>>16)&255) + ',' + ((n>>8)&255) + ',' + (n&255);
        el.style.background = col;
        el.style.boxShadow = '0 0 20px 4px rgba(' + rgb + ',0.7)';
      };
      makeDraggable(el); attachAnnoBar(el, apply, { noStroke: true,
        extra: (bar) => {
          const sz = document.createElement('input'); sz.type = 'range'; sz.min = '8'; sz.max = '80';
          sz.value = '20'; sz.style.width = '60px'; sz.title = 'size';
          sz.oninput = () => { el.style.width = sz.value + 'px'; el.style.height = sz.value + 'px'; };
          bar.appendChild(sz);
        },
      });
      document.documentElement.appendChild(el);
    });

    register('maker', '〰', 'wire / bus (I²C, SPI…)', () => {
      const lab = prompt('Bus label:', 'I²C') || '';
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('style', 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483645;pointer-events:none;overflow:visible;');
      const p1 = { x: innerWidth/2 - 120, y: innerHeight/2 };
      const p2 = { x: innerWidth/2 + 120, y: innerHeight/2 + 80 };
      const S = window.__routeShot.annoStyle;
      svg.innerHTML =
        '<path fill="none" stroke="' + S.color + '" stroke-width="' + S.stroke + '" ' +
        'stroke-linecap="round" stroke-linejoin="round" style="pointer-events:stroke;cursor:move;" />' +
        '<rect fill="' + S.color + '" rx="3" />' +
        '<text fill="#fff" font-family="SF Mono, Consolas, monospace" font-size="11" font-weight="bold" text-anchor="middle"></text>';
      const [path, rect, text] = svg.children;
      function redraw() {
        const midX = (p1.x + p2.x) / 2;
        path.setAttribute('d', 'M ' + p1.x + ' ' + p1.y + ' H ' + midX + ' V ' + p2.y + ' H ' + p2.x);
        const mid = { x: midX, y: (p1.y + p2.y) / 2 };
        const w = Math.max(30, lab.length * 7 + 12);
        rect.setAttribute('x', mid.x - w/2); rect.setAttribute('y', mid.y - 8);
        rect.setAttribute('width', w); rect.setAttribute('height', 16);
        text.setAttribute('x', mid.x); text.setAttribute('y', mid.y + 4);
        text.textContent = lab;
        h1.setAttribute('cx', p1.x); h1.setAttribute('cy', p1.y);
        h2.setAttribute('cx', p2.x); h2.setAttribute('cy', p2.y);
      }
      function mkHandle(pt) {
        const h = document.createElementNS(NS, 'circle');
        h.setAttribute('r', '6'); h.setAttribute('fill', '#fff'); h.setAttribute('stroke', '#333');
        h.setAttribute('stroke-width', '2'); h.setAttribute('class', '__rs-handle');
        h.style.cssText = 'pointer-events:all;cursor:grab;';
        h.addEventListener('mousedown', (ev) => {
          ev.stopPropagation(); ev.preventDefault();
          const onMv = (e) => { pt.x = e.clientX; pt.y = e.clientY; redraw(); };
          const onUp = () => {
            document.removeEventListener('mousemove', onMv, true);
            document.removeEventListener('mouseup', onUp, true);
          };
          document.addEventListener('mousemove', onMv, true);
          document.addEventListener('mouseup', onUp, true);
        });
        return h;
      }
      const h1 = mkHandle(p1), h2 = mkHandle(p2);
      svg.appendChild(h1); svg.appendChild(h2);
      redraw();
      document.documentElement.appendChild(svg);
      path.addEventListener('click', () => { if (confirm('Remove wire?')) svg.remove(); });
    });

    register('maker', '▯', 'schematic chip outline (DIP/SOIC)', () => {
      const pins = Math.max(4, Math.min(40, Number(prompt('Pins per side:', '8') || '8')));
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;left:40%;top:40%;width:180px;height:' + (pins * 14 + 20) + 'px;' +
        'z-index:2147483645;background:#1a1a1a;border:2px solid #888;border-radius:8px;cursor:move;' +
        'display:flex;flex-direction:column;justify-content:space-around;padding:10px 22px;color:#eee;' +
        'font:bold 10px/1 "SF Mono", Consolas, monospace;box-sizing:border-box;';
      wrap.innerHTML = '<div style="text-align:center;border-bottom:1px solid #444;padding-bottom:4px;">IC</div>';
      for (let i = 0; i < pins; i++) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
        row.innerHTML = '<span style="margin-left:-18px;width:14px;height:3px;background:#ccc;display:inline-block;"></span>' +
          '<span>' + (i + 1) + '</span>' +
          '<span style="margin-right:-18px;width:14px;height:3px;background:#ccc;display:inline-block;"></span>';
        wrap.appendChild(row);
      }
      makeDraggable(wrap); attachAnnoBar(wrap, () => {}, { noColor: true, noStroke: true });
      document.documentElement.appendChild(wrap);
    });

    register('maker', '0x', 'hex / binary strip', () => {
      const t = prompt('Text (e.g. 0x3F or 0b10110101):', '0x3F'); if (!t) return;
      spawnPill(t, '#37474f', '#b9f6ca');
    });

    register('maker', '⚠', 'hazard tape', () => {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:30%;top:40%;width:240px;height:30px;z-index:2147483645;cursor:move;' +
        'background:repeating-linear-gradient(45deg,#000 0 12px,#f9d71c 12px 24px);border:1px solid #333;' +
        'resize:both;overflow:auto;';
      makeDraggable(el); attachAnnoBar(el, () => {}, { noColor: true, noStroke: true });
      document.documentElement.appendChild(el);
    });

    register('maker', '📋', 'BoM legend', () => {
      const box = document.createElement('div');
      box.contentEditable = 'true';
      box.style.cssText = 'position:fixed;left:20px;top:20px;z-index:2147483645;min-width:180px;padding:10px;' +
        'background:rgba(255,255,255,0.95);color:#222;border:1px solid #999;border-radius:4px;font:12px/1.5 system-ui;' +
        'cursor:move;box-shadow:0 2px 8px rgba(0,0,0,0.2);outline:none;';
      box.innerHTML =
        '<div style="font-weight:bold;margin-bottom:4px;border-bottom:1px solid #ccc;padding-bottom:2px;">Bill of Materials</div>' +
        '<div>🔴 1× micro:bit v2</div>' +
        '<div>🟡 1× LED</div>' +
        '<div>🟢 2× 10kΩ resistor</div>';
      makeDraggable(box);
      attachAnnoBar(box, () => {}, { noColor: true, noStroke: true });
      document.documentElement.appendChild(box);
    });

    register('maker', '🔳', 'QR placeholder', () => {
      const lab = prompt('Label (firmware / docs / repo):', 'firmware') || 'QR';
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:70%;top:60%;width:120px;z-index:2147483645;background:#fff;' +
        'border:1px solid #888;padding:8px;color:#222;font:11px/1.4 system-ui;text-align:center;cursor:move;';
      box.innerHTML =
        '<div style="width:104px;height:104px;margin:auto;background:' +
        'repeating-conic-gradient(#000 0 25%,#fff 0 50%);background-size:16px 16px;"></div>' +
        '<div style="margin-top:4px;font-weight:bold;">' + lab + '</div>';
      makeDraggable(box); attachAnnoBar(box, () => {}, { noColor: true, noStroke: true });
      document.documentElement.appendChild(box);
    });

    // --- TEXT: Callout / Sticky / Speech / Watermark ----------------------
    register('text', '💬', 'callout w/ leader line', () => {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('style', 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483644;pointer-events:none;overflow:visible;');
      const box = document.createElement('div');
      box.contentEditable = 'true';
      box.textContent = 'Callout — click to edit';
      box.style.cssText = 'position:fixed;left:45%;top:30%;z-index:2147483645;padding:8px 14px;' +
        'background:#fff;color:#111;border:2px solid ' + window.__routeShot.annoStyle.color + ';' +
        'border-radius:6px;font:14px/1.4 system-ui;max-width:280px;cursor:move;outline:none;' +
        'box-shadow:0 3px 10px rgba(0,0,0,0.3);';
      const tip = { x: innerWidth/2 - 60, y: innerHeight/2 + 80 };
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('stroke', window.__routeShot.annoStyle.color);
      line.setAttribute('stroke-width', '2');
      svg.appendChild(line);
      function redraw() {
        const r = box.getBoundingClientRect();
        line.setAttribute('x1', r.left + r.width/2);
        line.setAttribute('y1', r.top + r.height);
        line.setAttribute('x2', tip.x);
        line.setAttribute('y2', tip.y);
        handle.setAttribute('cx', tip.x); handle.setAttribute('cy', tip.y);
      }
      const handle = document.createElementNS(NS, 'circle');
      handle.setAttribute('r', '6'); handle.setAttribute('fill', window.__routeShot.annoStyle.color);
      handle.setAttribute('class', '__rs-handle');
      handle.style.cssText = 'pointer-events:all;cursor:grab;';
      handle.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const onMv = (e) => { tip.x = e.clientX; tip.y = e.clientY; redraw(); };
        const onUp = () => {
          document.removeEventListener('mousemove', onMv, true);
          document.removeEventListener('mouseup', onUp, true);
        };
        document.addEventListener('mousemove', onMv, true);
        document.addEventListener('mouseup', onUp, true);
      });
      svg.appendChild(handle);
      document.documentElement.appendChild(svg);
      document.documentElement.appendChild(box);
      makeDraggable(box, redraw);
      attachAnnoBar(box, () => {
        box.style.borderColor = window.__routeShot.annoStyle.color;
        line.setAttribute('stroke', window.__routeShot.annoStyle.color);
        handle.setAttribute('fill', window.__routeShot.annoStyle.color);
      }, { noStroke: true });
      redraw();
      // Kill on box delete — piggyback the bar's × by observing mutation
      new MutationObserver(() => { if (!document.contains(box)) svg.remove(); }).observe(document.documentElement, { childList: true, subtree: true });
    });

    register('text', '📌', 'sticky note', () => {
      const el = document.createElement('div');
      el.contentEditable = 'true';
      el.textContent = 'Sticky note — click to edit';
      el.style.cssText = 'position:fixed;left:45%;top:45%;width:180px;min-height:80px;z-index:2147483645;' +
        'padding:12px;background:#fff59d;color:#333;font:15px/1.4 "Comic Sans MS", "Segoe Print", cursive;' +
        'border-radius:2px;box-shadow:2px 4px 12px rgba(0,0,0,0.35);cursor:move;outline:none;' +
        'transform:rotate(-2deg);resize:both;overflow:auto;';
      const apply = () => {};
      makeDraggable(el);
      attachAnnoBar(el, apply, {
        noStroke: true, noColor: true,
        extra: (bar) => {
          const c = document.createElement('input'); c.type = 'color'; c.value = '#fff59d';
          c.style.cssText = 'width:24px;height:20px;border:0;background:none;padding:0;';
          c.oninput = () => { el.style.background = c.value; };
          const rot = document.createElement('input'); rot.type = 'range'; rot.min = '-10'; rot.max = '10';
          rot.value = '-2'; rot.style.width = '60px'; rot.title = 'rotate';
          rot.oninput = () => { el.style.transform = 'rotate(' + rot.value + 'deg)'; };
          bar.insertBefore(c, bar.firstChild);
          bar.appendChild(rot);
        },
      });
      document.documentElement.appendChild(el);
    });

    register('text', '🖥', 'terminal bubble', () => {
      const el = document.createElement('div');
      el.contentEditable = 'true';
      el.textContent = '$ node route-shot.js\n> OK';
      el.style.cssText = 'position:fixed;left:45%;top:45%;min-width:200px;min-height:60px;z-index:2147483645;' +
        'padding:10px 14px;background:#0a0a0a;color:#7fd97f;font:13px/1.5 "SF Mono","Cascadia Code",Consolas,monospace;' +
        'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.5);cursor:move;outline:none;white-space:pre;' +
        'border:1px solid #333;resize:both;overflow:auto;';
      makeDraggable(el);
      attachAnnoBar(el, () => {}, { noColor: true, noStroke: true });
      document.documentElement.appendChild(el);
    });

    register('text', '🅦', 'watermark (diagonal)', () => {
      const t = prompt('Watermark text:', 'DRAFT'); if (!t) return;
      const el = document.createElement('div');
      el.textContent = t;
      el.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483644;' +
        'display:flex;align-items:center;justify-content:center;pointer-events:none;' +
        'font:bold 120px/1 system-ui;color:rgba(0,0,0,0.08);transform:rotate(-30deg);' +
        'user-select:none;letter-spacing:0.1em;';
      document.documentElement.appendChild(el);
      // Custom toolbar (pointer-events off on the element)
      el.style.pointerEvents = 'auto';
      attachAnnoBar(el, () => {}, {
        noStroke: true,
        extra: (bar) => {
          const sz = document.createElement('input'); sz.type = 'range'; sz.min = '40'; sz.max = '260';
          sz.value = '120'; sz.style.width = '60px'; sz.title = 'size';
          sz.oninput = () => { el.style.fontSize = sz.value + 'px'; };
          const al = document.createElement('input'); al.type = 'range'; al.min = '0.02'; al.max = '0.4'; al.step = '0.02';
          al.value = '0.08'; al.style.width = '60px'; al.title = 'alpha';
          al.oninput = () => {
            const c = window.__routeShot.annoStyle.color;
            const n = parseInt(c.slice(1), 16);
            el.style.color = 'rgba(' + ((n>>16)&255) + ',' + ((n>>8)&255) + ',' + (n&255) + ',' + al.value + ')';
          };
          bar.appendChild(sz); bar.appendChild(al);
        },
      });
    });

    // --- FRAME: Device frame ----------------------------------------------
    register('frame', '🖥', 'browser chrome frame', () => {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:20%;top:15%;width:60%;height:70%;z-index:2147483644;' +
        'border:3px solid #555;border-top:32px solid #555;border-radius:8px 8px 4px 4px;cursor:move;' +
        'box-shadow:0 12px 40px rgba(0,0,0,0.5);background:transparent;pointer-events:auto;resize:both;overflow:auto;' +
        'box-sizing:border-box;';
      el.innerHTML =
        '<div style="position:absolute;top:-28px;left:12px;display:flex;gap:6px;">' +
        '<span style="width:12px;height:12px;border-radius:50%;background:#ff5f56;"></span>' +
        '<span style="width:12px;height:12px;border-radius:50%;background:#ffbd2e;"></span>' +
        '<span style="width:12px;height:12px;border-radius:50%;background:#27c93f;"></span></div>';
      makeDraggable(el); attachAnnoBar(el, () => {}, { noColor: true, noStroke: true });
      document.documentElement.appendChild(el);
    });

    register('frame', '📱', 'phone frame', () => {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:40%;top:10%;width:260px;height:540px;z-index:2147483644;' +
        'border:12px solid #222;border-radius:32px;cursor:move;box-shadow:0 12px 40px rgba(0,0,0,0.5);' +
        'background:transparent;resize:both;overflow:auto;box-sizing:content-box;';
      makeDraggable(el); attachAnnoBar(el, () => {}, { noColor: true, noStroke: true });
      document.documentElement.appendChild(el);
    });

    register('frame', '💻', 'laptop frame', () => {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:15%;top:20%;width:70%;height:55%;z-index:2147483644;' +
        'border:8px solid #333;border-bottom:20px solid #333;border-radius:8px 8px 18px 18px;cursor:move;' +
        'box-shadow:0 12px 40px rgba(0,0,0,0.5);resize:both;overflow:auto;box-sizing:border-box;';
      makeDraggable(el); attachAnnoBar(el, () => {}, { noColor: true, noStroke: true });
      document.documentElement.appendChild(el);
    });

    // --- assemble widget ----------------------------------------------------
    w.appendChild(row1);
    w.appendChild(captionRow);
    w.appendChild(noteInput);
    w.appendChild(tabsRow);
    w.appendChild(paletteRow);
    document.documentElement.appendChild(w);
    renderTabs();
    renderPalette();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();

  document.addEventListener('keydown', async (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      const r = await snap();
      if (r.error) flash('✗ ' + r.error, false);
      else flash('📸 saved #' + r.count, true);
      return;
    }
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'h') {
      const w = document.getElementById('__routeShotWidget');
      if (w) {
        const hidden = w.style.display === 'none';
        w.style.display = hidden ? '' : 'none';
        flash(hidden ? 'widget shown' : 'widget hidden (press H to show)', true);
      }
    }
  }, true);
})();
