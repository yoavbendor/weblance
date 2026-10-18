// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Yoav Bendor
//
// The debug log of the weblance pages: a plain script, loaded first by index.html and explore.html, that
// defines window.wlDebug. Timings, counters and errors are written to localStorage as they happen, so a
// visit that ends in a tab crash keeps its log. A visit marks itself ended on pagehide and holds a Web
// Lock named after it for as long as its tab lives (a crashed tab releases it; a background tab keeps it);
// on the next load an unended visit whose lock is free is 'crashed', and a banner offers the report.
// Without the Web Locks API, a heartbeat written every 2 s while visible stands in: an unended visit whose
// heartbeat is over 6 s old is crashed (a long-hidden tab can then be reported by mistake). The panel (footer link, ?debug=1 or Shift+D) shows the log
// and copies the report. Nothing is sent anywhere.

(function () {
  'use strict';

  const KEY = 'weblance-debug-v1';
  const MAX_VISITS = 5;
  const MAX_EVENTS = 3000;     // per visit; the oldest are dropped and counted
  const MAX_STORE = 1000000;   // characters of the stored JSON
  const REPORT_MAX = 60000;    // characters of the copy text
  const SAVE_EVERY = 300;      // ms: ordinary events are written at most this often; errors at once
  const HEARTBEAT = 2000;      // ms, while the page is visible
  const STALE = 6000;          // ms: without Web Locks, an unended visit with an older heartbeat is crashed
  const LOCK = 'weblance-visit-';
  const locks = navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null;
  const PANEL_EVENTS = 200;
  const IMMEDIATE = { error: 1, 'console.error': 1, 'worker.error': 1, 'worker.messageerror': 1, abort: 1 };
  const CSS = `
.wl-banner, .wl-panel { font: 14px/1.45 var(--font); color: var(--fg); }
.wl-banner { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 16px;
  background: var(--panel); border-bottom: 1px solid var(--err); }
.wl-banner[hidden], .wl-panel[hidden] { display: none; }
.wl-banner button, .wl-panel button { font: inherit; font-size: 14px; padding: 5px 10px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--panel); color: var(--fg); cursor: pointer; }
.wl-say, .wl-note, .wl-status { color: var(--muted); }
.wl-open { font: inherit; font-size: 13px; background: none; border: 0; padding: 0; color: var(--muted);
  text-decoration: underline; cursor: pointer; }
.wl-panel { position: fixed; left: 0; right: 0; bottom: 0; z-index: 1000; box-sizing: border-box; max-height: 80vh;
  overflow-y: auto; padding: 14px 16px 18px; background: var(--panel); border-top: 1px solid var(--line);
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.18); }
.wl-inner { max-width: 960px; margin: 0 auto; }
.wl-panel h2 { font-size: 17px; margin: 0 0 4px; }
.wl-panel h3 { font-size: 14px; margin: 14px 0 4px; }
.wl-panel p { margin: 4px 0; }
.wl-mem { color: var(--err); }
.wl-panel ul { margin: 0; padding-left: 18px; font: 12px/1.5 var(--mono); }
.wl-panel pre, .wl-text { font: 12px/1.45 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%;
  box-sizing: border-box; margin: 0; padding: 8px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--bg); color: var(--fg); }
.wl-panel pre { max-height: 36vh; overflow-y: auto; }
.wl-text { width: 100%; height: 14em; margin-top: 6px; }
.wl-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 6px; }`;

  const pageName = location.pathname.split('/').pop() || 'index.html';
  const r1 = (x) => Math.round(x * 10) / 10;
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '...' : s);

  let storageOk = true;
  let visits = [];   // this tab's view of the store, oldest first; the current visit is cur
  let cur = null;
  let saveTimer = 0;
  let panelOpen = false;
  let ui = null;     // the banner and the panel, built when the DOM is ready

  function fmtBytes(n) {
    if (n < 1024) return n + 'B';
    if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1048576).toFixed(1) + 'MB';
  }

  function jsMB() {
    return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : undefined;
  }

  // Field values are kept small: strings clipped, errors and objects reduced to text.
  function clean(v) {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') return clip(v, 300);
    if (v instanceof Error) return clip(v.message, 300);
    try {
      return clip(JSON.stringify(v), 300);
    } catch (e) {
      return '?';
    }
  }

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function stateOf(v) {
    return v === cur ? 'this visit' : v.crashed ? 'CRASHED' : v.ended ? 'ended' : 'open';
  }

  // ---- storage ------------------------------------------------------------------------------------

  // The visits as the store has them now (none when the store cannot be read).
  function readStore() {
    let raw;
    try {
      raw = window.localStorage.getItem(KEY);
    } catch (e) {
      storageOk = false;  // blocked: the log lives in memory only
      return [];
    }
    try {
      const s = raw ? JSON.parse(raw) : null;
      return s && Array.isArray(s.visits) ? s.visits : [];
    } catch (e) {
      return [];  // unreadable: start again
    }
  }

  // Each tab writes its own visit and keeps the others as they are stored, so a tab's stale copy never
  // overwrites another tab's heartbeat. The crashed and acknowledged flags of either copy are kept.
  function mergeStore() {
    const byId = new Map();
    for (const v of readStore()) byId.set(v.id, v);
    for (const v of visits) {
      const s = byId.get(v.id);
      if (!s || v === cur) {
        byId.set(v.id, v);
      } else {
        s.crashed = s.crashed || v.crashed;
        s.acked = s.acked || v.acked;
      }
    }
    visits = [...byId.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }

  // The JSON to store: the last MAX_VISITS visits, under MAX_STORE characters (oldest visits go first).
  function serialize() {
    while (visits.length > MAX_VISITS) visits.shift();
    let json = JSON.stringify({ visits });
    while (json.length > MAX_STORE && visits.length > 1) {
      visits.shift();
      json = JSON.stringify({ visits });
    }
    while (json.length > MAX_STORE && cur.events.length > 0) {
      const d = Math.max(1, Math.ceil(cur.events.length / 10));
      cur.events.splice(0, d);
      cur.dropped += d;
      json = JSON.stringify({ visits });
    }
    return json;
  }

  function write(json) {
    try {
      window.localStorage.setItem(KEY, json);
    } catch (e) {
      // Full: keep only this visit. Blocked, or still full: the log lives in memory from now on.
      if (e && e.name === 'QuotaExceededError') {
        visits = [cur];
        try {
          window.localStorage.setItem(KEY, serialize());
          return;
        } catch (e2) {
          // fall through: memory only
        }
      }
      storageOk = false;
    }
  }

  function persist() {
    if (!cur || !storageOk) return;
    mergeStore();
    write(serialize());
  }

  function refresh() {
    if (panelOpen) renderPanel();
    updateBanner();
  }

  function saveSoon() {
    if (!saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = 0;
        persist();
        refresh();
      }, SAVE_EVERY);
    }
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    persist();
    refresh();
  }

  // ---- visits -------------------------------------------------------------------------------------

  // held: the names of the Web Locks held by live tabs, or null without the Web Locks API.
  function markCrashed(held) {
    const now = Date.now();
    for (const v of visits) {
      if (v.ended || v.crashed || v === cur) continue;
      if (held ? !held.has(LOCK + v.id) : now - (v.hb || 0) > STALE) v.crashed = true;
    }
  }

  function moduleSize(entries) {
    const e = entries.find((r) => /weblance\.wasm(\?|$)/.test(r.name));
    return e ? { transfer: e.transferSize, decoded: e.decodedBodySize } : null;
  }

  function collectEnv() {
    const n = navigator;
    const env = {
      ua: n.userAgent, cores: n.hardwareConcurrency, memGB: n.deviceMemory, screen: screen.width + 'x' + screen.height,
      dpr: window.devicePixelRatio, lang: n.language, url: location.href, nav: null,
      wasm: moduleSize(performance.getEntriesByType('resource')),
    };
    if (n.userAgentData) {
      const u = n.userAgentData;
      env.uad = { brands: (u.brands || []).map((b) => b.brand + ' ' + b.version).join(', '), platform: u.platform, mobile: u.mobile };
    }
    if (performance.memory) env.jsLimitMB = Math.round(performance.memory.jsHeapSizeLimit / 1048576);
    return env;
  }

  function startVisit() {
    cur = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), page: pageName, url: location.href,
      start: new Date().toISOString(), env: collectEnv(), ended: false, crashed: false, acked: false,
      hb: Date.now(), events: [], dropped: 0,
    };
    visits.push(cur);
    log('visit.start', { page: pageName, jsMB: jsMB() });
  }

  // ---- the API ------------------------------------------------------------------------------------

  function log(kind, fields) {
    if (!cur) return;
    const ev = { t: r1(performance.now()), kind: String(kind) };
    if (fields) {
      for (const k of Object.keys(fields)) if (fields[k] !== undefined) ev[k] = clean(fields[k]);
    }
    cur.events.push(ev);
    if (cur.events.length > MAX_EVENTS) {
      cur.events.shift();
      cur.dropped++;
    }
    if (IMMEDIATE[ev.kind]) saveNow();
    else saveSoon();
  }

  // Logs `kind` when the returned end(moreFields) is called, with ms = the time since the span began.
  function span(kind, fields) {
    const t0 = performance.now();
    return function end(more) {
      log(kind, Object.assign({ ms: r1(performance.now() - t0) }, fields, more));
    };
  }

  // The worker's error events, every reply that failed, and every abort the worker reports.
  function attachWorker(worker, name) {
    worker.addEventListener('error', (e) => {
      log('worker.error', { w: name, msg: e.message || 'worker error', where: (e.filename || '').split('/').pop() + ':' + e.lineno });
    });
    worker.addEventListener('messageerror', () => log('worker.messageerror', { w: name }));
    worker.addEventListener('message', (ev) => {
      const d = ev.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'abort') log('abort', { w: name, what: d.what });
      else if (d.ok === false) log('worker.error', { w: name, op: d.type, error: d.error });
    });
  }

  // ---- the report ---------------------------------------------------------------------------------

  function eventLine(ev) {
    const parts = [];
    for (const k of Object.keys(ev)) {
      if (k === 't' || k === 'kind') continue;
      const v = ev[k];
      parts.push(k + '=' + (typeof v === 'number' && /bytes$/i.test(k) ? fmtBytes(v) : String(v)));
    }
    return '+' + (ev.t / 1000).toFixed(3) + 's ' + ev.kind + (parts.length ? ' ' + parts.join(' ') : '');
  }

  function envLines(env) {
    const lines = ['ua: ' + env.ua];
    if (env.uad) lines.push('ua-brands: ' + env.uad.brands + ' | platform: ' + env.uad.platform + (env.uad.mobile ? ' | mobile' : ''));
    lines.push('cores=' + env.cores + ' memGB=' + (env.memGB === undefined ? 'n/a' : env.memGB) + ' screen=' + env.screen +
      ' dpr=' + env.dpr + ' lang=' + env.lang, 'url: ' + env.url);
    if (env.wasm) {
      // Safari reports both sizes as 0 for the module: then they are absent, not 0 B.
      const sized = env.wasm.transfer || env.wasm.decoded;
      lines.push('weblance.wasm (this page): ' + (sized ? 'transfer=' + fmtBytes(env.wasm.transfer) + ' decoded=' + fmtBytes(env.wasm.decoded)
        : 'transfer and decoded sizes absent'));
    }
    if (env.nav) lines.push('navigation: domContentLoaded=' + env.nav.dcl + 'ms load=' + env.nav.load + 'ms');
    if (env.jsLimitMB) lines.push('js heap limit=' + env.jsLimitMB + 'MB');
    return lines;
  }

  // The copy text: a header, then the crashed visits and the current one (the last three), one event per
  // line. Over REPORT_MAX characters, the oldest events go first, and the report says how many.
  function report() {
    const head = ['weblance debug report', 'time: ' + new Date().toISOString(), 'page: ' + pageName + ' (visit ' + cur.id + ')']
      .concat(envLines(cur.env));
    if (!storageOk) head.push('storage: blocked; this log lives in memory only');
    const blocks = visits.filter((v) => v.crashed || v === cur).slice(-3).map((v) => ({
      title: '== visit ' + v.id + ' ' + v.page + ' ' + v.start + ' (' + stateOf(v) + ')',
      dropped: v.dropped, lines: v.events.map(eventLine), cut: 0,
    }));
    let excess = head.join('\n').length - REPORT_MAX;
    for (const b of blocks) excess += b.title.length + 1 + b.lines.reduce((a, l) => a + l.length + 1, 0);
    for (const b of blocks) {
      let i = 0;
      while (excess > 0 && i < b.lines.length) {
        excess -= b.lines[i].length + 1;
        i++;
      }
      b.cut = i;
      b.lines = b.lines.slice(i);
    }
    const out = head.slice();
    for (const b of blocks) {
      out.push(b.title);
      if (b.dropped) out.push('(' + b.dropped + ' oldest events dropped when the log was stored)');
      if (b.cut) out.push('(' + b.cut + ' oldest events left out to keep the report under 60 KB)');
      out.push(...b.lines);
    }
    if (!blocks.length) out.push('(no crashed visit and no current visit to report)');
    return out.join('\n');
  }

  // ---- the banner and the panel -------------------------------------------------------------------

  function say(msg) {
    if (!ui) return;
    ui.bannerSay.textContent = msg;
    ui.status.textContent = msg;
  }

  function showPanel() {
    panelOpen = true;
    if (ui) ui.panel.hidden = false;
    renderPanel();
  }

  function hidePanel() {
    panelOpen = false;
    if (ui) ui.panel.hidden = true;
  }

  // When the browser will not copy, the text is selected in the panel for a manual copy.
  function showText(text) {
    showPanel();
    ui.text.value = text;
    ui.text.hidden = false;
    ui.text.focus();
    ui.text.select();
    say('Copy is blocked here: the report is selected below; copy it by hand.');
  }

  function copyReport() {
    const text = report();
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      showText(text);
      return;
    }
    navigator.clipboard.writeText(text).then(() => say('Copied. Paste it into the chat.'), () => showText(text));
  }

  function dismiss() {
    for (const v of visits) if (v.crashed) v.acked = true;
    saveNow();
  }

  function clearLog() {
    visits = [cur];
    cur.events = [];
    cur.dropped = 0;
    if (storageOk) write(serialize());
    refresh();
    say('Log cleared.');
  }

  function updateBanner() {
    if (ui) ui.banner.hidden = !visits.some((v) => v.crashed && !v.acked);
  }

  function renderPanel() {
    if (!ui || !cur) return;
    ui.memNote.hidden = storageOk;
    ui.visitList.textContent = '';
    for (const v of visits) {
      ui.visitList.appendChild(h('li', '', new Date(v.start).toLocaleString() + '  ' + v.page + '  ' + stateOf(v) + '  ' +
        v.events.length + ' events' + (v.dropped ? ' (' + v.dropped + ' dropped)' : '')));
    }
    const last = cur.events.slice(-PANEL_EVENTS).map(eventLine);
    ui.events.textContent = last.length ? last.join('\n') : '(no events yet)';
  }

  function buildUi() {
    document.head.appendChild(h('style', '', CSS));
    const btn = (text, fn, cls) => {
      const b = h('button', cls || '', text);
      b.type = 'button';
      b.addEventListener('click', fn);
      return b;
    };

    const banner = h('div', 'wl-banner');
    banner.setAttribute('role', 'status');
    const bannerSay = h('span', 'wl-say');
    banner.append(h('span', '', 'The last visit ended unexpectedly.'), btn('Copy debug report', copyReport),
      btn('Dismiss', dismiss), bannerSay);
    document.body.insertBefore(banner, document.body.firstChild);

    const panel = h('div', 'wl-panel');
    panel.id = 'wl-debug';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Debug log');
    const memNote = h('p', 'wl-mem', 'The log is in memory only: this browser blocks localStorage, so a crash cannot be recovered.');
    const visitList = h('ul');
    const events = h('pre');
    const status = h('p', 'wl-status');
    status.setAttribute('role', 'status');
    const text = h('textarea', 'wl-text');
    text.readOnly = true;
    text.hidden = true;
    text.setAttribute('aria-label', 'Debug report text');
    const actions = h('div', 'wl-actions');
    actions.append(btn('Copy debug report', copyReport), btn('Clear log', clearLog), btn('Close', hidePanel));
    const inner = h('div', 'wl-inner');
    inner.append(h('h2', '', 'Debug log'), h('p', 'wl-note', 'Stored only in this browser; nothing is sent anywhere.'),
      memNote, h('h3', '', 'Visits'), visitList,
      h('h3', '', 'This visit: the last ' + PANEL_EVENTS + ' events, newest last'), events, actions, status, text);
    panel.appendChild(inner);
    document.body.appendChild(panel);
    ui = { banner, bannerSay, panel, memNote, visitList, events, status, text };

    const footer = document.querySelector('footer');
    const link = btn('debug', showPanel, 'wl-open');
    link.title = 'Show the debug log (Shift+D)';
    (footer ? footer.querySelector('p') || footer : document.body).append(' · ', link);

    updateBanner();
    if (new URLSearchParams(location.search).get('debug') === '1') showPanel();
  }

  // ---- start --------------------------------------------------------------------------------------

  visits = readStore();
  startVisit();
  if (locks) {
    // Held until the tab goes away; the callback's promise never settles.
    locks.request(LOCK + cur.id, () => new Promise(() => {})).catch(() => {});
    locks.query().then((q) => {
      markCrashed(new Set((q.held || []).map((l) => l.name)));
      saveNow();
    }, () => {
      markCrashed(null);
      saveNow();
    });
  } else {
    markCrashed(null);
  }
  saveNow();

  window.addEventListener('error', (e) => {
    const where = e.filename ? e.filename.split('/').pop() + ':' + e.lineno + ':' + e.colno : '';
    log('error', { msg: e.message || String(e.error || 'error'), where, stack: e.error && e.error.stack });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    log('error', { msg: 'unhandled rejection: ' + (r && r.message ? r.message : String(r)) });
  });
  const consoleError = console.error;
  console.error = function () {
    try {
      log('console.error', { msg: Array.prototype.map.call(arguments, (a) => (a && a.message) || String(a)).join(' ') });
    } catch (e) {
      // logging never stops the page
    }
    return consoleError.apply(console, arguments);
  };
  window.addEventListener('load', () => setTimeout(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    if (!nav || !cur) return;
    cur.env.nav = { dcl: r1(nav.domContentLoadedEventEnd), load: r1(nav.loadEventEnd) };
    log('page.load', { dcl: cur.env.nav.dcl, load: cur.env.nav.load, jsMB: jsMB() });
  }, 0));
  window.addEventListener('pagehide', () => {
    if (!cur) return;
    cur.ended = true;
    saveNow();
  });
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted || !cur) return;  // back from the back-forward cache: this visit goes on
    cur.ended = false;
    cur.hb = Date.now();
    log('page.restored');
    saveNow();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
  setInterval(() => {
    if (!cur || cur.ended || document.visibilityState !== 'visible') return;
    cur.hb = Date.now();
    persist();
  }, HEARTBEAT);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) {
      hidePanel();
      return;
    }
    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'D' && e.key !== 'd')) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    if (panelOpen) hidePanel();
    else showPanel();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUi);
  else buildUi();

  window.wlDebug = {
    log,
    span,
    attachWorker,
    report,
    mem: jsMB,
    showPanel,
    hidePanel,
    get visitId() {
      return cur ? cur.id : '';
    },
    get storageOk() {
      return storageOk;
    },
  };
})();
