/* no-bs-pdf — a fully client-side PDF editor.
 *
 * Nothing here uploads your file. The PDF bytes are read with FileReader/ArrayBuffer,
 * rendered with PDF.js, edited via an annotation model, and re-assembled with pdf-lib —
 * all in the browser. No network calls touch your document, no cookies, no storage.
 *
 * Coordinate system note:
 *   Annotations are stored in *PDF user-space points* (origin bottom-left, y up), which is
 *   exactly what pdf-lib draws with. PDF.js viewport.convertToPdfPoint / convertToViewportPoint
 *   map between screen pixels and these points (handling scale + rotation), so the same stored
 *   numbers drive both the live canvas preview and the exported PDF.
 */
(() => {
  'use strict';

  const ASSET_VERSION_FALLBACK = '20260606';
  const currentScript = document.currentScript;
  const assetVersion = (() => {
    if (!currentScript || !currentScript.src) return ASSET_VERSION_FALLBACK;
    try {
      return new URL(currentScript.src, window.location.href).searchParams.get('v') || ASSET_VERSION_FALLBACK;
    } catch {
      return ASSET_VERSION_FALLBACK;
    }
  })();
  const assetUrl = (path) => `${path}?v=${encodeURIComponent(assetVersion)}`;

  let pdfjsLib = window.pdfjsLib || null;
  let PDFLib = window.PDFLib || null;
  let pdfRuntimeReady = null;
  let pdfRuntimeConfigured = false;
  let workerObjectUrl = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  async function configurePdfWorker() {
    const workerUrl = assetUrl('vendor/pdf.worker.min.js');
    try {
      const blob = await fetch(workerUrl).then((r) => { if (!r.ok) throw 0; return r.blob(); });
      if (workerObjectUrl) URL.revokeObjectURL(workerObjectUrl);
      workerObjectUrl = URL.createObjectURL(blob);
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerObjectUrl;
    } catch {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    }
  }

  async function ensurePdfRuntime() {
    if (pdfRuntimeConfigured) return;
    if (!pdfRuntimeReady) {
      pdfRuntimeReady = (async () => {
        if (!pdfjsLib) {
          await loadScript(assetUrl('vendor/pdf.min.js'));
          pdfjsLib = window.pdfjsLib || null;
        }
        if (!PDFLib) {
          await loadScript(assetUrl('vendor/pdf-lib.min.js'));
          PDFLib = window.PDFLib || null;
        }
        if (!pdfjsLib || !PDFLib) throw new Error('PDF tools failed to initialize.');
        await configurePdfWorker();
        pdfRuntimeConfigured = true;
      })().catch((e) => {
        pdfRuntimeReady = null;
        throw e;
      });
    }
    await pdfRuntimeReady;
  }

  function isRuntimeLoadError(e) {
    return /PDF tools failed|Failed to load vendor\//.test(e && e.message ? e.message : '');
  }

  // ---------------------------------------------------------------- state ---
  const state = {
    sources: {},        // srcId -> { bytes: Uint8Array, pdfjsDoc, pageCache: Map }
    images: {},         // imageId -> { bytes, fmt, dataUrl, el }
    pages: [],          // ordered page model (see makePage)
    current: 0,
    scale: 1,
    tool: 'select',
    color: '#e23b3b',
    size: 16,
    fill: false,
    selected: null,     // { page, ann } reference into state.pages
    undo: [],
    redo: [],
    renderSeq: 0,
    baseName: 'document',
  };

  let srcCounter = 0;
  let imgCounter = 0;

  // page model factory
  const makePage = (srcId, srcPageIndex, opts = {}) => ({
    id: 'p' + Math.random().toString(36).slice(2, 9),
    srcId,
    srcPageIndex,
    rotation: 0,                 // user-added rotation, multiple of 90
    annotations: [],
    blank: opts.blank || null,   // { width, height } for synthetic pages
  });

  // ------------------------------------------------------------ DOM refs ---
  const $ = (id) => document.getElementById(id);
  const dom = {
    fileInput: $('fileInput'), imageInput: $('imageInput'), mergeInput: $('mergeInput'),
    btnOpen: $('btnOpen'), dzOpen: $('dzOpen'),
    workspace: $('workspace'), dropzone: $('dropzone'),
    thumbs: $('thumbs'),
    pageCanvas: $('pageCanvas'), overlay: $('overlayCanvas'), stage: $('canvasStage'),
    scroll: $('canvasScroll'), textEditor: $('textEditor'),
    pageIndicator: $('pageIndicator'), zoomIndicator: $('zoomIndicator'),
    colorInput: $('colorInput'), sizeInput: $('sizeInput'), sizeLabel: $('sizeLabel'),
    fillInput: $('fillInput'),
    btnUndo: $('btnUndo'), btnRedo: $('btnRedo'), btnDelete: $('btnDelete'),
    btnDownload: $('btnDownload'),
    btnPrev: $('btnPrev'), btnNext: $('btnNext'),
    btnRotateL: $('btnRotateL'), btnRotateR: $('btnRotateR'),
    btnDup: $('btnDup'), btnDelPage: $('btnDelPage'),
    btnAddBlank: $('btnAddBlank'), btnMerge: $('btnMerge'),
    btnZoomIn: $('btnZoomIn'), btnZoomOut: $('btnZoomOut'), btnZoomFit: $('btnZoomFit'),
    toast: $('toast'),
  };
  const octx = dom.overlay.getContext('2d');
  const pctx = dom.pageCanvas.getContext('2d');
  const measureCtx = document.createElement('canvas').getContext('2d');

  // ----------------------------------------------------------- utilities ---
  function toast(msg, kind = '', ms = 2200) {
    dom.toast.textContent = msg;
    dom.toast.className = kind;
    dom.toast.hidden = false;
    clearTimeout(toast._t);
    if (ms) toast._t = setTimeout(() => { dom.toast.hidden = true; }, ms);
  }
  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  };
  const rgb01 = (hex) => { const c = hexToRgb(hex); return PDFLib.rgb(c.r, c.g, c.b); };

  // text metrics (in PDF points, since we measure at the stored font size)
  const FONT = 'Helvetica, Arial, sans-serif';
  const ASCENT = 0.76, LINE = 1.15; // fractions of font size
  function textWidth(line, size) {
    measureCtx.font = `${size}px ${FONT}`;
    return measureCtx.measureText(line).width;
  }
  function textBox(a) {
    const lines = a.text.split('\n');
    const w = Math.max(1, ...lines.map((l) => textWidth(l, a.size)));
    const h = lines.length * a.size * LINE;
    // (a.x, a.yTop) is the top-left in PDF space; box extends down/right
    return { x: a.x, y: a.yTop - h, w, h };
  }
  function annBox(a) {
    switch (a.type) {
      case 'text': return textBox(a);
      case 'pen': {
        const xs = a.pts.map((p) => p[0]), ys = a.pts.map((p) => p[1]);
        const pad = a.width;
        return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
                 w: Math.max(...xs) - Math.min(...xs) + 2 * pad,
                 h: Math.max(...ys) - Math.min(...ys) + 2 * pad };
      }
      default: return { x: a.x, y: a.y, w: a.w, h: a.h }; // box types
    }
  }

  // --------------------------------------------------------- page context ---
  // Returns { viewport, pdfPage|null } sized at the given scale, honoring rotation.
  async function pageContext(page, scale) {
    if (page.blank) {
      const { width: w, height: h } = page.blank;
      const vp = {
        width: w * scale, height: h * scale,
        convertToViewportPoint: (x, y) => [x * scale, (h - y) * scale],
        convertToPdfPoint: (vx, vy) => [vx / scale, h - vy / scale],
      };
      return { viewport: vp, pdfPage: null };
    }
    const src = state.sources[page.srcId];
    const key = page.srcPageIndex;
    let pdfPage = src.pageCache.get(key);
    if (!pdfPage) { pdfPage = await src.pdfjsDoc.getPage(key + 1); src.pageCache.set(key, pdfPage); }
    const rotation = (pdfPage.rotate + page.rotation) % 360;
    const viewport = pdfPage.getViewport({ scale, rotation });
    return { viewport, pdfPage };
  }
  // unrotated page size in points (for "fit" + blank defaults)
  async function pageSize(page) {
    if (page.blank) return { w: page.blank.width, h: page.blank.height };
    const { viewport } = await pageContext(page, 1);
    // viewport at scale 1 may be rotated; return as displayed
    return { w: viewport.width, h: viewport.height };
  }

  let currentViewport = null;

  // ------------------------------------------------------------ rendering ---
  async function renderMain() {
    if (!state.pages.length) return;
    const page = state.pages[state.current];
    const seq = ++state.renderSeq;
    const { viewport, pdfPage } = await pageContext(page, state.scale);
    if (seq !== state.renderSeq) return;

    for (const c of [dom.pageCanvas, dom.overlay]) {
      c.width = Math.round(viewport.width);
      c.height = Math.round(viewport.height);
      c.style.width = c.width + 'px';
      c.style.height = c.height + 'px';
    }
    dom.stage.style.width = dom.pageCanvas.width + 'px';

    pctx.fillStyle = '#fff';
    pctx.fillRect(0, 0, dom.pageCanvas.width, dom.pageCanvas.height);
    if (pdfPage) {
      await pdfPage.render({ canvasContext: pctx, viewport }).promise;
      if (seq !== state.renderSeq) return;
    }
    currentViewport = viewport;
    drawOverlay();
    updatePageUI();
  }

  function drawAnnotations(ctx, viewport, page, pxPerPt) {
    const V = (x, y) => viewport.convertToViewportPoint(x, y);
    for (const a of page.annotations) {
      ctx.save();
      if (a.type === 'text') {
        const [vx, vy] = V(a.x, a.yTop);
        ctx.fillStyle = a.color;
        ctx.font = `${a.size * pxPerPt}px ${FONT}`;
        ctx.textBaseline = 'top';
        a.text.split('\n').forEach((line, i) => {
          ctx.fillText(line, vx, vy + i * a.size * LINE * pxPerPt);
        });
      } else if (a.type === 'pen') {
        ctx.strokeStyle = a.color; ctx.lineWidth = Math.max(1, a.width * pxPerPt);
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        a.pts.forEach((p, i) => { const [vx, vy] = V(p[0], p[1]); i ? ctx.lineTo(vx, vy) : ctx.moveTo(vx, vy); });
        ctx.stroke();
      } else {
        // box types: convert both corners (robust under rotation)
        const [x1, y1] = V(a.x, a.y), [x2, y2] = V(a.x + a.w, a.y + a.h);
        const x = Math.min(x1, x2), y = Math.min(y1, y2);
        const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
        if (a.type === 'highlight') {
          ctx.globalAlpha = 0.4; ctx.fillStyle = a.color; ctx.fillRect(x, y, w, h);
        } else if (a.type === 'whiteout') {
          ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, w, h);
        } else if (a.type === 'rect') {
          if (a.fill) { ctx.fillStyle = a.color; ctx.fillRect(x, y, w, h); }
          ctx.strokeStyle = a.color; ctx.lineWidth = Math.max(1, a.width * pxPerPt);
          ctx.strokeRect(x, y, w, h);
        } else if (a.type === 'image') {
          const img = state.images[a.imageId];
          if (img && img.el.complete) ctx.drawImage(img.el, x, y, w, h);
        }
      }
      ctx.restore();
    }
  }

  function drawOverlay() {
    octx.clearRect(0, 0, dom.overlay.width, dom.overlay.height);
    const page = state.pages[state.current];
    drawAnnotations(octx, currentViewport, page, state.scale);
    drawSelection();
  }

  function drawSelection() {
    if (!state.selected || state.selected.page !== state.pages[state.current]) return;
    const a = state.selected.ann;
    const b = annBox(a);
    const [x1, y1] = currentViewport.convertToViewportPoint(b.x, b.y);
    const [x2, y2] = currentViewport.convertToViewportPoint(b.x + b.w, b.y + b.h);
    const x = Math.min(x1, x2) - 3, y = Math.min(y1, y2) - 3;
    const w = Math.abs(x2 - x1) + 6, h = Math.abs(y2 - y1) + 6;
    octx.save();
    octx.strokeStyle = '#4f8cff'; octx.lineWidth = 1.5; octx.setLineDash([5, 4]);
    octx.strokeRect(x, y, w, h);
    if (isBox(a) || a.type === 'image') {
      octx.setLineDash([]); octx.fillStyle = '#4f8cff';
      octx.fillRect(x + w - 5, y + h - 5, 10, 10); // resize handle (bottom-right)
    }
    octx.restore();
  }

  const isBox = (a) => ['highlight', 'whiteout', 'rect', 'image'].includes(a.type);

  // ----------------------------------------------------------- thumbnails ---
  async function renderThumbs() {
    dom.thumbs.innerHTML = '';
    for (let i = 0; i < state.pages.length; i++) {
      const li = document.createElement('li');
      li.className = 'thumb' + (i === state.current ? ' active' : '');
      li.draggable = true;
      li.dataset.index = i;
      const canvas = document.createElement('canvas');
      const num = document.createElement('span');
      num.className = 'num'; num.textContent = i + 1;
      li.append(canvas, num);
      dom.thumbs.appendChild(li);
      renderThumb(canvas, i); // async, fills in when ready
    }
  }
  async function renderThumb(canvas, index) {
    const page = state.pages[index];
    const fit = 168;
    const size = await pageSize(page);
    const scale = fit / size.w;
    const { viewport, pdfPage } = await pageContext(page, scale);
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (pdfPage) await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    drawAnnotations(ctx, viewport, page, scale);
  }
  function refreshCurrentThumb() {
    const li = dom.thumbs.children[state.current];
    if (li) renderThumb(li.querySelector('canvas'), state.current);
  }

  // -------------------------------------------------------------- history ---
  function snapshot() {
    return JSON.stringify({
      pages: state.pages.map((p) => ({ ...p, annotations: p.annotations })),
      current: state.current,
    });
  }
  function pushHistory() {
    state.undo.push(snapshot());
    if (state.undo.length > 80) state.undo.shift();
    state.redo.length = 0;
    updateButtons();
  }
  function restore(json) {
    const s = JSON.parse(json);
    state.pages = s.pages;
    state.current = Math.min(s.current, state.pages.length - 1);
    state.selected = null;
  }
  function undo() {
    if (!state.undo.length) return;
    state.redo.push(snapshot());
    restore(state.undo.pop());
    renderThumbs(); renderMain(); updateButtons();
  }
  function redo() {
    if (!state.redo.length) return;
    state.undo.push(snapshot());
    restore(state.redo.pop());
    renderThumbs(); renderMain(); updateButtons();
  }

  // ------------------------------------------------------------- file I/O ---
  async function loadAsSource(bytes) {
    const id = 'src' + (++srcCounter);
    // PDF.js detaches the buffer it receives, so hand it its own copy.
    const pdfjsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    state.sources[id] = { bytes, pdfjsDoc, pageCache: new Map() };
    return { id, pdfjsDoc };
  }

  async function openPdf(file) {
    try {
      toast('Loading PDF tools...', 'busy', 0);
      await ensurePdfRuntime();
      toast('Reading PDF...', 'busy', 0);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { id, pdfjsDoc } = await loadAsSource(bytes);
      // reset document state
      state.sources = { [id]: state.sources[id] };
      state.images = {};
      state.pages = [];
      for (let i = 0; i < pdfjsDoc.numPages; i++) state.pages.push(makePage(id, i));
      state.current = 0;
      state.undo = []; state.redo = []; state.selected = null;
      state.baseName = (file.name || 'document').replace(/\.pdf$/i, '');

      dom.dropzone.hidden = true;
      dom.workspace.hidden = false;
      dom.btnDownload.disabled = false;
      await renderThumbs();
      await fitWidth();
      updateButtons();
      toast(`Loaded ${pdfjsDoc.numPages} page${pdfjsDoc.numPages > 1 ? 's' : ''}.`, '', 1600);
    } catch (e) {
      console.error(e);
      toast(
        isRuntimeLoadError(e)
          ? 'Could not load PDF tools. Check your connection and try again.'
          : 'Could not read that PDF. Is it valid / unencrypted?',
        'error',
        4000
      );
    }
  }

  async function mergePdf(file) {
    try {
      toast('Loading PDF tools...', 'busy', 0);
      await ensurePdfRuntime();
      toast('Appending PDF...', 'busy', 0);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { id, pdfjsDoc } = await loadAsSource(bytes);
      pushHistory();
      for (let i = 0; i < pdfjsDoc.numPages; i++) state.pages.push(makePage(id, i));
      await renderThumbs();
      toast(`Appended ${pdfjsDoc.numPages} page(s).`, '', 1800);
      updateButtons();
    } catch (e) {
      console.error(e);
      toast(
        isRuntimeLoadError(e)
          ? 'Could not load PDF tools. Check your connection and try again.'
          : 'Could not append that PDF.',
        'error',
        3500
      );
    }
  }

  function loadImage(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const id = 'img' + (++imgCounter);
      const dataUrl = reader.result;
      const el = new Image();
      el.onload = () => { refreshCurrentThumb(); drawOverlay(); };
      el.src = dataUrl;
      const fmt = /image\/png/i.test(file.type) ? 'png' : 'jpg';
      // keep raw bytes for pdf-lib embedding
      const fr2 = new FileReader();
      fr2.onload = () => {
        state.images[id] = { bytes: new Uint8Array(fr2.result), fmt, dataUrl, el };
        pendingImage = id;
        toast('Click on the page to place the image.', '', 2600);
      };
      fr2.readAsArrayBuffer(file);
    };
    reader.readAsDataURL(file);
  }
  let pendingImage = null;

  // ------------------------------------------------------ pointer / tools ---
  function pointerPdf(e) {
    const r = dom.overlay.getBoundingClientRect();
    const vx = (e.clientX - r.left) * (dom.overlay.width / r.width);
    const vy = (e.clientY - r.top) * (dom.overlay.height / r.height);
    return currentViewport.convertToPdfPoint(vx, vy);
  }
  function pointerView(e) {
    const r = dom.overlay.getBoundingClientRect();
    return [(e.clientX - r.left) * (dom.overlay.width / r.width),
            (e.clientY - r.top) * (dom.overlay.height / r.height)];
  }

  let gesture = null; // active drawing/move/resize gesture

  dom.overlay.addEventListener('pointerdown', (e) => {
    if (!state.pages.length) return;
    if (!dom.textEditor.hidden) return; // let the text editor finish first
    dom.overlay.setPointerCapture(e.pointerId);
    const page = state.pages[state.current];
    const [px, py] = pointerPdf(e);

    if (state.tool === 'select') {
      // hit-test resize handle of current selection first
      if (state.selected && state.selected.page === page && (isBox(state.selected.ann))) {
        const b = annBox(state.selected.ann);
        const [hx, hy] = currentViewport.convertToViewportPoint(b.x + b.w, b.y); // bottom-right in PDF = screen handle
        const [vx, vy] = pointerView(e);
        if (Math.abs(vx - hx) <= 8 && Math.abs(vy - hy) <= 8) {
          pushHistory();
          gesture = { kind: 'resize', ann: state.selected.ann,
                      anchor: [b.x, b.y + b.h] }; // PDF top-left fixed
          return;
        }
      }
      // hit-test annotations (top-most first)
      const hit = [...page.annotations].reverse().find((a) => insideBox(annBox(a), px, py));
      if (hit) {
        state.selected = { page, ann: hit };
        pushHistory();
        gesture = { kind: 'move', ann: hit, last: [px, py] };
        if (hit.type === 'text') gesture.dblTimer = Date.now();
      } else {
        state.selected = null;
        gesture = null;
      }
      drawOverlay(); updateButtons();
      return;
    }

    if (state.tool === 'text') {
      openTextEditor(e);
      return;
    }

    if (state.tool === 'image') {
      if (!pendingImage) { dom.imageInput.click(); return; }
      placeImage(px, py);
      return;
    }

    pushHistory();
    if (state.tool === 'pen') {
      const a = { type: 'pen', pts: [[px, py]], width: state.size, color: state.color };
      page.annotations.push(a);
      gesture = { kind: 'pen', ann: a };
    } else {
      // box drag (highlight / rect / whiteout)
      const a = boxForTool(px, py);
      page.annotations.push(a);
      gesture = { kind: 'draw-box', ann: a, start: [px, py] };
    }
    drawOverlay();
  });

  dom.overlay.addEventListener('pointermove', (e) => {
    if (!gesture) return;
    const [px, py] = pointerPdf(e);
    if (gesture.kind === 'pen') {
      gesture.ann.pts.push([px, py]);
    } else if (gesture.kind === 'draw-box') {
      const [sx, sy] = gesture.start;
      gesture.ann.x = Math.min(sx, px); gesture.ann.y = Math.min(sy, py);
      gesture.ann.w = Math.abs(px - sx); gesture.ann.h = Math.abs(py - sy);
    } else if (gesture.kind === 'move') {
      const dx = px - gesture.last[0], dy = py - gesture.last[1];
      gesture.last = [px, py];
      moveAnn(gesture.ann, dx, dy);
    } else if (gesture.kind === 'resize') {
      const [ax, ay] = gesture.anchor;       // fixed PDF top-left
      const x = Math.min(ax, px), right = Math.max(ax, px);
      const top = Math.max(ay, py), bottom = Math.min(ay, py);
      gesture.ann.x = x; gesture.ann.w = right - x;
      gesture.ann.y = bottom; gesture.ann.h = top - bottom;
    }
    drawOverlay();
  });

  function endGesture(e) {
    if (!gesture) return;
    const g = gesture; gesture = null;
    const page = state.pages[state.current];
    if (g.kind === 'draw-box') {
      if (g.ann.w < 2 || g.ann.h < 2) { // discard accidental clicks
        page.annotations.pop(); state.undo.pop();
      } else {
        state.selected = { page, ann: g.ann };
      }
    }
    if (g.kind === 'pen' && g.ann.pts.length < 2) { page.annotations.pop(); state.undo.pop(); }
    drawOverlay(); refreshCurrentThumb(); updateButtons();
  }
  dom.overlay.addEventListener('pointerup', endGesture);
  dom.overlay.addEventListener('pointercancel', endGesture);

  // double-click text to edit
  dom.overlay.addEventListener('dblclick', (e) => {
    const page = state.pages[state.current];
    const [px, py] = pointerPdf(e);
    const hit = [...page.annotations].reverse().find((a) => a.type === 'text' && insideBox(annBox(a), px, py));
    if (hit) { state.selected = { page, ann: hit }; openTextEditor(e, hit); }
  });

  const insideBox = (b, px, py) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;

  function moveAnn(a, dx, dy) {
    if (a.type === 'pen') { a.pts.forEach((p) => { p[0] += dx; p[1] += dy; }); }
    else if (a.type === 'text') { a.x += dx; a.yTop += dy; }
    else { a.x += dx; a.y += dy; }
  }

  function boxForTool(px, py) {
    const base = { x: px, y: py, w: 0, h: 0 };
    if (state.tool === 'highlight') return { type: 'highlight', ...base, color: state.color };
    if (state.tool === 'whiteout') return { type: 'whiteout', ...base };
    return { type: 'rect', ...base, color: state.color, width: state.size, fill: state.fill };
  }

  function placeImage(px, py) {
    const img = state.images[pendingImage];
    const maxW = 220; // points
    const ratio = img.el.naturalHeight / img.el.naturalWidth || 1;
    const w = Math.min(maxW, img.el.naturalWidth);
    const h = w * ratio;
    pushHistory();
    const a = { type: 'image', x: px - w / 2, y: py - h / 2, w, h, imageId: pendingImage };
    state.pages[state.current].annotations.push(a);
    state.selected = { page: state.pages[state.current], ann: a };
    pendingImage = null;
    setTool('select');
    drawOverlay(); refreshCurrentThumb(); updateButtons();
  }

  // ------------------------------------------------------- text edit flow ---
  let editingText = null; // { ann | null, x, yTop }
  function openTextEditor(e, existing) {
    const page = state.pages[state.current];
    const ta = dom.textEditor;
    let vx, vy, size, color, value;
    if (existing) {
      const [evx, evy] = currentViewport.convertToViewportPoint(existing.x, existing.yTop);
      vx = evx; vy = evy; size = existing.size; color = existing.color; value = existing.text;
      editingText = { ann: existing };
    } else {
      const [px, py] = pointerPdf(e);
      const [evx, evy] = currentViewport.convertToViewportPoint(px, py);
      vx = evx; vy = evy; size = state.size; color = state.color; value = '';
      editingText = { x: px, yTop: py };
    }
    ta.value = value;
    ta.style.left = vx + 'px';
    ta.style.top = vy + 'px';
    ta.style.fontSize = (size * state.scale) + 'px';
    ta.style.color = color;
    ta.style.height = 'auto';
    ta.hidden = false;
    autosizeTextarea();
    ta.focus();
    if (existing) ta.select();
  }
  function autosizeTextarea() {
    const ta = dom.textEditor;
    ta.style.height = 'auto';
    ta.style.width = 'auto';
    const height = ta.scrollHeight;
    const width = ta.scrollWidth;
    ta.style.height = height + 'px';
    ta.style.width = Math.max(20, width + 4) + 'px';
  }
  dom.textEditor.addEventListener('input', autosizeTextarea);
  dom.textEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitText(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
  });
  dom.textEditor.addEventListener('blur', commitText);

  function commitText() {
    const ta = dom.textEditor;
    if (ta.hidden || !editingText) return;
    const text = ta.value.replace(/\s+$/g, '');
    const page = state.pages[state.current];
    if (editingText.ann) {
      if (!text) { // emptied -> delete
        pushHistory();
        const i = page.annotations.indexOf(editingText.ann);
        if (i >= 0) page.annotations.splice(i, 1);
        state.selected = null;
      } else if (text !== editingText.ann.text) {
        pushHistory();
        editingText.ann.text = text;
      }
    } else if (text) {
      pushHistory();
      const a = { type: 'text', x: editingText.x, yTop: editingText.yTop,
                  text, size: state.size, color: state.color };
      page.annotations.push(a);
      state.selected = { page, ann: a };
    }
    ta.hidden = true; editingText = null;
    drawOverlay(); refreshCurrentThumb(); updateButtons();
  }
  function cancelText() { dom.textEditor.hidden = true; editingText = null; drawOverlay(); }

  // --------------------------------------------------------- page actions ---
  function deleteSelected() {
    if (!state.selected) return;
    const { page, ann } = state.selected;
    const i = page.annotations.indexOf(ann);
    if (i >= 0) { pushHistory(); page.annotations.splice(i, 1); state.selected = null; }
    drawOverlay(); refreshCurrentThumb(); updateButtons();
  }
  function rotatePage(delta) {
    pushHistory();
    const p = state.pages[state.current];
    p.rotation = ((p.rotation + delta) % 360 + 360) % 360;
    renderMain(); refreshCurrentThumb(); updateButtons();
  }
  function duplicatePage() {
    pushHistory();
    const p = state.pages[state.current];
    const copy = JSON.parse(JSON.stringify(p));
    copy.id = 'p' + Math.random().toString(36).slice(2, 9);
    state.pages.splice(state.current + 1, 0, copy);
    state.current++;
    renderThumbs(); renderMain(); updateButtons();
  }
  function deletePage() {
    if (state.pages.length <= 1) { toast('A PDF needs at least one page.', 'error'); return; }
    pushHistory();
    state.pages.splice(state.current, 1);
    state.current = Math.min(state.current, state.pages.length - 1);
    state.selected = null;
    renderThumbs(); renderMain(); updateButtons();
  }
  async function addBlank() {
    pushHistory();
    let size = { w: 595, h: 842 }; // A4 default
    if (state.pages.length) size = await pageSize(state.pages[state.current]);
    state.pages.splice(state.current + 1, 0, makePage(null, 0, { blank: { width: size.w, height: size.h } }));
    state.current++;
    renderThumbs(); renderMain(); updateButtons();
  }

  function goTo(index) {
    if (!dom.textEditor.hidden) commitText();
    state.current = Math.max(0, Math.min(index, state.pages.length - 1));
    state.selected = null;
    [...dom.thumbs.children].forEach((li, i) => li.classList.toggle('active', i === state.current));
    renderMain();
  }

  // thumbnail interactions: click to navigate, drag to reorder
  let dragIndex = null;
  dom.thumbs.addEventListener('click', (e) => {
    const li = e.target.closest('.thumb'); if (li) goTo(+li.dataset.index);
  });
  dom.thumbs.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.thumb'); if (!li) return;
    dragIndex = +li.dataset.index; e.dataTransfer.effectAllowed = 'move';
  });
  dom.thumbs.addEventListener('dragover', (e) => {
    e.preventDefault();
    const li = e.target.closest('.thumb');
    [...dom.thumbs.children].forEach((c) => c.classList.toggle('dragover', c === li));
  });
  dom.thumbs.addEventListener('drop', (e) => {
    e.preventDefault();
    const li = e.target.closest('.thumb');
    [...dom.thumbs.children].forEach((c) => c.classList.remove('dragover'));
    if (li == null || dragIndex == null) return;
    const to = +li.dataset.index;
    if (to === dragIndex) return;
    pushHistory();
    const [moved] = state.pages.splice(dragIndex, 1);
    state.pages.splice(to, 0, moved);
    state.current = to;
    dragIndex = null;
    renderThumbs(); renderMain(); updateButtons();
  });

  // ----------------------------------------------------------------- zoom ---
  async function fitWidth() {
    const page = state.pages[state.current];
    const size = await pageSize(page);
    const avail = dom.scroll.clientWidth - 56;
    state.scale = Math.max(0.1, Math.min(4, avail / size.w));
    await renderMain();
  }
  function setZoom(s) { state.scale = Math.max(0.1, Math.min(6, s)); renderMain(); }

  // -------------------------------------------------------------- export ---
  async function downloadPdf() {
    try {
      if (!dom.textEditor.hidden) commitText();
      await ensurePdfRuntime();
      toast('Building your PDF...', 'busy', 0);
      const out = await PDFLib.PDFDocument.create();
      const font = await out.embedFont(PDFLib.StandardFonts.Helvetica);

      // load each source once with pdf-lib; cache embedded images
      const libDocs = {};
      for (const [id, src] of Object.entries(state.sources)) {
        libDocs[id] = await PDFLib.PDFDocument.load(src.bytes, { ignoreEncryption: true });
      }
      const embedded = {};
      const embedImage = async (imgId) => {
        if (embedded[imgId]) return embedded[imgId];
        const im = state.images[imgId];
        embedded[imgId] = im.fmt === 'png' ? await out.embedPng(im.bytes) : await out.embedJpg(im.bytes);
        return embedded[imgId];
      };

      for (const entry of state.pages) {
        let page;
        if (entry.blank) {
          page = out.addPage([entry.blank.width, entry.blank.height]);
        } else {
          const [copied] = await out.copyPages(libDocs[entry.srcId], [entry.srcPageIndex]);
          page = out.addPage(copied);
        }
        const base = page.getRotation().angle;
        const total = ((base + entry.rotation) % 360 + 360) % 360;
        page.setRotation(PDFLib.degrees(total));
        await drawToPdf(out, page, entry, font, total, embedImage);
      }

      const bytes = await out.save();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${state.baseName}-edited.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Saved. Check your downloads.', '', 2500);
    } catch (e) {
      console.error(e);
      toast('Export failed: ' + e.message, 'error', 5000);
    }
  }

  async function drawToPdf(out, page, entry, font, total, embedImage) {
    const rotate = PDFLib.degrees(-total); // keep text/images upright on rotated pages
    for (const a of entry.annotations) {
      if (a.type === 'text') {
        const lines = a.text.split('\n');
        lines.forEach((line, i) => {
          // baseline of line i, measured down from the top in PDF space
          const yBaseline = a.yTop - a.size * ASCENT - i * a.size * LINE;
          page.drawText(line, { x: a.x, y: yBaseline, size: a.size, font, color: rgb01(a.color), rotate });
        });
      } else if (a.type === 'pen') {
        for (let i = 1; i < a.pts.length; i++) {
          page.drawLine({
            start: { x: a.pts[i - 1][0], y: a.pts[i - 1][1] },
            end: { x: a.pts[i][0], y: a.pts[i][1] },
            thickness: a.width, color: rgb01(a.color), lineCap: PDFLib.LineCapStyle.Round,
          });
        }
      } else if (a.type === 'highlight') {
        page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color: rgb01(a.color), opacity: 0.4 });
      } else if (a.type === 'whiteout') {
        page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color: PDFLib.rgb(1, 1, 1) });
      } else if (a.type === 'rect') {
        page.drawRectangle({
          x: a.x, y: a.y, width: a.w, height: a.h,
          borderColor: rgb01(a.color), borderWidth: a.width,
          color: a.fill ? rgb01(a.color) : undefined,
        });
      } else if (a.type === 'image') {
        const img = await embedImage(a.imageId);
        page.drawImage(img, { x: a.x, y: a.y, width: a.w, height: a.h, rotate });
      }
    }
  }

  // ----------------------------------------------------------------- UI ----
  function setTool(tool) {
    state.tool = tool;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    dom.overlay.className = 'tool-' + tool;
    dom.sizeLabel.textContent = (tool === 'text') ? 'Font' : 'Width';
    if (tool !== 'select') { state.selected = null; drawOverlay && currentViewport && drawOverlay(); }
    if (tool === 'image' && !pendingImage) dom.imageInput.click();
  }
  function updatePageUI() {
    dom.pageIndicator.textContent = `${state.current + 1} / ${state.pages.length}`;
    dom.zoomIndicator.textContent = Math.round(state.scale * 100) + '%';
    dom.btnPrev.disabled = state.current === 0;
    dom.btnNext.disabled = state.current === state.pages.length - 1;
  }
  function updateButtons() {
    dom.btnUndo.disabled = !state.undo.length;
    dom.btnRedo.disabled = !state.redo.length;
    dom.btnDelete.disabled = !state.selected;
    updatePageUI();
  }

  // -------------------------------------------------------- event wiring ---
  dom.btnOpen.onclick = () => dom.fileInput.click();
  dom.dzOpen.onclick = () => dom.fileInput.click();
  dom.fileInput.onchange = (e) => { if (e.target.files[0]) openPdf(e.target.files[0]); e.target.value = ''; };
  dom.mergeInput.onchange = (e) => { if (e.target.files[0]) mergePdf(e.target.files[0]); e.target.value = ''; };
  dom.imageInput.onchange = (e) => { if (e.target.files[0]) loadImage(e.target.files[0]); e.target.value = ''; };

  document.querySelectorAll('.tool').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });

  dom.colorInput.oninput = (e) => {
    state.color = e.target.value;
    if (state.selected && 'color' in state.selected.ann) {
      pushHistory(); state.selected.ann.color = state.color; drawOverlay(); refreshCurrentThumb();
    }
  };
  dom.sizeInput.oninput = (e) => {
    state.size = Math.max(1, +e.target.value || 1);
    if (state.selected) {
      const a = state.selected.ann;
      if (a.type === 'text') { pushHistory(); a.size = state.size; drawOverlay(); refreshCurrentThumb(); }
      else if ('width' in a) { pushHistory(); a.width = state.size; drawOverlay(); refreshCurrentThumb(); }
    }
  };
  dom.fillInput.onchange = (e) => {
    state.fill = e.target.checked;
    if (state.selected && state.selected.ann.type === 'rect') {
      pushHistory(); state.selected.ann.fill = state.fill; drawOverlay(); refreshCurrentThumb();
    }
  };

  dom.btnUndo.onclick = undo;
  dom.btnRedo.onclick = redo;
  dom.btnDelete.onclick = deleteSelected;
  dom.btnDownload.onclick = downloadPdf;

  dom.btnPrev.onclick = () => goTo(state.current - 1);
  dom.btnNext.onclick = () => goTo(state.current + 1);
  dom.btnRotateL.onclick = () => rotatePage(-90);
  dom.btnRotateR.onclick = () => rotatePage(90);
  dom.btnDup.onclick = duplicatePage;
  dom.btnDelPage.onclick = deletePage;
  dom.btnAddBlank.onclick = addBlank;
  dom.btnMerge.onclick = () => dom.mergeInput.click();

  dom.btnZoomIn.onclick = () => setZoom(state.scale * 1.2);
  dom.btnZoomOut.onclick = () => setZoom(state.scale / 1.2);
  dom.btnZoomFit.onclick = fitWidth;

  // keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (!dom.textEditor.hidden) return; // typing
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) { if (state.selected) { e.preventDefault(); deleteSelected(); } }
    else if (!state.pages.length) return;
    else if (e.key === 'ArrowLeft' && !mod) goTo(state.current - 1);
    else if (e.key === 'ArrowRight' && !mod) goTo(state.current + 1);
    else if (!mod) {
      const map = { v: 'select', t: 'text', p: 'pen', h: 'highlight', r: 'rect', w: 'whiteout' };
      const t = map[e.key.toLowerCase()];
      if (t) setTool(t);
    }
  });

  // drag & drop onto the page
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
      e.preventDefault(); dom.dropzone.classList.add('dragging');
    }
  }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
    if (ev === 'dragleave' && e.relatedTarget) return;
    dom.dropzone.classList.remove('dragging');
  }));
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      if (state.pages.length) {
        if (confirm('Open this as a new document? (Use the "＋ PDF" button to append instead.)')) openPdf(f);
      } else openPdf(f);
    } else if (/^image\//.test(f.type)) {
      if (state.pages.length) { setTool('image'); loadImage(f); }
    }
  });

  window.addEventListener('resize', () => { if (state.pages.length) drawOverlay(); });

  // ----------------------------------------------------------- bootstrap ---
  function init() {
    setTool('select');
    updateButtons();
  }
  init();
})();
