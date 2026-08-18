import { assert, assertEquals } from "@std/assert";
import { friendlyLoginError, LoginSession } from "./login.ts";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { ProviderLoginSnapshot } from "@lumisca/core";

function create(script: (interaction: AuthInteraction) => Promise<void>) {
  const session = new LoginSession("openai-codex", script, () => {});
  const wait = (status: string, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (session.snapshot().status === status) return resolve();
        if (Date.now() > deadline) {
          reject(new Error(`timed out waiting for ${status}`));
          return;
        }
        setTimeout(check, 5);
      };
      check();
    });
  };
  return { session, wait };
}

Deno.test("LoginSession auto-selects the device-code method and records its event", async () => {
  const { session, wait } = create(async (interaction) => {
    const method = await interaction.prompt({
      type: "select",
      message: "Select login method:",
      options: [
        { id: "browser", label: "Browser login (default)" },
        { id: "device_code", label: "Device code login (headless)" },
      ],
    });
    assertEquals(method, "device_code");
    interaction.notify({
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
    });
  });
  try {
    await wait("done");
    const snap = session.snapshot();
    assertEquals(snap.status, "done");
    assertEquals(snap.events, [{
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
    }]);
    assertEquals(snap.prompt, undefined);
  } finally {
    session.dispose();
  }
});

Deno.test("LoginSession forwards a non-device prompt and resolves via respond", async () => {
  const { session, wait } = create(async (interaction) => {
    const picked = await interaction.prompt({
      type: "select",
      message: "Pick one:",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    });
    interaction.notify({ type: "progress", message: `chose ${picked}` });
  });
  try {
    let snap: ProviderLoginSnapshot;
    const deadline = Date.now() + 2000;
    do {
      snap = session.snapshot();
      if (snap.prompt !== undefined) break;
      await new Promise((r) => setTimeout(r, 5));
    } while (Date.now() < deadline);
    assert(snap.prompt, "expected a forwarded prompt");
    assertEquals(snap.prompt.type, "select");
    const promptId = snap.prompt.id;
    assert(session.respond(promptId, "b"));
    // Re-responding the same id must fail.
    assert(!session.respond(promptId, "x"));
    await wait("done");
    assertEquals(session.snapshot().events, [{
      type: "progress",
      message: "chose b",
    }]);
  } finally {
    session.dispose();
  }
});

Deno.test("LoginSession cancel aborts a pending prompt as cancelled", async () => {
  const completed: string[] = [];
  const { session, wait } = create(async (interaction) => {
    await interaction.prompt({ type: "manual_code", message: "paste code" });
    completed.push("never");
  });
  try {
    let snap: ProviderLoginSnapshot;
    const deadline = Date.now() + 2000;
    do {
      snap = session.snapshot();
      if (snap.prompt !== undefined) break;
      await new Promise((r) => setTimeout(r, 5));
    } while (Date.now() < deadline);
    assertEquals(snap.prompt?.type, "manual_code");
    session.cancel();
    await wait("cancelled");
    assertEquals(completed.length, 0);
  } finally {
    session.dispose();
  }
});

Deno.test("LoginSession surfaces a failing flow as error", async () => {
  const { session, wait } = create(() => {
    throw new Error("token exchange failed");
  });
  try {
    await wait("error");
    const snap = session.snapshot();
    assertEquals(snap.status, "error");
    assertEquals(snap.error, "token exchange failed");
  } finally {
    session.dispose();
  }
});

Deno.test("consumeDone reports completion exactly once", async () => {
  const { session, wait } = create(async () => {});
  try {
    await wait("done");
    assert(session.consumeDone());
    assert(!session.consumeDone());
  } finally {
    session.dispose();
  }
});

Deno.test("friendlyLoginError rewrites OpenAI-side throttling, keeps others", () => {
  const friendly =
    "OpenAI側のレート制限またはBot検出により、認証に失敗しました。";
  assertEquals(
    friendlyLoginError(
      "OpenAI Codex device auth failed with status 429: " +
        "<!DOCTYPE html>...Just a moment...",
    ),
    friendly,
  );
  assertEquals(
    friendlyLoginError(
      "OpenAI Codex token refresh failed (403): invalid_grant",
    ),
    "OpenAI Codex token refresh failed (403): invalid_grant",
  );
});
