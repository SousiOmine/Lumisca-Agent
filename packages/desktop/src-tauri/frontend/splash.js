// Splash page shown while the desktop shell starts the bundled server.
// The shell navigates the window to the server page once it is ready, so
// this script only surfaces a startup failure. Polling stops implicitly
// when the page is navigated away.
const BRIDGE = "http://lumisca.localhost/shell";
const statusEl = document.getElementById("status");

async function poll() {
  let message = null;
  try {
    const res = await fetch(`${BRIDGE}/state`);
    const body = await res.json().catch(() => null);
    // A 401 means the local server is up (the key gate is armed) and the
    // shell is about to navigate: keep waiting.
    if (res.ok && body && body.status === "error") {
      message = body.error ?? "サーバーを起動できませんでした";
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
