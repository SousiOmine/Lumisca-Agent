import { assert, assertEquals } from "@std/assert";
import { friendlyLoginError, LoginSession } from "./login.ts";
import type { AuthInteraction } from "@lumisca/core";
import type { ProviderLoginSnapshot } from "@lumisca/core";

function create(
  script: (interaction: AuthInteraction) => Promise<void> | void,
  method: "browser" | "device_code" = "device_code",
) {
  const session = new LoginSession(
    "openai-codex",
    method,
    async (interaction) => {
      await script(interaction);
    },
    () => {},
  );
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

Deno.test("LoginSession carries the chosen method to the flow", async () => {
  let seen: "browser" | "device_code" | undefined;
  const { session, wait } = create((interaction) => {
    seen = interaction.method;
    interaction.notify({
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
    });
  }, "browser");
  try {
    await wait("done");
    assertEquals(seen, "browser");
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

Deno.test("LoginSession forwards even a device-code-looking select prompt", async () => {
  const { session, wait } = create(async (interaction) => {
    const picked = await interaction.prompt({
      type: "select",
      message: "Pick one:",
      options: [
        { id: "browser", label: "Browser login (default)" },
        { id: "device_code", label: "Device code login (headless)" },
      ],
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
    assert(session.respond(promptId, "browser"));
    // Re-responding the same id must fail.
    assert(!session.respond(promptId, "x"));
    await wait("done");
    assertEquals(session.snapshot().events, [{
      type: "progress",
      message: "chose browser",
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
    "認証元の利用制限（レートリミット）またはアクセス検証により、ログインできませんでした。" +
    "時間をおいて再度お試しください。";
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
