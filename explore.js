// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// The explore page: a Hugging Face dataset URL (or a preset) -> its Lance table (found with the tree
// API) -> the columns the page can show (an image, a vector, a class label or captions) -> up to 5,000
// sampled rows read by one worker (explore-worker.js), laid out with PCA -> a canvas map. A click
// fetches the images of the 12 nearest sampled points through a small pool of workers.
// Test-only override: ?table_url=<full URL of a .lance directory> skips the Hugging Face discovery.

const PRESETS = [
  { label: 'MNIST', ds: 'https://huggingface.co/datasets/lance-format/mnist-lance' },
  { label: 'CIFAR-10', ds: 'https://huggingface.co/datasets/lance-format/cifar10-lance' },
  { label: 'Oxford Pets', ds: 'https://huggingface.co/datasets/lance-format/oxford-pets-lance' },
  { label: 'Food-101', ds: 'https://huggingface.co/datasets/lance-format/food101-lance' },
  { label: 'COCO (SigLIP2)', ds: 'https://huggingface.co/datasets/jrmiller/coco-2017-siglip2-embeddings' },
];
const SAMPLE_ROWS = 5000;
const WINDOW = 500;
const WINDOWS = 10;
const POOL_SIZE = 4;
const NEIGHBOURS = 12;
const GRID_IMAGES = 24;
const MAX_LABEL_VALUES = 200;
const CAT = ['#2456c7', '#d1495b', '#00897b', '#edae49', '#7b4fc4', '#2e9e4f', '#e4572e', '#3a8fb7',
  '#b5838d', '#6d6875', '#c77dff', '#9c6644', '#4cc9f0', '#f4a261', '#2a9d8f', '#e76f51', '#8ab17d',
  '#ffb703', '#577590', '#bc4749'];
// The stop list of tools/make_map.py.
const STOP = new Set(`a an the of on in with and is are to at for two three his her its by from near some next
while one this that it out up down there their sitting standing has have very other into over front top side
small large big white black red blue green young man men woman women people person group`.split(/\s+/));
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const $ = (id) => document.getElementById(id);
const el = {
  form: $('open-form'), input: $('ds-input'), open: $('open-button'), presets: $('presets'),
  tables: $('tables'), select: $('table-select'), columns: $('columns'), message: $('message'),
  status: $('status'), canvas: $('map'), wrap: $('map-wrap'), hint: $('hint'), gallery: $('gallery'),
};
const ctx = el.canvas.getContext('2d');
const base = document.createElement('canvas');
const params = new URLSearchParams(location.search);

let pool = [];          // worker slots; slot 0 also samples
let tableUrl = '';
let info = null;
let cols = null;        // {image, vector, label, labelKind, caption}
let sample = null;      // {rows, x, y, cluster, centers, labels, captions, groups, groupOf, groupLabels, kept}
let loadSeq = 0;        // a newer open cancels the older one's results
let clickSeq = 0;
let objectUrls = [];
let imageWait = null;   // the image probe while it runs: a click made before it settles waits for it
let cssW = 0, cssH = 0, dpr = 1;
let selected = [];
let treeRequests = 0;   // Hugging Face tree API requests, for the debug log
const totals = { requests: 0, bytes: 0 };   // every request since the table was opened
const sampleTotals = { requests: 0, bytes: 0 };  // the sample's windows

const r1 = (x) => Math.round(x * 10) / 10;

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function setText(id, text) {
  const node = $(id);
  if (node) node.textContent = text;
}

function setStatus(text) {
  el.status.textContent = text;
}

function showMessage(text) {
  el.message.textContent = text || '';
  el.message.hidden = !text;
}

// Adds a worker's counters to the page totals and to the bucket of the request they answer.
function addTotals(stats, bucket) {
  if (!stats) return;
  totals.requests += stats.requests;
  totals.bytes += stats.bytes;
  if (bucket) {
    bucket.requests += stats.requests;
    bucket.bytes += stats.bytes;
  }
  setText('s-requests', totals.requests.toLocaleString('en-US'));
  setText('s-bytes', fmtBytes(totals.bytes));
}

// ---------------------------------------------------------------------------------------------------
// Workers: one request at a time per worker, answered in order (progress messages aside).
// ---------------------------------------------------------------------------------------------------

