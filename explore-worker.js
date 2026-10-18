// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// A worker of the explore page. It opens one Lance table through the weblance module and answers, in
// order, three kinds of message:
//   {type:'open', ds}                      -> {type:'open', ok, info, stats}
//   {type:'image', id, row, col}           -> {type:'image', id, ok, image, stats}   (one binary value)
//   {type:'sample', id, ds, windows, vec, cols}
//        -> {type:'progress', id, done, total, stats} per window, then
//           {type:'sample', id, ok, rows, x, y, cluster, centers, labels, captions, dim, stats (totals)}
// The counters of a progress message are that window's; the totals are for reference, not to be added.
// The sample reads vectors (wl_take_vectors) and the label and caption columns (wl_take_json) for
// each window of contiguous rows, then runs PCA (top two components, power iteration with deflation)
// and k-means (k = 16) on the 2D layout. Rows without a vector (null, or zero after normalizing) are
// dropped from the result. The counters are summed over the calls of one message.

importScripts('lib/weblance.js');

const KMEANS_K = 16;
let M = null;
let handle = 0;
let chain = Promise.resolve();

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function utf8(s) {
  const n = M.lengthBytesUTF8(s) + 1;
  const p = M._malloc(n);
  M.stringToUTF8(s, p, n);
  return p;
}

function takeText(ptr) {
  if (!ptr) return null;
  const text = M.UTF8ToString(ptr);
  M._wl_free(ptr);
  return text;
}

function lastError() {
  return M.ccall('wl_error', 'string', [], []) || 'unknown error';
}

// Counters since the previous call. Reading them resets them.
function takeStats() {
  const s = JSON.parse(takeText(M.ccall('wl_stats_json', 'number', [], [])));
  M.ccall('wl_reset_stats', null, [], []);
  return { requests: s.requests, bytes: s.bytes, ms: s.ms };
}

function addStats(a, b) {
  return { requests: a.requests + b.requests, bytes: a.bytes + b.bytes, ms: a.ms + b.ms };
}

async function ensureModule() {
  if (!M) M = await createWeblance({ locateFile: (p) => 'lib/' + p });
}

async function doOpen(ds) {
  await ensureModule();
  const p = utf8(ds);
  handle = M.ccall('wl_open', 'number', ['number'], [p]);
  M._free(p);
  if (!handle) throw new Error('wl_open: ' + lastError());
  const info = JSON.parse(takeText(M.ccall('wl_info_json', 'number', ['number'], [handle])));
  return { info, stats: takeStats() };
}

function takeBinary(row, col) {
  const lenPtr = M._malloc(4);
  const cp = utf8(col);
  const ptr = M._wl_take_binary(handle, BigInt(row), cp, lenPtr);
  const len = new Int32Array(M.HEAPU8.buffer, lenPtr, 1)[0];
  M._free(cp);
  M._free(lenPtr);
  if (!ptr || len < 0) throw new Error('wl_take_binary: ' + lastError());
  const copy = M.HEAPU8.slice(ptr, ptr + len);
  M._wl_free(ptr);
  return copy;
}

// The rows of `rows` (sorted, distinct not required) as an int64 buffer for the module.
function rowBuffer(rows) {
  const p = M._malloc(8 * rows.length);
  new BigInt64Array(M.HEAPU8.buffer, p, rows.length).set(BigInt64Array.from(rows, (r) => BigInt(r)));
  return p;
}

// Vectors of rows [start, start+len) as float32s, plus the dimension.
function takeVectors(rows, col) {
  const rp = rowBuffer(rows);
  const cp = utf8(col);
  const dimPtr = M._malloc(4);
  const vp = M._wl_take_vectors(handle, rp, rows.length, cp, dimPtr);
  const dim = new Int32Array(M.HEAPU8.buffer, dimPtr, 1)[0];
  M._free(dimPtr);
  M._free(cp);
  M._free(rp);
  if (!vp) throw new Error('wl_take_vectors: ' + lastError());
  const out = new Float32Array(M.HEAPU8.buffer.slice(vp, vp + rows.length * dim * 4));
  M._wl_free(vp);
  return { values: out, dim };
}

// Scalar columns of `rows` as an array of row objects (keys are the column names).
function takeScalars(rows, cols) {
  const rp = rowBuffer(rows);
  const cp = utf8(cols.join(','));
  const text = takeText(M.ccall('wl_take_json', 'number', ['number', 'number', 'number', 'number'], [handle, rp, rows.length, cp]));
  M._free(cp);
  M._free(rp);
  if (text === null) throw new Error('wl_take_json: ' + lastError());
  return JSON.parse(text);
}

