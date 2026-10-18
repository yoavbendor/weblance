// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// Page logic: the map (canvas), a pool of six weblance workers, the click -> rows queue, the gallery and
// the live counters. Each worker opens the dataset once and reads one row at a time (synchronous XHR
// inside a worker). Counters come from the workers' wl_stats_json.

const HF_DATASET =
  'https://huggingface.co/datasets/jrmiller/coco-2017-siglip2-embeddings/resolve/main/lancedb/coco_clip_embeddings.lance';
const HF_DATA_BYTES = 48238347496; // size of the dataset's single data file
const POOL_SIZE = 6;
const NEIGHBOURS = 12;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

// Overrides: ?dataset=<lance dir URL>&points=<uint16 xy file>&labels=<json>&size=<data file bytes>
const params = new URLSearchParams(location.search);
const DATASET = params.get('dataset') || HF_DATASET;
const POINTS_URL = params.get('points') || 'data/points.bin';
const LABELS_URL = params.get('labels') || 'data/labels.json';
const DATA_BYTES = Number(params.get('size')) || (params.get('dataset') ? 0 : HF_DATA_BYTES);

const $ = (id) => document.getElementById(id);
const el = {
  canvas: $('map'),
  wrap: $('map-wrap'),
  hint: $('hint'),
  status: $('status'),
  pool: $('pool'),
  gallery: $('gallery'),
};
const canvasCtx = el.canvas.getContext('2d');
const base = document.createElement('canvas'); // map drawn once per size/theme; overlays drawn on top

// ---- counters -------------------------------------------------------------------------------------

const pageStart = performance.now();
const totals = { requests: 0, bytes: 0 };
const perImage = { sum: 0, count: 0 };
let openSettled = 0;
let firstOpenMs = null;
let allSettledMs = null;
let firstError = '';
let click = null; // the click being served: {id, t0, rows, pending, done, cards, firstMs, lastMs, requests, bytes}
let clickSeq = 0;
const objectUrls = [];
const r1 = (x) => Math.round(x * 10) / 10;

function addTotals(stats) {
  if (!stats) return;
  totals.requests += stats.requests;
  totals.bytes += stats.bytes;
}

// ---- formatting -----------------------------------------------------------------------------------

