// Splash page shown while the desktop shell connects to a server: the local
// one, or the remote server the shell remembered from the last run. The
// shell navigates the window to that server once it answers, so this script
// only surfaces a startup failure — with the buttons that lead out of it.
// Polling stops implicitly when the page is navigated away.
//
// Bridge base URL for the shell's actions. The document is the app's own
// splash (served by Tauri, not by a server), and the shell injects the
// listener's origin as an initialization script
// (src/lib.rs, create_main_window): WebView2 re-homes custom schemes, but
// WKWebView refuses to fetch them at all, so a fixed `lumisca://` URL
// worked on Windows only.
const BRIDGE = globalThis.__LUMISCA_BRIDGE__;
const statusEl = document.getElementById("status");

/** Whether the shell remembers a remote server (reported by `state`):
 * decides whether a failure offers "retry that server" or only the local
 * one. */
let savedRemote = false;

// Window controls for the undecorated window (custom title bar above).
// The page has no Tauri IPC, so dragging goes through the bridge (the
// native `data-tauri-drag-region` path cannot work here).
const titlebar = document.getElementById("titlebar");
const minBtn = document.getElementById("btn-min");
const maxBtn = document.getElementById("btn-max");
const closeBtn = document.getElementById("btn-close");
const maxIcon = document.getElementById("icon-max");
const restoreIcon = document.getElementById("icon-restore");

function windowAction(action) {
  // No key is needed: while the splash is displayed no server token
  // exists yet, so the bridge key gate is open. The page is navigated
  // away as soon as the token is armed.
  fetch(`${BRIDGE}/window/${action}`).catch(() => {});
}

minBtn.addEventListener("click", () => windowAction("minimize"));
maxBtn.addEventListener("click", () => windowAction("toggle-maximize"));
closeBtn.addEventListener("click", () => windowAction("close"));

/** Whether the OS draws the window chrome (macOS). Set from the bridge
 * state once the shell answers; false until then (Windows and Linux draw
 * their own controls). */
let nativeChrome = false;

/** macOS keeps the OS title bar (tauri.macos.conf.json), so the native
 * traffic lights are already there: a drawn set would be a second one with
 * a different look. The strip moves right of them instead, and the system
 * owns dragging and the double-click zoom. */
function applyPlatform(platform) {
  if (platform !== "macos" || nativeChrome) return;
  nativeChrome = true;
  titlebar.classList.add("titled");
  for (const control of titlebar.querySelectorAll("[data-window-control]")) {
    control.hidden = true;
  }
}

// Drag the window from anywhere on the title bar except the buttons;
// double-click toggles maximize. On macOS the system title bar already
// does both.
titlebar.addEventListener("mousedown", (e) => {
  if (nativeChrome || e.button !== 0 || e.target.closest("button")) return;
  e.preventDefault();
  windowAction("start-drag");
});
titlebar.addEventListener("dblclick", (e) => {
  if (nativeChrome || e.target.closest("button")) return;
  windowAction("toggle-maximize");
});

function setMaximized(maximized) {
  maxIcon.classList.toggle("hidden", maximized);
  restoreIcon.classList.toggle("hidden", !maximized);
  maxBtn.title = maximized ? "元のサイズに戻す" : "最大化";
}

async function poll() {
  try {
    const res = await fetch(`${BRIDGE}/state`);
    const body = await res.json().catch(() => null);
    // A 401 means a server is already displayed (the key gate is armed)
    // and the shell is about to navigate: keep waiting.
    if (res.ok && body) {
      setMaximized(!!body.maximized);
      applyPlatform(body.platform);
      savedRemote = !!body.saved;
      if (body.status === "error") {
        // The local server itself failed to start. A remembered remote
        // server is still an alternative worth offering.
        showFailure(
          body.error ?? "サーバーを起動できませんでした",
          savedRemote,
        );
        return;
      }
      if (body.status === "remote-unreachable") {
        // The remembered server is off, off the tailnet, or at a wrong
        // address. Offer the two ways out instead of a dead splash.
        showFailure(body.error ?? "接続先サーバーに接続できませんでした", true);
        return;
      }
    }
  } catch {
    // Bridge not reachable yet — keep waiting.
  }
  setTimeout(poll, 150);
}

/** Startup failed: stop polling (only a button below starts a new attempt)
 * and show the buttons that lead out. `saved` adds "retry the remembered
 * server"; without one there is nothing to retry, and the local server is
 * the only way out. */
function showFailure(message, saved) {
  statusEl.textContent = message;
  statusEl.classList.add("error");
  const spinner = document.getElementById("spinner");
  if (spinner) spinner.style.display = "none";
  const actions = document.getElementById("actions");
  if (!actions) return;
  actions.replaceChildren();
  if (saved) {
    actions.append(button("再試行", () => retrySaved()));
    actions.append(button("ローカルサーバーを使う", () => useLocal(), true));
  } else {
    actions.append(button("再試行", () => useLocal(), true));
  }
  actions.classList.remove("hidden");
}

/** One button of the failure row. */
function button(label, onClick, primary) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = primary ? "btn primary" : "btn";
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

/** Disable the failure buttons while one of them is in flight, so a second
 * click cannot start a rival attempt. */
function setActionsBusy(busy) {
  for (const element of document.querySelectorAll("#actions button")) {
    element.disabled = busy;
  }
}

/** Retry the remembered server. Success navigates the window; a failure
 * re-renders the same splash with the shell's new message. */
async function retrySaved() {
  statusEl.textContent = "再接続しています…";
  statusEl.classList.remove("error");
  setActionsBusy(true);
  try {
    const res = await fetch(`${BRIDGE}/connect-saved`);
    const body = await res.json().catch(() => null);
    setActionsBusy(false);
    if (!res.ok) {
      showFailure(body?.error ?? "接続先サーバーに接続できませんでした", true);
    }
    // Success navigates the whole window to the server.
  } catch {
    setActionsBusy(false);
    showFailure("接続先サーバーに接続できませんでした", true);
  }
}

/** Switch to the local server, starting it if needed. The shell remembers
 * this choice, so the next launch starts locally too. */
async function useLocal() {
  statusEl.textContent = "ローカルサーバーを起動しています…";
  statusEl.classList.remove("error");
  setActionsBusy(true);
  const spinner = document.getElementById("spinner");
  if (spinner) spinner.style.display = "";
  try {
    const res = await fetch(`${BRIDGE}/connect-local`);
    const body = await res.json().catch(() => null);
    // A failed local start leaves both buttons usable: the remembered
    // server may be back by now.
    setActionsBusy(false);
    if (!res.ok) {
      showFailure(body?.error ?? "サーバーを起動できませんでした", savedRemote);
    }
    // Success navigates the whole window to the local server.
  } catch {
    setActionsBusy(false);
    showFailure("サーバーを起動できませんでした", savedRemote);
  }
}

poll();