// Deterministic pseudo-random numbers (a linear congruential generator).
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Top two principal components of the rows of X (n x d, already normalized and centered): power
// iteration on X^T X, then deflation of the first component from a residual copy. Returns the
// scores of every row on the two components.
function pca2(X, n, d) {
  const rnd = makeRandom(20261018);
  const R = Float64Array.from(X);
  const comps = [];
  for (let c = 0; c < 2; c++) {
    let v = new Float64Array(d);
    for (let j = 0; j < d; j++) v[j] = rnd() - 0.5;
    normalize(v);
    for (let iter = 0; iter < 200; iter++) {
      const t = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        const o = i * d;
        for (let j = 0; j < d; j++) s += R[o + j] * v[j];
        t[i] = s;
      }
      const w = new Float64Array(d);
      for (let i = 0; i < n; i++) {
        const o = i * d;
        const ti = t[i];
        for (let j = 0; j < d; j++) w[j] += R[o + j] * ti;
      }
      normalize(w);
      let delta = 0;
      for (let j = 0; j < d; j++) delta = Math.max(delta, Math.abs(w[j] - v[j]));
      v = w;
      if (delta < 1e-9) break;
    }
    comps.push(v);
    for (let i = 0; i < n; i++) {
      const o = i * d;
      let s = 0;
      for (let j = 0; j < d; j++) s += R[o + j] * v[j];
      for (let j = 0; j < d; j++) R[o + j] -= s * v[j];
    }
  }
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * d;
    let a = 0;
    let b = 0;
    for (let j = 0; j < d; j++) {
      a += X[o + j] * comps[0][j];
      b += X[o + j] * comps[1][j];
    }
    xs[i] = a;
    ys[i] = b;
  }
  return { xs, ys };
}

function normalize(v) {
  let s = 0;
  for (let j = 0; j < v.length; j++) s += v[j] * v[j];
  s = Math.sqrt(s);
  if (s > 0) for (let j = 0; j < v.length; j++) v[j] /= s;
  return v;
}

// Maps points into [0.02, 0.98] on both axes with one scale, so the layout keeps its aspect ratio.
function fitUnit(xs, ys) {
  const n = xs.length;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]);
    y0 = Math.min(y0, ys[i]); y1 = Math.max(y1, ys[i]);
  }
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const sc = 0.96 / span;
  const ox = 0.02 + (0.96 - (x1 - x0) * sc) / 2;
  const oy = 0.02 + (0.96 - (y1 - y0) * sc) / 2;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = ox + (xs[i] - x0) * sc;
    y[i] = oy + (ys[i] - y0) * sc;
  }
  return { x, y };
}

// k-means with k-means++ seeding on the 2D points. Returns the cluster of each point and the centers.
function kmeans(x, y, k) {
  const n = x.length;
  const rnd = makeRandom(7);
  const cx = [], cy = [];
  const first = Math.floor(rnd() * n);
  cx.push(x[first]); cy.push(y[first]);
  const dist = new Float64Array(n);
  while (cx.length < Math.min(k, n)) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (let c = 0; c < cx.length; c++) best = Math.min(best, (x[i] - cx[c]) ** 2 + (y[i] - cy[c]) ** 2);
      dist[i] = best;
      total += best;
    }
    let pick = rnd() * total;
    let idx = n - 1;
    for (let i = 0; i < n; i++) {
      pick -= dist[i];
      if (pick <= 0) { idx = i; break; }
    }
    cx.push(x[idx]); cy.push(y[idx]);
  }
  const kk = cx.length;
  const assign = new Uint8Array(n);
  for (let iter = 0; iter < 40; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < kk; c++) {
        const d = (x[i] - cx[c]) ** 2 + (y[i] - cy[c]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      if (assign[i] !== best || iter === 0) moved++;
      assign[i] = best;
    }
    const sx = new Float64Array(kk), sy = new Float64Array(kk), cnt = new Float64Array(kk);
    for (let i = 0; i < n; i++) {
      sx[assign[i]] += x[i]; sy[assign[i]] += y[i]; cnt[assign[i]]++;
    }
    for (let c = 0; c < kk; c++) {
      if (cnt[c] > 0) { cx[c] = sx[c] / cnt[c]; cy[c] = sy[c] / cnt[c]; }
    }
    if (moved === 0) break;
  }
  return { assign, centers: cx.map((v, c) => [v, cy[c]]) };
}