function makeSlot(index) {
  const worker = new Worker('explore-worker.js');
  const slot = { index, worker, queue: [], opening: null };
  wlDebug.attachWorker(worker, 'w' + (index + 1));
  worker.onmessage = (ev) => onWorkerMessage(slot, ev.data);
  worker.onerror = (e) => {
    const failed = slot.queue.splice(0);
    for (const q of failed) q.reject(new Error('worker: ' + (e.message || 'failed')));
  };
  return slot;
}

// bucket: an object that collects this request's counters (or null). transfer: buffers to move, not copy.
function request(slot, msg, { bucket = null, transfer = [] } = {}) {
  return new Promise((resolve, reject) => {
    slot.queue.push({ resolve, reject, bucket });
    slot.worker.postMessage(msg, transfer);
  });
}

function onWorkerMessage(slot, m) {
  if (m.type === 'abort') return;  // logged by wlDebug; the reply that follows is the one that counts
  const q = slot.queue.shift();
  if (!q) return;
  addTotals(m.stats, q.bucket);
  if (m.ok) q.resolve(m);
  else q.reject(new Error(m.error || 'worker error'));
}

function resetPool() {
  for (const s of pool) s.worker.terminate();
  pool = [];
  for (let i = 0; i < POOL_SIZE; i++) pool.push(makeSlot(i));
}

// Each worker opens the table once. openTable opens all of them at once; the requests queue behind the open.
function ensureOpen(slot) {
  if (!slot.opening) {
    // debug_fail is a test-only hook: the worker's open fails (see explore-worker.js).
    slot.opening = request(slot, { type: 'open', ds: tableUrl, fail: params.get('debug_fail') || undefined }).then((m) => {
      // Safari reports the module's sizes as 0: then they are absent from the log, not 0 B.
      const sized = m.module && (m.module.transfer || m.module.decoded);
      wlDebug.log('open', { w: slot.index + 1, ms: r1(m.ms), req: m.stats.requests, bytes: m.stats.bytes,
        heapBytes: m.heap, jsMB: wlDebug.mem(), wasmBytes: sized ? m.module.transfer : undefined,
        wasmDecodedBytes: sized ? m.module.decoded : undefined });
      return m;
    });
  }
  return slot.opening;
}

// ---------------------------------------------------------------------------------------------------
// Input, presets and Hugging Face discovery
// ---------------------------------------------------------------------------------------------------

