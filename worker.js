// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// One of the page's pool of workers. Loads the weblance module, opens the dataset once, then answers
// {type:'row', id, row} with that row's caption and image_bytes (wl_take_json, wl_take_binary). Every
// reply carries the wl_stats_json counters of that call; the counters are reset after each read, so
// the page can add them up.

importScripts('lib/weblance.js');

let M = null;
let handle = 0;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function utf8(s) {
  const n = M.lengthBytesUTF8(s) + 1;
  const p = M._malloc(n);
  M.stringToUTF8(s, p, n);
  return p;
}

// Copies a string the module returned, then frees it.
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

// The module's transfer and decoded size, from this worker's resource timing.
function moduleSize() {
  const e = self.performance.getEntriesByType('resource').find((r) => /weblance\.wasm(\?|$)/.test(r.name));
  return e ? { transfer: e.transferSize, decoded: e.decodedBodySize } : null;
}

function sniffImageType(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return 'application/octet-stream';
}

function takeCaption(row) {
  const rows = M._malloc(8);
  new BigInt64Array(M.HEAPU8.buffer, rows, 1)[0] = BigInt(row);
  const cols = utf8('caption');
  const text = takeText(M.ccall('wl_take_json', 'number', ['number', 'number', 'number', 'number'], [handle, rows, 1, cols]));
  M._free(cols);
  M._free(rows);
  if (text === null) throw new Error('wl_take_json: ' + lastError());
  return JSON.parse(text)[0].caption;
}

function takeImage(row) {
  const lenPtr = M._malloc(4);
  const col = utf8('image_bytes');
  const ptr = M._wl_take_binary(handle, BigInt(row), col, lenPtr);
  const len = new Int32Array(M.HEAPU8.buffer, lenPtr, 1)[0];
  M._free(col);
  M._free(lenPtr);
  if (!ptr || len < 0) throw new Error('wl_take_binary: ' + lastError());
  const copy = M.HEAPU8.slice(ptr, ptr + len);
  M._wl_free(ptr);
  return copy;
}

async function openDataset(ds) {
  const t0 = performance.now();
  try {
    // The module loads from lib/; without this Emscripten looks next to the worker script.
    // An Emscripten abort (out of memory, a failed range read) is posted before the worker's error reply.
    M = await createWeblance({ locateFile: (p) => 'lib/' + p,
      onAbort: (what) => post({ type: 'abort', what: String(what) }) });
    const p = utf8(ds);
    handle = M.ccall('wl_open', 'number', ['number'], [p]);
    M._free(p);
    if (!handle) throw new Error('wl_open: ' + lastError());
    const info = JSON.parse(takeText(M.ccall('wl_info_json', 'number', ['number'], [handle])));
    post({ type: 'open', ok: true, ms: performance.now() - t0, info, stats: takeStats(),
      heap: M.HEAPU8.length, module: moduleSize() });
  } catch (e) {
    const stats = M ? takeStats() : { requests: 0, bytes: 0, ms: 0 };
    post({ type: 'open', ok: false, error: String((e && e.message) || e), stats });
  }
}

function doRow(m) {
  const t0 = performance.now();
  try {
    const caption = takeCaption(m.row);
    const bytes = takeImage(m.row);
    const ms = performance.now() - t0;
    post(
      { type: 'row', id: m.id, row: m.row, ok: true, caption, image: bytes.buffer,
        imageType: sniffImageType(bytes), ms, stats: takeStats(), heap: M.HEAPU8.length },
      [bytes.buffer]
    );
  } catch (e) {
    post({ type: 'row', id: m.id, row: m.row, ok: false, error: String((e && e.message) || e),
      ms: performance.now() - t0, stats: takeStats(), heap: M ? M.HEAPU8.length : 0 });
  }
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'open') openDataset(m.ds);
  else if (m.type === 'row') doRow(m);
};