function fmtMs(ms) {
  return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s';
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function fmtPct(fraction) {
  const p = fraction * 100;
  return p < 0.000001 ? '< 0.000001%' : p.toPrecision(2) + '%';
}

function setText(id, text) {
  const node = $(id);
  if (node && node.textContent !== text) node.textContent = text;
}

// ---- worker pool ----------------------------------------------------------------------------------

const slots = [];

function setDot(slot, state, title) {
  slot.dot.className = 'dot ' + state;
  slot.dot.title = 'worker ' + (slot.index + 1) + ': ' + (title || state);
}

function startPool() {
  for (let i = 0; i < POOL_SIZE; i++) {
    const dot = document.createElement('span');
    el.pool.appendChild(dot);
    const worker = new Worker('worker.js');
    const slot = { index: i, worker, dot, ready: false, failed: false, busy: false, row: null };
    setDot(slot, 'connecting');
    wlDebug.attachWorker(worker, 'w' + (i + 1));
    worker.onmessage = (ev) => onWorkerMessage(slot, ev.data);
    worker.onerror = (e) => onWorkerError(slot, e);
    slots.push(slot);
    worker.postMessage({ type: 'open', ds: DATASET });
  }
  const label = document.createElement('span');
  label.textContent = 'workers';
  el.pool.appendChild(label);
  updateStatus();
}

function onWorkerMessage(slot, m) {
  if (m.type === 'abort') return;  // logged by wlDebug; the reply that follows is the one that counts
  if (m.type === 'open') {
    addTotals(m.stats);
    openSettled++;
    if (m.ok) {
      wlDebug.log('open', { w: slot.index + 1, ms: r1(m.ms), req: m.stats.requests, bytes: m.stats.bytes,
        heapBytes: m.heap, jsMB: wlDebug.mem(), wasmBytes: m.module && m.module.transfer,
        wasmDecodedBytes: m.module && m.module.decoded });
      slot.ready = true;
      setDot(slot, 'ready', 'dataset open');
      if (firstOpenMs === null) firstOpenMs = performance.now() - pageStart;
    } else {
      slot.failed = true;
      setDot(slot, 'error', m.error);
      if (!firstError) firstError = m.error;
    }
    if (openSettled === POOL_SIZE) allSettledMs = performance.now() - pageStart;
    updateStatus();
    dispatch();
    updateStats();
    return;
  }
  // A row reply: the worker is free again.
  slot.busy = false;
  slot.row = null;
  addTotals(m.stats);
  m.w = slot.index + 1;
  if (click && m.id === click.id) takeRowResult(m);
  dispatch();
  updateStats();
}

function onWorkerError(slot, e) {
  const message = (e && e.message) || 'worker error';
  if (!slot.ready) {
    slot.failed = true;
    openSettled++;
    setDot(slot, 'error', message);
    if (!firstError) firstError = message;
    if (openSettled === POOL_SIZE) allSettledMs = performance.now() - pageStart;
    updateStatus();
  } else {
    setDot(slot, 'error', message);
  }
  if (slot.busy && click && slot.row !== null && click.cards.has(slot.row)) {
    slot.busy = false;
    onWorkerMessage(slot, { type: 'row', id: click.id, row: slot.row, ok: false, error: message, stats: null, ms: 0 });
  }
}

// Hands pending rows of the current click to idle, open workers, one row at a time per worker.
function dispatch() {
  if (!click) return;
  for (const slot of slots) {
    if (click.pending.length === 0) break;
    if (slot.ready && !slot.busy) {
      const row = click.pending.shift();
      slot.busy = true;
      slot.row = row;
      slot.worker.postMessage({ type: 'row', id: click.id, row });
    }
  }
}

function updateStatus() {
  const ready = slots.filter((s) => s.ready).length;
  const pending = openSettled < POOL_SIZE;
  if (ready === 0 && pending) {
    el.status.textContent = 'Connecting: opening the dataset in ' + POOL_SIZE + ' workers...';
  } else if (ready === 0) {
    el.status.textContent = 'The dataset could not be opened: ' + firstError;
  } else {
    el.status.textContent =
      ready + ' of ' + POOL_SIZE + ' workers have the dataset open' + (pending ? ' (the others are still connecting)' : '') + '.';
  }
}

// ---- gallery --------------------------------------------------------------------------------------

function clearGallery() {
  for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
  el.gallery.textContent = '';
}

function makeCard(row) {
  const node = document.createElement('figure');
  node.className = 'card';
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const img = document.createElement('img');
  img.alt = '';
  const wait = document.createElement('span');
  wait.className = 'wait';
  wait.textContent = 'Fetching row ' + row.toLocaleString('en-US') + ' from the dataset...';
  thumb.append(img, wait);
  const cap = document.createElement('figcaption');
  const rowNo = document.createElement('span');
  rowNo.className = 'rowno';
  rowNo.textContent = 'row ' + row.toLocaleString('en-US');
  const text = document.createElement('span');
  cap.append(rowNo, text);
  node.append(thumb, cap);
  return { node, img, wait, text, row };
}

function failCard(card, message) {
  card.node.classList.add('failed');
  card.wait.textContent = 'Failed: ' + message;
  card.text.textContent = '(no caption)';
}

// One line per image row of the click: worker, time, requests, bytes, image size, decode time.
function logRow(m, extra) {
  const s = m.stats || { requests: 0, bytes: 0 };
  wlDebug.log('click.image', Object.assign({ w: m.w, row: m.row, ms: r1(m.ms), req: s.requests, bytes: s.bytes,
    imageBytes: m.image ? m.image.byteLength : undefined, heapBytes: m.heap, jsMB: wlDebug.mem() }, extra));
}

function takeRowResult(m) {
  const c = click;
  const card = c.cards.get(m.row);
  const t = performance.now() - c.t0;
  c.done++;
  if (c.firstMs === null) c.firstMs = t;
  c.lastMs = t;
  if (m.stats) {
    c.requests += m.stats.requests;
    c.bytes += m.stats.bytes;
  }
  if (m.heap) c.heapBytes = m.heap;
  perImage.sum += m.ms;
  perImage.count++;
  if (c.done === c.rows.length) {
    wlDebug.log('click.done', { ms: r1(t), firstMs: r1(c.firstMs), req: c.requests, bytes: c.bytes,
      heapBytes: c.heapBytes, jsMB: wlDebug.mem() });
  }
  if (!card) return;
  if (!m.ok) {
    failCard(card, m.error);
    logRow(m, { ok: false, error: m.error });
    return;
  }
  card.text.textContent = m.caption === null || m.caption === '' ? '(no caption)' : m.caption;
  const url = URL.createObjectURL(new Blob([m.image], { type: m.imageType }));
  objectUrls.push(url);
  const decodeStart = performance.now();
  card.img.onload = () => {
    card.node.classList.add('loaded');
    card.wait.remove();
    logRow(m, { ok: true, decodeMs: r1(performance.now() - decodeStart) });
  };
  card.img.onerror = () => {
    failCard(card, 'the image did not decode');
    logRow(m, { ok: false, error: 'the image did not decode' });
  };
  card.img.src = url;
}

// ---- click ----------------------------------------------------------------------------------------

function startClick(rows) {
  const id = ++clickSeq;
  clearGallery();
  const cards = new Map();
  for (const row of rows) {
    const card = makeCard(row);
    cards.set(row, card);
    el.gallery.appendChild(card.node);
  }
  click = {
    id, t0: performance.now(), rows, pending: rows.slice(), done: 0, cards,
    firstMs: null, lastMs: null, requests: 0, bytes: 0, heapBytes: 0,
  };
  wlDebug.log('click', { rows: rows.join(' '), n: rows.length });
  selected = rows;
  scheduleDraw();
  dispatch();
  updateStats();
}

function updateStats() {
  setText('s-open-first', firstOpenMs === null ? '...' : fmtMs(firstOpenMs));
  setText('s-open-all', allSettledMs === null ? '...' : fmtMs(allSettledMs));
  setText('s-requests', totals.requests.toLocaleString('en-US'));
  setText('s-bytes', fmtBytes(totals.bytes));
  setText('s-fraction', DATA_BYTES ? fmtPct(totals.bytes / DATA_BYTES) : 'n/a');
  setText('s-click-requests', click ? click.requests.toLocaleString('en-US') : '-');
  setText('s-click-bytes', click ? fmtBytes(click.bytes) : '-');
  setText('s-click-first', click && click.firstMs !== null ? fmtMs(click.firstMs) : '-');
  const lastDone = click && click.done === click.rows.length;
  setText('s-click-last', lastDone ? fmtMs(click.lastMs) : click ? 'waiting...' : '-');
  setText('s-per-image', perImage.count ? fmtMs(perImage.sum / perImage.count) : '-');
}

// ---- map ------------------------------------------------------------------------------------------

let pts = null; // Uint16Array: x,y per point; point i is dataset row i
let npts = 0;
let labels = [];
let members = []; // members[r]: point indexes whose nearest region is r
let selected = [];
let hover = -1;
let cssW = 0;
let cssH = 0;
let dpr = 1;
let drawQueued = false;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function isDark() {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function palette(dark) {
  return labels.map((_, r) => {
    const hue = (r * 137.508) % 360; // golden-angle steps keep neighbouring regions apart
    return 'hsl(' + hue.toFixed(1) + ' ' + (dark ? 72 : 60) + '% ' + (dark ? 66 : 44) + '%)';
  });
}

function assignRegions() {
  members = labels.map(() => []);
  for (let i = 0; i < npts; i++) {
    const x = pts[2 * i] / 65535;
    const y = pts[2 * i + 1] / 65535;
    let best = 0;
    let bestD = Infinity;
    for (let r = 0; r < labels.length; r++) {
      const dx = x - labels[r].x;
      const dy = y - labels[r].y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    members[best].push(i);
  }
}

function sizeCanvas() {
  if (!pts) return;
  dpr = window.devicePixelRatio || 1;
  cssW = Math.max(200, Math.min(el.wrap.clientWidth, 720));
  cssH = cssW;
  el.canvas.style.width = cssW + 'px';
  el.canvas.style.height = cssH + 'px';
  el.canvas.width = Math.round(cssW * dpr);
  el.canvas.height = Math.round(cssH * dpr);
  base.width = el.canvas.width;
  base.height = el.canvas.height;
  drawBase();
  scheduleDraw();
}

function drawBase() {
  const g = base.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bg = cssVar('--map-bg');
  g.fillStyle = bg;
  g.fillRect(0, 0, cssW, cssH);
  const pal = palette(isDark());
  const dot = Math.max(1.5, cssW / 300);
  g.globalAlpha = 0.9;
  for (let r = 0; r < members.length; r++) {
    g.fillStyle = pal[r];
    for (const i of members[r]) {
      g.fillRect((pts[2 * i] / 65535) * cssW - dot / 2, (pts[2 * i + 1] / 65535) * cssH - dot / 2, dot, dot);
    }
  }
  g.globalAlpha = 1;
  g.font = '600 13px ' + FONT;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 4;
  g.strokeStyle = bg;
  const ink = cssVar('--map-label');
  // Largest regions first; a label that would overlap one already drawn is skipped, so crowded
  // parts of the map stay readable (all names return as the map gets wider).
  const placed = [];
  for (const lab of [...labels].sort((a, b) => b.n - a.n)) {
    // Keep each label inside the map, so a label near an edge is not cut off.
    const half = g.measureText(lab.label).width / 2 + 4;
    const x = Math.min(Math.max(lab.x * cssW, half), cssW - half);
    const y = Math.min(Math.max(lab.y * cssH, 10), cssH - 10);
    const box = [x - half, y - 9, x + half, y + 9];
    if (placed.some((b) => box[0] < b[2] && b[0] < box[2] && box[1] < b[3] && b[1] < box[3])) {
      continue;
    }
    placed.push(box);
    g.strokeText(lab.label, x, y);
    g.fillStyle = ink;
    g.fillText(lab.label, x, y);
  }
}

function scheduleDraw() {
  if (!drawQueued) {
    drawQueued = true;
    requestAnimationFrame(draw);
  }
}

function draw() {
  drawQueued = false;
  if (!pts) return;
  const ctx = canvasCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  ctx.drawImage(base, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineWidth = 2;
  ctx.strokeStyle = cssVar('--accent');
  for (const i of selected) {
    ctx.beginPath();
    ctx.arc((pts[2 * i] / 65535) * cssW, (pts[2 * i + 1] / 65535) * cssH, 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (hover >= 0) {
    ctx.strokeStyle = cssVar('--fg');
    ctx.beginPath();
    ctx.arc((pts[2 * hover] / 65535) * cssW, (pts[2 * hover + 1] / 65535) * cssH, 10, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function localXY(ev) {
  const r = el.canvas.getBoundingClientRect();
  return [ev.clientX - r.left, ev.clientY - r.top];
}

// Index of the point nearest to (x, y) in CSS pixels, or -1 when none is within maxPx.
function nearestPoint(x, y, maxPx) {
  let best = -1;
  let bestD = maxPx * maxPx;
  for (let i = 0; i < npts; i++) {
    const dx = (pts[2 * i] / 65535) * cssW - x;
    const dy = (pts[2 * i + 1] / 65535) * cssH - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// The k points nearest to (x, y) in CSS pixels, nearest first.
function kNearest(x, y, k) {
  const ds = new Float64Array(k).fill(Infinity);
  const ix = new Int32Array(k).fill(-1);
  for (let i = 0; i < npts; i++) {
    const dx = (pts[2 * i] / 65535) * cssW - x;
    const dy = (pts[2 * i + 1] / 65535) * cssH - y;
    const d = dx * dx + dy * dy;
    if (d < ds[k - 1]) {
      let j = k - 1;
      while (j > 0 && ds[j - 1] > d) {
        ds[j] = ds[j - 1];
        ix[j] = ix[j - 1];
        j--;
      }
      ds[j] = d;
      ix[j] = i;
    }
  }
  return Array.from(ix);
}

async function loadMap() {
  const endMap = wlDebug.span('map.load', { url: POINTS_URL });
  try {
    const [pbuf, labelsJson] = await Promise.all([
      fetch(POINTS_URL).then((r) => {
        if (!r.ok) throw new Error(POINTS_URL + ' returned ' + r.status);
        return r.arrayBuffer();
      }),
      fetch(LABELS_URL).then((r) => {
        if (!r.ok) throw new Error(LABELS_URL + ' returned ' + r.status);
        return r.json();
      }),
    ]);
    pts = new Uint16Array(pbuf);
    npts = pts.length / 2;
    labels = labelsJson;
    assignRegions();
    sizeCanvas();
    el.hint.textContent =
      'Each dot is one of the ' + npts.toLocaleString('en-US') + ' map points, colored by its nearest region. ' +
      'Click the map to load the ' + NEIGHBOURS + ' nearest images, with their captions, from the dataset.';
    endMap({ points: npts });
  } catch (e) {
    endMap({ error: e.message });
    el.hint.textContent = 'The map did not load: ' + e.message;
  }
}

function setupMapEvents() {
  el.canvas.addEventListener('click', (ev) => {
    if (!pts) return;
    const [x, y] = localXY(ev);
    startClick(kNearest(x, y, NEIGHBOURS));
  });
  el.canvas.addEventListener('pointermove', (ev) => {
    if (!pts || ev.pointerType === 'touch') return;
    const [x, y] = localXY(ev);
    const h = nearestPoint(x, y, 12);
    if (h !== hover) {
      hover = h;
      scheduleDraw();
    }
  });
  el.canvas.addEventListener('pointerleave', () => {
    hover = -1;
    scheduleDraw();
  });
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sizeCanvas, 120);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (pts) {
      drawBase();
      scheduleDraw();
    }
  });
}

// ---- start ----------------------------------------------------------------------------------------

setupMapEvents();
updateStats();
startPool();
loadMap();