function parseInput(text) {
  const t = text.trim();
  const m = /^https:\/\/huggingface\.co\/datasets\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:\/(?:tree|resolve)\/main\/?([^?#]*))?\/?(?:[?#].*)?$/.exec(t);
  if (!m) throw new Error('Paste a Hugging Face dataset URL: https://huggingface.co/datasets/<owner>/<name>');
  return { owner: m[1], name: m[2], path: (m[3] || '').replace(/\/+$/, '') };
}

async function listTree(owner, name, dir) {
  const encoded = dir ? '/' + dir.split('/').map(encodeURIComponent).join('/') : '';
  const url = `https://huggingface.co/api/datasets/${owner}/${name}/tree/main${encoded}`;
  let r;
  try {
    treeRequests++;
    r = await fetch(url);
  } catch (e) {
    treeRequests++;
    r = await fetch(url);  // one retry: a single network failure should not end the visit
  }
  if (!r.ok) throw new Error(`Hugging Face tree API answered ${r.status} for ${dir || 'the top level'}`);
  return r.json();
}

// The .lance directories at the given path and one level down, sorted.
async function findTables(owner, name, path) {
  if (path.endsWith('.lance')) return [path];
  const top = await listTree(owner, name, path);
  const found = top.filter((e) => e.type === 'directory' && e.path.endsWith('.lance')).map((e) => e.path);
  const dirs = top.filter((e) => e.type === 'directory' && !e.path.endsWith('.lance'));
  for (const d of dirs) {
    const sub = await listTree(owner, name, d.path);
    for (const e of sub) if (e.type === 'directory' && e.path.endsWith('.lance')) found.push(e.path);
  }
  return found.sort();
}

function tableUrlFor(owner, name, path) {
  return `https://huggingface.co/datasets/${owner}/${name}/resolve/main/${path}`;
}

function setQuery(ds, table) {
  const q = new URLSearchParams();
  if (ds) q.set('ds', ds);
  if (table) q.set('table', table);
  history.replaceState(null, '', '?' + q.toString());
}

// ---------------------------------------------------------------------------------------------------
// Columns: the image, the vector, the class label (or the caption) of the table
// ---------------------------------------------------------------------------------------------------

function pickColumns(fields) {
  const vectors = fields
    .map((f) => ({ f, m: /^fixed_size_list<(float32|float64|float16)>\[(\d+)\]$/.exec(f.type) }))
    .filter((x) => x.m && Number(x.m[2]) >= 8)
    .sort((a, b) => Number(/emb|vector/i.test(b.f.name)) - Number(/emb|vector/i.test(a.f.name)));
  const imagePref = ['image', 'image_bytes', 'img'];
  const images = fields
    .filter((f) => /^(large_)?binary$/.test(f.type))
    .sort((a, b) => rank(imagePref, a.name) - rank(imagePref, b.name))
    .map((f) => f.name);
  const strings = fields.filter((f) => /^(large_)?string$/.test(f.type)).map((f) => f.name);
  const ints = fields.filter((f) => /^u?int\d+$/.test(f.type)).map((f) => f.name);
  let label = null;
  for (const n of ['label_name', 'label', 'class', 'category']) {
    if (strings.includes(n)) { label = { name: n, kind: 'str' }; break; }
  }
  if (!label) {
    for (const n of ['label', 'class']) {
      if (ints.includes(n)) { label = { name: n, kind: 'int' }; break; }
    }
  }
  const caption = strings.includes('caption') ? 'caption' : null;
  return {
    vector: vectors.length ? { name: vectors[0].f.name, type: vectors[0].f.type, dim: Number(vectors[0].m[2]) } : null,
    imageCandidates: images,
    image: null,
    label,
    caption: label ? null : caption,
  };
}

function rank(list, name) {
  const i = list.indexOf(name);
  return i < 0 ? list.length : i;
}

// The image format from its magic bytes, or null.
function sniffImage(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

// The first binary column whose value at the middle row is an image.
async function probeImage(slot, rows, candidates, seq, bucket) {
  for (const col of candidates) {
    const m = await request(slot, { type: 'image', row: Math.floor(rows / 2), col }, { bucket });
    if (seq !== loadSeq) return null;
    if (sniffImage(new Uint8Array(m.image))) return col;
  }
  return null;
}

// Rows [start, start+len) for the sample: ten spread windows (each window costs ~16 requests, so few large ones), or every row when the table is small.
function windowPlan(n) {
  const windows = [];
  if (n <= SAMPLE_ROWS) {
    for (let s = 0; s < n; s += WINDOW) windows.push([s, Math.min(WINDOW, n - s)]);
  } else {
    for (let k = 0; k < WINDOWS; k++) windows.push([Math.round((k * (n - WINDOW)) / (WINDOWS - 1)), WINDOW]);
  }
  return windows;
}

// ---------------------------------------------------------------------------------------------------
// Opening a table
// ---------------------------------------------------------------------------------------------------

async function openTable(url, seq) {
  tableUrl = url;
  resetPool();
  sample = null;
  info = null;
  imageWait = null;
  selected = [];
  clearGallery();
  setText('s-rows', '-');
  setText('s-sample-requests', '-');
  setText('s-sample-bytes', '-');
  sampleTotals.requests = 0;
  sampleTotals.bytes = 0;
  el.hint.textContent = 'Reading the table...';
  setStatus('Opening ' + url.replace('https://huggingface.co/datasets/', '').replace('/resolve/main/', ' / ') + '...');
  // Every worker opens the table at once.
  const opened = await Promise.all(pool.map((slot) => ensureOpen(slot)));
  if (seq !== loadSeq) return;
  info = opened[0].info;
  cols = pickColumns(info.fields);
  if (!cols.vector) {
    // Nothing to sample: the first images of the table, after the image probe.
    setStatus('Checking which binary column holds images...');
    cols.image = await probeOn(pool[0], seq);
    if (seq !== loadSeq) return;
    showColumns();
    if (!cols.image) throw new Error('This table has neither an image column nor a vector column.');
    await gridOfImages(seq);
    setStatus(`${info.rows.toLocaleString('en-US')} rows. This table has no vector column, so the page shows its first images.`);
    return;
  }
  // The map needs no image column, only the clicks do: the probe runs on the last worker while the
  // sample runs on all of them.
  const probe = probeOn(pool[POOL_SIZE - 1], seq).then((col) => {
    if (seq !== loadSeq) return;
    cols.image = col;
    imageWait = null;
    showColumns();
    if (!cols.image) showMessage('No binary column holds JPEG, PNG, GIF or WebP images: the map shows no images.');
  }, (e) => {
    // The map does not need the image column: a failed probe costs the images, not the map.
    if (seq !== loadSeq) return;
    cols.image = null;
    imageWait = null;
    wlDebug.log('probe.failed', { error: e && e.message ? e.message : String(e) });
    showMessage('Could not check which column holds images (' + (e && e.message ? e.message : e) + '): the map shows no images.');
  });
  imageWait = probe;
  await sampleAndMap(seq, probe);
}

// The first binary column that holds images, probed on one worker. Logged as a probe span.
function probeOn(slot, seq) {
  const end = wlDebug.span('probe', { w: slot.index + 1 });
  const bucket = { requests: 0, bytes: 0 };
  return probeImage(slot, info.rows, cols.imageCandidates, seq, bucket).then((col) => {
    end({ req: bucket.requests, bytes: bucket.bytes, image: col || 'none' });
    return col;
  });
}

function showColumns() {
  const parts = [];
  if (cols.image) parts.push(`<b>image</b> = ${cols.image}`);
  if (cols.vector) parts.push(`<b>vector</b> = ${cols.vector.name} (${cols.vector.dim}-d)`);
  if (cols.label) parts.push(`<b>class</b> = ${cols.label.name}`);
  else if (cols.caption) parts.push(`<b>caption</b> = ${cols.caption} (regions named by their words)`);
  else parts.push('no class column');
  el.columns.innerHTML = `${info.rows.toLocaleString('en-US')} rows. Columns used: ${parts.join(', ')}.`;
  wlDebug.log('columns', { rows: info.rows, image: cols.image, vector: cols.vector && cols.vector.name,
    dim: cols.vector && cols.vector.dim, label: cols.label && cols.label.name, caption: cols.caption });
}

// The sample: every worker reads the next free window (the windows come back in window order), then one
// worker lays the vectors out. The last worker joins once the image probe has settled.
async function sampleAndMap(seq, probe) {
  const n = info.rows;
  const windows = windowPlan(n);
  const total = windows.reduce((a, w) => a + w[1], 0);
  el.hint.textContent = 'Reading ' + total.toLocaleString('en-US') + ' sampled rows...';
  const label = cols.label ? cols.label.name : null;
  const caption = cols.caption;
  const endSample = wlDebug.span('sample.total', { windows: windows.length, rows: total });
  const parts = new Array(windows.length);
  let next = 0;
  let done = 0;
  setStatus(`Reading rows: 0 of ${total.toLocaleString('en-US')}...`);
  const lane = async (slot, gate) => {
    if (gate) await gate;
    while (next < windows.length && seq === loadSeq) {
      const k = next++;
      const [start, len] = windows[k];
      const m = await request(slot, { type: 'window', id: k, start, len, vec: cols.vector.name, label, caption },
        { bucket: sampleTotals });
      if (seq !== loadSeq) return;
      parts[k] = m;
      done += len;
      wlDebug.log('sample.window', { w: slot.index + 1, start, rows: len, ms: r1(m.ms), req: m.stats.requests, bytes: m.stats.bytes });
      setText('s-sample-requests', sampleTotals.requests.toLocaleString('en-US'));
      setText('s-sample-bytes', fmtBytes(sampleTotals.bytes));
      setStatus(`Reading rows: ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}; ` +
        `${fmtBytes(sampleTotals.bytes)} fetched in ${sampleTotals.requests.toLocaleString('en-US')} requests.`);
    }
  };
  const lanes = pool.map((slot, i) => lane(slot, i === POOL_SIZE - 1 ? probe : null));
  await Promise.all(lanes).catch((e) => {
    next = windows.length;  // the other workers stop taking windows
    throw e;
  });
  if (seq !== loadSeq) return;
  endSample({ rows: total, req: sampleTotals.requests, bytes: sampleTotals.bytes, jsMB: wlDebug.mem() });
  // The windows in window order: one flat vector array, and their rows, labels and captions.
  const dim = parts[0].dim;
  let count = 0;
  for (const p of parts) count += p.rows.length;
  const rows = new Int32Array(count);
  const vecs = new Float32Array(count * dim);
  const labels = label ? [] : null;
  const captions = caption ? [] : null;
  let at = 0;
  for (const p of parts) {
    rows.set(p.rows, at);
    vecs.set(p.values, at * dim);
    if (labels) for (const v of p.labels) labels.push(v);
    if (captions) for (const v of p.captions) captions.push(v);
    at += p.rows.length;
  }
  const endLayout = wlDebug.span('layout', { rows: count });
  const r = await request(pool[0], { type: 'layout', id: windows.length, rows, vecs, dim, label, caption, labels, captions,
    requested: total }, { transfer: [rows.buffer, vecs.buffer] });
  if (seq !== loadSeq) return;
  endLayout({ kept: r.kept });
  sample = layoutSample(r, n);
  wlDebug.log('heap', { w: 1, heapBytes: r.heap, jsMB: wlDebug.mem() });
  wlDebug.log('pca', { ms: r1(r.pcaMs), dim: r.dim, kept: r.kept });
  wlDebug.log('kmeans', { ms: r1(r.kmeansMs), k: r.centers.length });
  setText('s-rows', sample.rows.length.toLocaleString('en-US'));
  setText('s-sample-requests', sampleTotals.requests.toLocaleString('en-US'));
  setText('s-sample-bytes', fmtBytes(sampleTotals.bytes));
  describeGroups();
  const endDraw = wlDebug.span('map.draw', { points: sample.kept });
  sizeCanvas();
  endDraw();
  wlDebug.log('classes', { n: new Set(sample.labels).size, byClass: sample.byClass, groups: sample.groupLabels.length });
  setStatus(`Sampled ${sample.rows.length.toLocaleString('en-US')} rows of ${n.toLocaleString('en-US')} ` +
    `in ${sampleTotals.requests.toLocaleString('en-US')} requests (${fmtBytes(sampleTotals.bytes)}). Click the map.`);
  // The page says what it found only once the image probe has settled.
  await probe;
  if (seq !== loadSeq) return;
  if (!cols.image) el.hint.textContent += ' This table has no image column.';
  // For the browser tests: what the page decided and what it drew.
  window.__explore = {
    table: tableUrl, rows: info.rows, columns: { vector: cols.vector, image: cols.image, label: cols.label, caption: cols.caption },
    sampled: sample.rows.length, requested: r.requested, dim: r.dim, byClass: sample.byClass,
    distinct: new Set(sample.labels).size, groupLabels: sample.groupLabels.map((g) => g.label),
    labels: sample.labels, sampleRows: Array.from(sample.rows), x: Array.from(sample.x), y: Array.from(sample.y),
    sampleRequests: sampleTotals.requests, sampleBytes: sampleTotals.bytes, totalRequests: totals.requests,
    totalBytes: totals.bytes,
  };
  document.body.dataset.sampled = '1';
}

// Groups the sample: by class when the label has at most MAX_LABEL_VALUES values, else k-means regions.
function layoutSample(r, n) {
  const kept = r.rows.length;
  let groupOf = Uint16Array.from(r.cluster);
  let groups = [];
  let groupLabels = [];
  const byClass = cols.label && r.labels.length && new Set(r.labels).size <= MAX_LABEL_VALUES;
  if (byClass) {
    const counts = new Map();
    for (const v of r.labels) counts.set(v, (counts.get(v) || 0) + 1);
    groups = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || String(a).localeCompare(String(b)));
    const index = new Map(groups.map((v, i) => [v, i]));
    groupOf = Uint16Array.from(r.labels, (v) => index.get(v));
    groupLabels = groups.map((v, i) => {
      const pts = [];
      for (let k = 0; k < kept; k++) if (groupOf[k] === i) pts.push(k);
      return { label: cols.label.kind === 'int' ? 'class ' + v : String(v).replace(/_/g, ' '), n: pts.length, ...medianOf(r.x, r.y, pts) };
    });
  } else {
    groups = r.centers.map((_, c) => c);
    groupLabels = regionNames(r, groupOf, n);
  }
  return { rows: r.rows, x: r.x, y: r.y, labels: r.labels, captions: r.captions, groups, groupOf, groupLabels,
    kept, dim: r.dim, byClass: !!byClass };
}

function medianOf(x, y, idx) {
  if (!idx.length) return { x: 0.5, y: 0.5 };
  const med = (arr) => {
    const v = Array.from(arr).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  return { x: med(idx.map((k) => x[k])), y: med(idx.map((k) => y[k])) };
}

// The two most distinctive caption words of each region: frequency in the region times
// log(N / captions containing the word), as tools/make_map.py scores them.
function regionNames(r, groupOf, n) {
  const captions = r.captions;
  const haveCaptions = captions.length && captions[0] !== null;
  const count = r.centers.length;
  if (!haveCaptions) {
    return r.centers.map((c, k) => ({ label: '', n: 0, x: c[0], y: c[1] }));
  }
  const words = (s) => {
    const m = String(s || '').toLowerCase().match(/[a-z]+/g) || [];
    return [...new Set(m.filter((w) => w.length > 2 && !STOP.has(w)))];
  };
  const everywhere = new Map();
  for (const s of captions) for (const w of words(s)) everywhere.set(w, (everywhere.get(w) || 0) + 1);
  const total = captions.length;
  const out = [];
  for (let k = 0; k < count; k++) {
    const members = [];
    for (let i = 0; i < captions.length; i++) if (groupOf[i] === k) members.push(i);
    const here = new Map();
    for (const i of members) for (const w of words(captions[i])) here.set(w, (here.get(w) || 0) + 1);
    const score = [];
    for (const [w, c] of here) {
      if (c >= 5) score.push([w, (c / members.length) * Math.log(total / everywhere.get(w))]);
    }
    score.sort((a, b) => b[1] - a[1]);
    const top = score.slice(0, 2).map((s) => s[0]);
    out.push({ label: top.join(' / '), n: members.length, x: r.centers[k][0], y: r.centers[k][1] });
  }
  return out.filter((g) => g.label);
}

function describeGroups() {
  if (sample.byClass) {
    el.hint.textContent = `${sample.groups.length} classes in the sample, colored by ${cols.label.name}. Click a point.`;
  } else if (sample.groupLabels.some((g) => g.label)) {
    el.hint.textContent = 'Regions of the layout, named by their captions. Click a point.';
  } else {
    el.hint.textContent = 'Regions of the layout, colored by k-means. Click a point.';
  }
}

// Images only (no vector column): the first rows, in a grid.
async function gridOfImages(seq) {
  el.hint.textContent = 'The first images of the table.';
  const n = Math.min(GRID_IMAGES, info.rows);
  const jobs = [];
  for (let i = 0; i < n; i++) {
    jobs.push(ensureOpenAndSend(pool[i % pool.length], i, null).catch(() => null));
  }
  const results = await Promise.all(jobs);
  if (seq !== loadSeq) return;
  results.forEach((m) => {
    if (m) addCard(m.image, '');
  });
}

// An image of one row, from a worker (opened first if needed); its counters go to the bucket.
function ensureOpenAndSend(slot, row, bucket) {
  return ensureOpen(slot).then(() => request(slot, { type: 'image', row, col: cols.image }, { bucket }));
}

// ---------------------------------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------------------------------

function isDark() {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function sizeCanvas() {
  if (!sample) return;
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
  draw();
}

function colorOf(g) {
  return CAT[g % CAT.length];
}

function drawBase() {
  const g = base.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bg = cssVar('--map-bg');
  g.fillStyle = bg;
  g.fillRect(0, 0, cssW, cssH);
  const dot = Math.max(2, cssW / 240);
  g.globalAlpha = 0.85;
  for (let k = 0; k < sample.kept; k++) {
    g.fillStyle = colorOf(sample.groupOf[k]);
    g.fillRect(sample.x[k] * cssW - dot / 2, sample.y[k] * cssH - dot / 2, dot, dot);
  }
  g.globalAlpha = 1;
  g.font = '600 13px ' + FONT;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 4;
  g.strokeStyle = bg;
  const ink = cssVar('--map-label');
  // Largest groups first; a label that would overlap one already drawn is skipped.
  const placed = [];
  for (const lab of [...sample.groupLabels].filter((l) => l.label).sort((a, b) => b.n - a.n)) {
    const half = g.measureText(lab.label).width / 2 + 4;
    const x = Math.min(Math.max(lab.x * cssW, half), cssW - half);
    const y = Math.min(Math.max(lab.y * cssH, 10), cssH - 10);
    const box = [x - half, y - 9, x + half, y + 9];
    if (placed.some((b) => box[0] < b[2] && b[0] < box[2] && box[1] < b[3] && b[1] < box[3])) continue;
    placed.push(box);
    g.strokeText(lab.label, x, y);
    g.fillStyle = ink;
    g.fillText(lab.label, x, y);
  }
}

function draw() {
  if (!sample) return;
  const c = ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, el.canvas.width, el.canvas.height);
  c.drawImage(base, 0, 0);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.lineWidth = 2;
  c.strokeStyle = cssVar('--accent');
  for (const k of selected) {
    c.beginPath();
    c.arc(sample.x[k] * cssW, sample.y[k] * cssH, 7, 0, Math.PI * 2);
    c.stroke();
  }
}

function localXY(ev) {
  const r = el.canvas.getBoundingClientRect();
  return [ev.clientX - r.left, ev.clientY - r.top];
}

// Indexes of the k sampled points nearest to (px, py), in CSS pixels.
function kNearest(px, py, k) {
  const d = [];
  for (let i = 0; i < sample.kept; i++) {
    const dx = sample.x[i] * cssW - px;
    const dy = sample.y[i] * cssH - py;
    d.push([dx * dx + dy * dy, i]);
  }
  d.sort((a, b) => a[0] - b[0]);
  return d.slice(0, k).map((p) => p[1]);
}

// ---------------------------------------------------------------------------------------------------
// Click: the images of the nearest points
// ---------------------------------------------------------------------------------------------------

function clearGallery() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
  el.gallery.innerHTML = '';
  setText('s-click-requests', '-');
  setText('s-click-bytes', '-');
}

// A grid card for a row of the images-only grid.
function addCard(bytes, label) {
  const type = sniffImage(new Uint8Array(bytes)) || 'application/octet-stream';
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  objectUrls.push(url);
  const node = document.createElement('figure');
  node.className = 'card';
  node.innerHTML = '<div class="thumb"></div><figcaption></figcaption>';
  const img = document.createElement('img');
  img.alt = label;
  img.onload = () => node.classList.add('loaded');  // style.css shows a card's image once it has loaded
  img.src = url;
  node.querySelector('.thumb').appendChild(img);
  node.querySelector('figcaption').textContent = label;
  el.gallery.appendChild(node);
  return node;
}

// One line per image of a click: worker, time, requests, bytes, image size, decode time.
function logClickImage(m, w, row, extra) {
  const s = m.stats || { requests: 0, bytes: 0 };
  wlDebug.log('click.image', Object.assign({ w, row, ms: r1(m.ms), req: s.requests, bytes: s.bytes,
    imageBytes: m.image ? m.image.byteLength : undefined, heapBytes: m.heap, jsMB: wlDebug.mem() }, extra));
}

function startClick(px, py) {
  if (!sample) return;
  if (imageWait) {
    // The image column is not known yet: the click is handled once the probe has settled.
    const seq = loadSeq;
    imageWait.then(() => { if (seq === loadSeq) startClick(px, py); }, () => {});
    return;
  }
  const id = ++clickSeq;
  const idx = kNearest(px, py, NEIGHBOURS);
  selected = idx;
  draw();
  clearGallery();
  if (!cols.image) {
    setStatus('This table has no image column: the map shows where the nearest rows are.');
    return;
  }
  const bucket = { requests: 0, bytes: 0 };
  const shown = () => {
    setText('s-click-requests', bucket.requests.toLocaleString('en-US'));
    setText('s-click-bytes', fmtBytes(bucket.bytes));
  };
  shown();
  const tc = performance.now();
  let lastHeap = 0;
  wlDebug.log('click', { rows: idx.map((k) => sample.rows[k]).join(' '), n: idx.length });
  const pending = idx.map((k, j) => {
    const label = cols.label ? (cols.label.kind === 'int' ? 'class ' + sample.labels[k] : String(sample.labels[k]).replace(/_/g, ' ')) : '';
    const node = document.createElement('figure');
    node.className = 'card';
    node.innerHTML = '<div class="thumb loading"></div><figcaption></figcaption>';
    el.gallery.appendChild(node);
    return ensureOpenAndSend(pool[j % pool.length], sample.rows[k], bucket).then((m) => {
      if (id !== clickSeq) return;
      const type = sniffImage(new Uint8Array(m.image)) || 'application/octet-stream';
      const url = URL.createObjectURL(new Blob([m.image], { type }));
      objectUrls.push(url);
      const thumb = node.querySelector('.thumb');
      thumb.classList.remove('loading');
      const img = document.createElement('img');
      img.alt = label;
      const w = j % pool.length + 1;
      const row = sample.rows[k];
      const decodeStart = performance.now();
      if (m.heap) lastHeap = m.heap;
      img.onload = () => {
        node.classList.add('loaded');  // style.css shows a card's image once it has loaded
        logClickImage(m, w, row, { ok: true, decodeMs: r1(performance.now() - decodeStart) });
      };
      img.onerror = () => logClickImage(m, w, row, { ok: false, error: 'the image did not decode' });
      img.src = url;
      thumb.appendChild(img);
      node.querySelector('figcaption').textContent = label;
      shown();
    }).catch((e) => {
      if (id !== clickSeq) return;
      node.querySelector('.thumb').classList.remove('loading');
      node.querySelector('figcaption').textContent = 'failed: ' + e.message;
      wlDebug.log('click.image', { w: j % pool.length + 1, row: sample.rows[k], ok: false, error: String(e.message) });
    });
  });
  Promise.all(pending).then(() => {
    shown();
    wlDebug.log('click.done', { ms: r1(performance.now() - tc), req: bucket.requests, bytes: bucket.bytes,
      heapBytes: lastHeap, jsMB: wlDebug.mem() });
  });
}

function setupMapEvents() {
  el.canvas.addEventListener('click', (ev) => {
    const [px, py] = localXY(ev);
    startClick(px, py);
  });
  window.addEventListener('resize', () => sizeCanvas());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (sample) { drawBase(); draw(); }
  });
}

