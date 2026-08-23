// Lumisca browser probe — SINGLE SOURCE OF TRUTH.
//
// Consumed two ways:
//  - Deno/TypeScript: `import { PROBE_SOURCE } from "./probe.js"` — the
//    module export below. `deno compile` bundles it statically, so the
//    compiled server binary carries the probe with no disk dependency.
//  - Rust hosts (desktop, browser-host): `include_str!` on this file, then
//    extract the text between the opening "String.raw" + back-tick and the
//    closing back-tick (browser-rpc). String.raw keeps backslashes
//    verbatim, so the extracted text is exactly the JavaScript injected
//    into the page.
//
// The probe content must NOT contain backticks or "${" (it lives inside a
// template literal whose raw text must equal the injected script). The
// Deno test probe_test.ts enforces both invariants.

/* LUMISCA-PROBE-START */
export const PROBE_SOURCE = String.raw`
(function () {
  "use strict";
  if (window.__lumiscaProbe) { return; }

  // --- limits (mirror packages/core/browser/types.ts) --------------------
  var MAX_ELEMENTS = 300;
  var MAX_TEXT = 4096;
  var MAX_CONSOLE = 200;
  var MAX_ERRORS = 50;
  var MAX_ENTRY = 400;
  var MAX_ELEMENT_TEXT = 160;
  var MAX_ELEMENT_NAME = 160;
  var MAX_VALUE = 400;
  var MAX_PULL_CONSOLE = 100;
  var MAX_PULL_ERRORS = 50;

  var state = {
    seq: 0,
    servedSeq: 0,
    consoleEntries: [],
    pageErrors: [],
    domMutations: 0,
    observedMutations: 0,
    network: { active: 0, completed: 0, failed: 0, lastActivity: null },
    checkCallbacks: [],
    waitStarted: 0
  };

  function touch() {
    state.network.lastActivity = Date.now();
    trigger();
  }

  function trigger() {
    if (state.checkCallbacks.length === 0) { return; }
    var callbacks = state.checkCallbacks.slice();
    for (var i = 0; i < callbacks.length; i++) {
      try { callbacks[i](); } catch (e) { /* probe must never throw */ }
    }
  }

  // --- console ------------------------------------------------------------
  function formatArg(value) {
    if (typeof value === "string") { return value; }
    if (value instanceof Error) {
      var line = "";
      if (value.stack) {
        var parts = value.stack.split("\n");
        line = parts.length > 1 ? parts[1].trim() : "";
      }
      return (value.message || String(value)) + (line ? " | " + line : "");
    }
    if (typeof value === "object" && value !== null) {
      try {
        var json = JSON.stringify(value);
        if (json && json.length > 0 && json.length <= 200) { return json; }
      } catch (e) { /* circular — fall through */ }
      var name = value.constructor && value.constructor.name
        ? value.constructor.name
        : "Object";
      return "[object " + name + "]";
    }
    return String(value);
  }

  function formatArgs(args) {
    var out = [];
    var total = 0;
    for (var i = 0; i < args.length; i++) {
      var text = String(formatArg(args[i]));
      if (total + text.length > MAX_ENTRY) {
        text = text.slice(0, Math.max(0, MAX_ENTRY - total)) + "…";
      }
      out.push(text);
      total += text.length + 1;
      if (total >= MAX_ENTRY) { break; }
    }
    return out.join(" ");
  }

  function pushConsole(level, args) {
    state.consoleEntries.push({ seq: ++state.seq, level: level, text: formatArgs(args) });
    if (state.consoleEntries.length > MAX_CONSOLE) {
      state.consoleEntries.shift();
    }
  }

  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var original = window.console[level];
    if (typeof original !== "function") { return; }
    var bound = original.bind(window.console);
    window.console[level] = function () {
      try { pushConsole(level, Array.prototype.slice.call(arguments)); } catch (e) {}
      return bound.apply(window.console, arguments);
    };
  });

  // --- page errors --------------------------------------------------------
  function pushError(kind, message, detail) {
    state.pageErrors.push({
      seq: ++state.seq,
      kind: kind,
      message: String(message).slice(0, MAX_ENTRY),
      detail: detail ? String(detail).slice(0, MAX_ENTRY) : undefined
    });
    if (state.pageErrors.length > MAX_ERRORS) { state.pageErrors.shift(); }
  }

  window.addEventListener("error", function (e) {
    var source = e.filename ? e.filename + ":" + e.lineno : undefined;
    pushError("error", e.message || String(e.error || "window error"), source);
  });

  window.addEventListener("unhandledrejection", function (e) {
    var reason = e.reason;
    var detail;
    if (reason instanceof Error) {
      detail = reason.stack ? reason.stack.split("\n")[1] || undefined : undefined;
    }
    pushError(
      "unhandledrejection",
      reason instanceof Error ? reason.message || String(reason) : String(reason),
      detail
    );
  });

  // --- network (fetch/XHR; WebSockets intentionally excluded) -------------
  function networkStart() { state.network.active++; touch(); }
  function networkEnd() {
    state.network.active = Math.max(0, state.network.active - 1);
    state.network.completed++;
    touch();
  }
  function networkFail() {
    state.network.active = Math.max(0, state.network.active - 1);
    state.network.completed++;
    state.network.failed++;
    touch();
  }

  var originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function () {
      var promise = originalFetch.apply(this, arguments);
      networkStart();
      promise.then(
        function (response) {
          if (response && response.ok === false) { networkFail(); }
          else { networkEnd(); }
        },
        function () { networkFail(); }
      );
      return promise;
    };
  }

  var originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__lumiscaMeta = { method: method, url: String(url) }; } catch (e) {}
    return originalOpen.apply(this, arguments);
  };
  var originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    networkStart();
    xhr.addEventListener("loadend", function () {
      if (xhr.__lumiscaSettled) { return; }
      xhr.__lumiscaSettled = true;
      state.network.active = Math.max(0, state.network.active - 1);
      state.network.completed++;
      if (xhr.status >= 400) { state.network.failed++; }
      touch();
    });
    return originalSend.apply(this, arguments);
  };

  // --- DOM mutations ------------------------------------------------------
  if (typeof MutationObserver === "function") {
    var observer = new MutationObserver(function (records) {
      state.domMutations += records.length;
      trigger();
    });
    try {
      observer.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    } catch (e) { /* document not ready — skip mutation tracking */ }
  }

  // --- refs ----------------------------------------------------------------
  // Refs are stable per element while the document lives: the same element
  // keeps its ref across observations. A full page navigation re-numbers
  // (the probe restarts). Refs of removed elements are freed and may be
  // reused by later elements.
  var refCounter = 0;
  var elToRef = typeof WeakMap === "function" ? new WeakMap() : null;
  var refToEl = {};

  function refFor(el) {
    if (elToRef) {
      var existing = elToRef.get(el);
      if (existing) { return existing; }
    }
    var ref = "e" + (++refCounter);
    if (elToRef) { elToRef.set(el, ref); }
    refToEl[ref] = el;
    return ref;
  }

  function findRef(ref) {
    return refToEl[ref] || null;
  }

  function pruneRefs() {
    if (!elToRef) { return; }
    for (var key in refToEl) {
      var el = refToEl[key];
      if (!el || !el.isConnected) {
        delete refToEl[key];
        elToRef.delete(el);
      }
    }
  }

  // --- element collection ---------------------------------------------------
  var INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
    'summary',
    '[contenteditable="true"]', '[contenteditable=""]',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="searchbox"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="combobox"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="slider"]',
    '[role="spinbutton"]', '[role="heading"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(", ");
  var HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

  function isVisible(el) {
    if (el.hidden || (el.getAttribute && el.getAttribute("hidden") !== null)) {
      return false;
    }
    var rects = el.getClientRects ? el.getClientRects() : null;
    if (!rects || rects.length === 0) { return false; }
    var style = window.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" ||
        style.visibility === "collapse") {
      return false;
    }
    var rect = rects[0];
    return !(rect.width === 0 && rect.height === 0);
  }

  function impliedRole(el, tag) {
    if (tag === "a" || tag === "area") { return "link"; }
    if (tag === "button") { return "button"; }
    if (tag === "input") {
      var t = String(el.type || "text").toLowerCase();
      if (t === "checkbox") { return "checkbox"; }
      if (t === "radio") { return "radio"; }
      if (t === "button" || t === "submit" || t === "reset" || t === "image") {
        return "button";
      }
      if (t === "range") { return "slider"; }
      if (t === "number") { return "spinbutton"; }
      if (t === "search") { return "searchbox"; }
      return "textbox";
    }
    if (tag === "textarea") { return "textbox"; }
    if (tag === "select") { return "combobox"; }
    if (tag === "summary") { return "button"; }
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" ||
        tag === "h5" || tag === "h6") {
      return "heading";
    }
    return "generic";
  }

  function textOf(el) {
    var text = (el.innerText || el.textContent || "").replace(/\s+/g, " ");
    return text.trim();
  }

  function bound(text, max) {
    text = String(text);
    return text.length > max ? text.slice(0, max) + "…" : text;
  }

  function accessibleName(el) {
    var aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) { return bound(aria.trim(), MAX_ELEMENT_NAME); }
    var labelledby = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledby) {
      var parts = [];
      labelledby.split(/\s+/).forEach(function (id) {
        var ref = document.getElementById(id);
        if (ref) {
          var t = textOf(ref);
          if (t) { parts.push(t); }
        }
      });
      if (parts.length) { return bound(parts.join(" "), MAX_ELEMENT_NAME); }
    }
    if (typeof el.labels === "object" && el.labels !== null && el.labels.length) {
      var labelText = textOf(el.labels[0]);
      if (labelText) { return bound(labelText, MAX_ELEMENT_NAME); }
    }
    var title = el.getAttribute && el.getAttribute("title");
    if (title && title.trim()) { return bound(title.trim(), MAX_ELEMENT_NAME); }
    var alt = el.getAttribute && el.getAttribute("alt");
    if (alt && alt.trim()) { return bound(alt.trim(), MAX_ELEMENT_NAME); }
    var placeholder = el.getAttribute && el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) {
      return bound(placeholder.trim(), MAX_ELEMENT_NAME);
    }
    var text = textOf(el);
    return text ? bound(text, MAX_ELEMENT_NAME) : "";
  }

  function elementInfo(el) {
    var tag = el.tagName.toLowerCase();
    var explicit = el.getAttribute && el.getAttribute("role");
    var role = explicit || impliedRole(el, tag);
    var info = {
      ref: refFor(el),
      tag: tag,
      role: role,
      name: accessibleName(el),
      disabled: !!el.disabled || (el.getAttribute && el.getAttribute("aria-disabled") === "true"),
      visible: isVisible(el)
    };
    if (role === "heading") {
      var level = parseInt(
        (el.getAttribute && el.getAttribute("aria-level")) || (tag.length > 1 ? tag.charAt(1) : ""),
        10
      );
      if (!isNaN(level)) { info.headingLevel = level; }
    }
    if (tag === "a") {
      var href = el.getAttribute("href");
      if (href !== null) { info.href = href; }
    }
    if (role === "textbox" || role === "searchbox" || role === "combobox" ||
        role === "spinbutton" || tag === "textarea") {
      var t = tag === "textarea" ? "textarea" : String(el.type || "text");
      info.inputType = t;
      var v = el.value;
      if (typeof v === "string") { info.value = bound(v, MAX_VALUE); }
    }
    if (role === "checkbox" || role === "radio" || role === "switch") {
      info.checked = !!el.checked;
    }
    if (tag === "button" || role === "button" || tag === "a" || role === "link" ||
        tag === "summary") {
      var t2 = textOf(el);
      if (t2) { info.text = bound(t2, MAX_ELEMENT_TEXT); }
    }
    if (document.activeElement === el) { info.focused = true; }
    return info;
  }

  function collectElements() {
    var root = document.documentElement || document;
    if (!root || typeof root.querySelectorAll !== "function") { return []; }
    var nodes = root.querySelectorAll(INTERACTIVE_SELECTOR + ", " + HEADING_SELECTOR);
    var out = [];
    for (var i = 0; i < nodes.length && out.length < MAX_ELEMENTS; i++) {
      out.push(elementInfo(nodes[i]));
    }
    pruneRefs();
    return out;
  }

  function digestText() {
    var body = document.body;
    if (!body || typeof body.innerText !== "string") { return ""; }
    var lines = body.innerText.split("\n");
    var out = [];
    var total = 0;
    for (var i = 0; i < lines.length && total < MAX_TEXT; i++) {
      var line = lines[i].replace(/\s+/g, " ").trim();
      if (line.length < 2) { continue; }
      if (/^[\W_]+$/.test(line)) { continue; }
      if (out.length > 0 && line === out[out.length - 1]) { continue; }
      out.push(line);
      total += line.length + 1;
    }
    return out.join("\n").slice(0, MAX_TEXT);
  }

  function snapshot(opts) {
    var includeText = !opts || opts.includeText !== false;
    var truncated = [];
    var consoleOut = [];
    var errorOut = [];
    var sawConsoleCut = false;
    var sawErrorCut = false;
    for (var i = 0; i < state.consoleEntries.length; i++) {
      var entry = state.consoleEntries[i];
      if (entry.seq <= state.servedSeq) { continue; }
      if (consoleOut.length >= MAX_PULL_CONSOLE) {
        if (!sawConsoleCut) { truncated.push("console"); sawConsoleCut = true; }
        continue;
      }
      consoleOut.push({ level: entry.level, text: entry.text });
    }
    for (var j = 0; j < state.pageErrors.length; j++) {
      var err = state.pageErrors[j];
      if (err.seq <= state.servedSeq) { continue; }
      if (errorOut.length >= MAX_PULL_ERRORS) {
        if (!sawErrorCut) { truncated.push("errors"); sawErrorCut = true; }
        continue;
      }
      errorOut.push({ kind: err.kind, message: err.message, detail: err.detail });
    }
    state.servedSeq = state.seq;
    var pageText = includeText ? digestText() : "";
    var textCut = false;
    if (includeText && pageText.length > MAX_TEXT) {
      pageText = pageText.slice(0, MAX_TEXT);
      textCut = true;
    }
    var lastActivity = state.network.lastActivity;
    var elements = collectElements();
    var elementCut = elements.length >= MAX_ELEMENTS;
    var mutated = state.domMutations > state.observedMutations;
    state.observedMutations = state.domMutations;
    if (textCut) { truncated.push("pageText"); }
    if (elementCut) { truncated.push("elements"); }
    return {
      ok: true,
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
      elements: elements,
      pageText: pageText,
      console: consoleOut,
      errors: errorOut,
      network: {
        active: state.network.active,
        completed: state.network.completed,
        failed: state.network.failed,
        idleMs: lastActivity === null ? null : Date.now() - lastActivity
      },
      mutated: mutated,
      truncated: truncated
    };
  }

  // --- actions --------------------------------------------------------------
  function setValue(el, value) {
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    var proto = null;
    if (tag === "textarea" && window.HTMLTextAreaElement) {
      proto = window.HTMLTextAreaElement.prototype;
    } else if (tag === "select" && window.HTMLSelectElement) {
      proto = window.HTMLSelectElement.prototype;
    } else if (window.HTMLInputElement) {
      proto = window.HTMLInputElement.prototype;
    }
    var set = false;
    if (proto) {
      var descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, value);
        set = true;
      }
    }
    if (!set) { el.value = value; }
    // React tracks the value through a native-setter bypass; dispatching
    // input (bubbles) after a native write is how React sees the change.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setChecked(el, checked) {
    var current = !!el.checked;
    if (current === checked) { return; }
    if (typeof el.click === "function") {
      // Native click toggles the state and fires input/change — React
      // observes both, and the browser keeps the checked attribute in sync.
      el.click();
      return;
    }
    el.checked = checked;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function dispatchKey(el, type, key) {
    var event = null;
    try {
      event = new KeyboardEvent(type, {
        key: key,
        code: key,
        bubbles: true,
        cancelable: true,
        composed: true
      });
    } catch (e) { event = null; }
    if (event) { el.dispatchEvent(event); }
  }

  function act(action) {
    try {
      var kind = action.kind;
      if (kind === "reload") {
        location.reload();
        return { ok: true, url: location.href };
      }
      if (kind === "scroll") {
        if (action.ref) {
          var scEl = findRef(action.ref);
          if (!scEl) {
            return { ok: false, code: "ref_not_found", error: "ref not found: " + action.ref };
          }
          scEl.scrollIntoView({ block: "center" });
          return { ok: true };
        }
        if (typeof action.x === "number" || typeof action.y === "number") {
          window.scrollTo(action.x || 0, action.y || 0);
          return { ok: true };
        }
        return { ok: false, code: "invalid", error: "scroll には ref か x/y が必要です" };
      }
      var el = action.ref ? findRef(action.ref) : null;
      if (action.ref && !el) {
        return { ok: false, code: "ref_not_found", error: "ref not found: " + action.ref };
      }
      var target = el || document.activeElement || document.body;
      switch (kind) {
        case "click":
          try { target.focus({ preventScroll: true }); } catch (e) {}
          target.click();
          break;
        case "fill":
        case "type": {
          var current = target.value != null ? String(target.value) : "";
          var next = kind === "fill" ? action.value : current + action.value;
          setValue(target, next);
          break;
        }
        case "press":
          dispatchKey(target, "keydown", action.key);
          dispatchKey(target, "keyup", action.key);
          // Synthetic keys never trigger default actions — Enter on a form
          // is the one case worth synthesizing (form submission).
          if (action.key === "Enter" && target.form &&
              typeof target.form.requestSubmit === "function") {
            target.form.requestSubmit();
          }
          break;
        case "select":
          setValue(target, action.value);
          break;
        case "check":
          setChecked(target, true);
          break;
        case "uncheck":
          setChecked(target, false);
          break;
        default:
          return { ok: false, code: "invalid", error: "unknown action kind: " + kind };
      }
      return { ok: true, element: elementInfo(target) };
    } catch (e) {
      return {
        ok: false,
        code: "action_failed",
        error: String((e && (e.message || e)) || e)
      };
    }
  }

  // --- wait -----------------------------------------------------------------
  // wait() resolves a promise in-page. Windows (WebView2) and macOS
  // (WKWebView) evals await promises; WebKitGTK does not — on that
  // platform the host reports an explicit "wait_unsupported" error
  // instead of falling back to polling.
  function waitCheck(opts) {
    var now = Date.now();
    if (state.waitStarted === 0) { state.waitStarted = now; }
    var duration = now - state.waitStarted;
    function done(reason, detail) {
      state.waitStarted = 0;
      return { ok: reason !== "timeout", reason: reason, durationMs: duration, detail: detail };
    }
    function pending() { return { pending: true }; }
    var until = opts.until || "load";
    var timeoutMs = Math.max(1, opts.timeoutMs || 10000);
    if (until === "time") {
      if (duration >= Math.max(0, opts.durationMs || 0)) { return done("time"); }
      return pending();
    }
    if (until === "load") {
      if (document.readyState === "complete") { return done("loaded"); }
    } else if (until === "idle") {
      if (state.network.active === 0 &&
          (state.network.lastActivity === null ||
           now - state.network.lastActivity >= (opts.idleMs || 500))) {
        return done("idle");
      }
    } else if (until === "url") {
      if (opts.urlContains && location.href.indexOf(opts.urlContains) !== -1) {
        return done("url", location.href);
      }
    }
    if (duration >= timeoutMs) { return done("timeout"); }
    return pending();
  }

  function wait(opts) {
    state.waitStarted = 0;
    return new Promise(function (resolve) {
      opts = opts || {};
      if (opts.until === "time") {
        var duration = Math.min(Math.max(0, opts.durationMs || 1000),
          Math.max(1, opts.timeoutMs || 10000));
        setTimeout(function () {
          state.waitStarted = 0;
          resolve({ ok: true, reason: "time", durationMs: duration });
        }, duration);
        return;
      }
      var settled = false;
      var timer = null;
      function cleanup() {
        var index = state.checkCallbacks.indexOf(check);
        if (index !== -1) { state.checkCallbacks.splice(index, 1); }
        document.removeEventListener("readystatechange", check);
        if (timer !== null) { clearInterval(timer); }
      }
      function finish() {
        if (settled) { return; }
        settled = true;
        cleanup();
        var r = waitCheck(opts);
        resolve({ ok: r.ok, reason: r.reason, durationMs: r.durationMs, detail: r.detail });
      }
      function check() {
        if (settled) { return; }
        var r = waitCheck(opts);
        if (!r.pending) { finish(); }
      }
      state.checkCallbacks.push(check);
      document.addEventListener("readystatechange", check);
      // Event-driven triggers (mutations, network, readyState) are the
      // primary path; this tick covers conditions that change without any
      // DOM or network event (e.g. a hash-only URL change). Cleaned up on
      // settle — never runs past the wait.
      timer = setInterval(check, 500);
      check();
    });
  }

  // --- install ---------------------------------------------------------------
  window.__lumiscaProbe = { snapshot: snapshot, act: act, wait: wait };
})();
`;
/* LUMISCA-PROBE-END */