// Reads the windows, then lays the vectors out. windows: [[start, length], ...].
async function doSample(m) {
  const total = m.windows.reduce((a, w) => a + w[1], 0);
  const vecs = [];
  const labelsOut = [];
  const captionsOut = [];
  const rowsOut = [];
  let dim = 0;
  let stats = { requests: 0, bytes: 0, ms: 0 };  // all the windows
  let done = 0;
  const scalarCols = [m.label, m.caption].filter((c) => c);
  for (const [start, len] of m.windows) {
    const rows = Array.from({ length: len }, (_, i) => start + i);
    let delta = { requests: 0, bytes: 0, ms: 0 };  // this window, reported in its progress message
    const v = takeVectors(rows, m.vec);
    dim = v.dim;
    delta = addStats(delta, takeStats());
    let scalars = [];
    if (scalarCols.length) {
      scalars = takeScalars(rows, scalarCols);
      delta = addStats(delta, takeStats());
    }
    stats = addStats(stats, delta);
    vecs.push(v.values);
    for (let i = 0; i < len; i++) {
      rowsOut.push(rows[i]);
      if (m.label) labelsOut.push(scalars[i][m.label]);
      if (m.caption) captionsOut.push(scalars[i][m.caption]);
    }
    done += len;
    post({ type: 'progress', id: m.id, done, total, stats: delta });
  }
  // Flatten, then drop null vectors and normalize the rest.
  const n0 = rowsOut.length;
  const all = new Float64Array(n0 * dim);
  let p = 0;
  for (const block of vecs) {
    for (let i = 0; i < block.length; i++) all[p++] = block[i];
  }
  const keep = [];
  for (let i = 0; i < n0; i++) {
    const o = i * dim;
    let s = 0;
    let bad = false;
    for (let j = 0; j < dim; j++) {
      const q = all[o + j];
      if (!Number.isFinite(q)) { bad = true; break; }
      s += q * q;
    }
    if (!bad && s > 0) {
      const inv = 1 / Math.sqrt(s);
      for (let j = 0; j < dim; j++) all[o + j] *= inv;
      keep.push(i);
    }
  }
  const n = keep.length;
  const X = new Float64Array(n * dim);
  for (let k = 0; k < n; k++) X.set(all.subarray(keep[k] * dim, keep[k] * dim + dim), k * dim);
  // Center on the kept rows.
  const mean = new Float64Array(dim);
  for (let k = 0; k < n; k++) for (let j = 0; j < dim; j++) mean[j] += X[k * dim + j];
  for (let j = 0; j < dim; j++) mean[j] /= Math.max(n, 1);
  for (let k = 0; k < n; k++) for (let j = 0; j < dim; j++) X[k * dim + j] -= mean[j];

  const rows = Int32Array.from(keep, (i) => rowsOut[i]);
  const labels = keep.map((i) => (m.label ? labelsOut[i] : null));
  const captions = keep.map((i) => (m.caption ? captionsOut[i] : null));
  let x, y, cluster = new Uint8Array(n), centers = [];
  if (n >= 3) {
    const pc = pca2(X, n, dim);
    const xy = fitUnit(pc.xs, pc.ys);
    x = xy.x;
    y = xy.y;
    const km = kmeans(x, y, KMEANS_K);
    cluster = km.assign;
    centers = km.centers;
  } else {
    x = new Float32Array(n);
    y = new Float32Array(n);
  }
  // The counters were sent window by window (progress); this message carries the totals for reference.
  const out = { type: 'sample', id: m.id, ok: true, rows, x, y, cluster, centers, labels, captions, dim,
    requested: total, kept: n, stats };
  post(out, [rows.buffer, x.buffer, y.buffer, cluster.buffer]);
}

async function handleMessage(m) {
  try {
    if (m.type === 'open') {
      const r = await doOpen(m.ds);
      post({ type: 'open', ok: true, info: r.info, stats: r.stats });
    } else if (m.type === 'image') {
      const bytes = takeBinary(m.row, m.col);
      post({ type: 'image', id: m.id, row: m.row, ok: true, image: bytes.buffer, stats: takeStats() }, [bytes.buffer]);
    } else if (m.type === 'sample') {
      await doSample(m);
    }
  } catch (e) {
    const error = String((e && e.message) || e);
    // The counters of a failed call; a sample reports its counters window by window, so none here.
    const stats = M && handle && m.type !== 'sample' ? takeStats() : { requests: 0, bytes: 0, ms: 0 };
    post({ type: m.type, id: m.id, ok: false, error, stats });
  }
}

self.onmessage = (ev) => {
  // Messages run one at a time, in order: an image asked for before the open has finished waits for it.
  chain = chain.then(() => handleMessage(ev.data));
};