// ---------------------------------------------------------------------------------------------------
// Form, presets and the URL
// ---------------------------------------------------------------------------------------------------

async function openFromInput(text) {
  const seq = ++loadSeq;
  showMessage('');
  el.open.disabled = true;
  el.tables.hidden = true;
  el.columns.textContent = '';
  try {
    if (params.get('table_url')) {
      await openTable(params.get('table_url'), seq);
      return;
    }
    const { owner, name, path } = parseInput(text);
    setQuery(`${owner}/${name}`, path);
    setStatus(`Looking for Lance tables in ${owner}/${name}...`);
    wlDebug.log('input', { value: text });
    const endTree = wlDebug.span('tree', { dataset: owner + '/' + name, path });
    const treeBefore = treeRequests;
    const tables = await findTables(owner, name, path);
    endTree({ req: treeRequests - treeBefore, tables: tables.length });
    if (seq !== loadSeq) return;
    if (!tables.length) throw new Error('No .lance directory found at the top level or one level down.');
    fillSelect(owner, name, tables);
    await openTable(tableUrlFor(owner, name, tables[0]), seq);
  } catch (e) {
    if (seq !== loadSeq) return;
    wlDebug.log('error', { msg: String((e && e.message) || e), where: 'open' });
    showMessage(String((e && e.message) || e));
    setStatus('Could not show this dataset.');
  } finally {
    if (seq === loadSeq) el.open.disabled = false;
  }
}

function fillSelect(owner, name, tables) {
  el.select.innerHTML = '';
  for (const t of tables) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    el.select.appendChild(o);
  }
  el.select.onchange = () => {
    const url = tableUrlFor(owner, name, el.select.value);
    setQuery(`${owner}/${name}`, el.select.value);
    openTable(url, ++loadSeq).catch((e) => showMessage(String((e && e.message) || e)));
  };
  el.tables.hidden = tables.length < 2;
}

function buildPresets() {
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.label;
    b.addEventListener('click', () => {
      el.input.value = p.ds;
      openFromInput(p.ds);
    });
    el.presets.appendChild(b);
  }
}

function start() {
  buildPresets();
  setupMapEvents();
  el.form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    openFromInput(el.input.value);
  });
  const ds = params.get('ds');
  if (params.get('table_url')) {
    el.input.value = params.get('table_url');
    openFromInput('');
  } else if (ds) {
    const url = `https://huggingface.co/datasets/${ds}` + (params.get('table') ? `/resolve/main/${params.get('table')}` : '');
    el.input.value = url;
    openFromInput(url);
  }
}

start();
