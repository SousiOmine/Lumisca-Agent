// Splash page shown while the desktop shell starts the bundled server.
// The shell navigates the window to the server page once it is ready, so
// this script only surfaces a startup failure. Polling stops implicitly
// when the page is navigated away.
//
// Bridge base URL (the `lumisca://` custom protocol): WebView2 (Windows)
// cannot fetch custom schemes, so wry re-homes it to
// `http://<scheme>.localhost`; WKWebView (macOS) and WebKitGTK (Linux)
// fetch the `lumisca://` scheme directly. The platform is detected from
// the user agent; in a plain browser neither URL resolves and the window
// controls simply do nothing.
const BRIDGE = /Windows/i.test(navigator.userAgent)
  ? "http://lumisca.localhost/shell"
  : "lumisca://lumisca.localhost/shell";
const statusEl = document.getElementById("status");

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

// Drag the window from anywhere on the title bar except the buttons;
// double-click toggles maximize.
titlebar.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.target.closest("button")) return;
  e.preventDefault();
  windowAction("start-drag");
});
titlebar.addEventListener("dblclick", (e) => {
  if (e.target.closest("button")) return;
  windowAction("toggle-maximize");
});

function setMaximized(maximized) {
  maxIcon.classList.toggle("hidden", maximized);
  restoreIcon.classList.toggle("hidden", !maximized);
  maxBtn.title = maximized ? "元に戻す" : "最大化";
}

async function poll() {
  let message = null;
  try {
    const res = await fetch(`${BRIDGE}/state`);
    const body = await res.json().catch(() => null);
    // A 401 means the local server is up (the key gate is armed) and the
    // shell is about to navigate: keep waiting.
    if (res.ok && body) {
      setMaximized(!!body.maximized);
      if (body.status === "error") {
        message = body.error ?? "サーバーを起動できませんでした";
      }
    }
  } catch {
    // Bridge not reachable yet — keep waiting.
  }
  if (message) {
    statusEl.textContent = message;
    statusEl.classList.add("error");
    const spinner = document.getElementById("spinner");
    if (spinner) spinner.style.display = "none";
    return;
  }
  setTimeout(poll, 150);
}

poll();
