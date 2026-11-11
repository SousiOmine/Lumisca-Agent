import { assert, assertEquals, assertRejects } from "@std/assert";
import type { AuthInteraction, AuthNotice } from "../../ai/types.ts";
import type { FetchLike } from "./http.ts";
import {
  buildAuthorizeUrl,
  CHATGPT_AUTH_BASE,
  CHATGPT_CLIENT_ID,
  CHATGPT_DEVICE_CODE_LIFETIME_SECONDS,
  CHATGPT_DEVICE_VERIFICATION_URI,
  CHATGPT_ORIGINATOR,
  chatGptAccountId,
  expiresAtFor,
  loginWithDeviceCode,
  refreshChatGptToken,
} from "./oauth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jwt(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64(claims)}.signature`;
}

Deno.test("chatGptAccountId reads the nested and top-level claims", () => {
  assertEquals(
    chatGptAccountId(
      jwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-nested" },
      }),
    ),
    "acct-nested",
  );
  assertEquals(
    chatGptAccountId(jwt({ chatgpt_account_id: "acct-top" })),
    "acct-top",
  );
  assertEquals(chatGptAccountId("not-a-jwt"), undefined);
  assertEquals(chatGptAccountId(jwt({ exp: 1 })), undefined);
});

Deno.test("expiresAtFor prefers expires_in and falls back to exp", () => {
  assertEquals(
    expiresAtFor({ accessToken: "x", expiresIn: 60 }, 1_000),
    61_000,
  );
  const exp = 1_800_000_000;
  assertEquals(expiresAtFor({ accessToken: jwt({ exp }) }, 0), exp * 1000);
  assertThrowsMessage(
    () => expiresAtFor({ accessToken: "not-a-jwt" }, 0),
    "no expiry",
  );
});

Deno.test("the authorize URL carries the Codex client's parameters", () => {
  const url = new URL(
    buildAuthorizeUrl({
      state: "state-1",
      challenge: "challenge-1",
      redirectUri: "http://localhost:1455/auth/callback",
    }),
  );
  assertEquals(
    url.origin + url.pathname,
    `${CHATGPT_AUTH_BASE}/oauth/authorize`,
  );
  assertEquals(url.searchParams.get("response_type"), "code");
  assertEquals(url.searchParams.get("client_id"), CHATGPT_CLIENT_ID);
  assertEquals(
    url.searchParams.get("redirect_uri"),
    "http://localhost:1455/auth/callback",
  );
  assertEquals(
    url.searchParams.get("scope"),
    "openid profile email offline_access",
  );
  assertEquals(url.searchParams.get("code_challenge"), "challenge-1");
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertEquals(url.searchParams.get("id_token_add_organizations"), "true");
  assertEquals(url.searchParams.get("codex_cli_simplified_flow"), "true");
  assertEquals(url.searchParams.get("state"), "state-1");
  assertEquals(url.searchParams.get("originator"), CHATGPT_ORIGINATOR);
});

Deno.test("device login polls through pending and exchanges the code", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let polls = 0;
  const fetchImpl: FetchLike = (input, init) => {
    const url = String(input);
    requests.push({ url, ...(init !== undefined ? { init } : {}) });
    if (url === `${CHATGPT_AUTH_BASE}/api/accounts/deviceauth/usercode`) {
      return Promise.resolve(
        json({
          device_auth_id: "dev_1",
          user_code: "ABCD-EFGH",
          interval: 0.001,
        }),
      );
    }
    if (url === `${CHATGPT_AUTH_BASE}/api/accounts/deviceauth/token`) {
      polls += 1;
      if (polls < 3) return Promise.resolve(new Response("", { status: 403 }));
      return Promise.resolve(
        json({
          authorization_code: "code_1",
          code_verifier: "verifier_1",
        }),
      );
    }
    if (url === `${CHATGPT_AUTH_BASE}/oauth/token`) {
      return Promise.resolve(
        json({
          access_token: jwt({
            "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
            exp: 1_800_000_000,
          }),
          refresh_token: "refresh_1",
          id_token: jwt({ "https://api.openai.com/auth": {} }),
          expires_in: 3600,
        }),
      );
    }
    return Promise.reject(new Error(`unexpected request: ${url}`));
  };
  const events: AuthNotice[] = [];
  const interaction: AuthInteraction = {
    signal: new AbortController().signal,
    method: "device_code",
    prompt: () => Promise.reject(new Error("unexpected prompt")),
    notify: (event) => events.push(event),
  };

  const tokens = await loginWithDeviceCode(interaction, fetchImpl);

  assertEquals(polls, 3);
  assertEquals(events, [
    {
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: CHATGPT_DEVICE_VERIFICATION_URI,
      intervalSeconds: 0.001,
      expiresInSeconds: CHATGPT_DEVICE_CODE_LIFETIME_SECONDS,
    },
  ]);
  assertEquals(tokens.refreshToken, "refresh_1");
  assertEquals(tokens.expiresIn, 3600);
  assert(chatGptAccountId(tokens.accessToken) === "acct_1");

  const exchange = requests.find(
    (request) => request.url === `${CHATGPT_AUTH_BASE}/oauth/token`,
  )!;
  const form = exchange.init?.body as URLSearchParams;
  assertEquals(form.get("grant_type"), "authorization_code");
  assertEquals(form.get("client_id"), CHATGPT_CLIENT_ID);
  assertEquals(form.get("code"), "code_1");
  assertEquals(form.get("code_verifier"), "verifier_1");
  assertEquals(
    form.get("redirect_uri"),
    `${CHATGPT_AUTH_BASE}/deviceauth/callback`,
  );
});

Deno.test("device login explains a disabled device flow", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(new Response("not found", { status: 404 }));
  const interaction: AuthInteraction = {
    signal: new AbortController().signal,
    method: "device_code",
    prompt: () => Promise.reject(new Error("unexpected prompt")),
    notify: () => {},
  };
  const error = await assertRejects(
    () => loginWithDeviceCode(interaction, fetchImpl),
    Error,
  );
  assert(error.message.includes("not enabled"));
});

Deno.test("refresh sends the refresh grant", async () => {
  let form: URLSearchParams | undefined;
  const fetchImpl: FetchLike = (_input, init) => {
    form = init?.body as URLSearchParams;
    return Promise.resolve(
      json({
        access_token: jwt({ exp: 1_800_000_000 }),
        expires_in: 60,
      }),
    );
  };
  const tokens = await refreshChatGptToken(fetchImpl, "refresh_1");
  assertEquals(form?.get("grant_type"), "refresh_token");
  assertEquals(form?.get("refresh_token"), "refresh_1");
  assertEquals(form?.get("client_id"), CHATGPT_CLIENT_ID);
  assertEquals(tokens.expiresIn, 60);
  assertEquals(tokens.refreshToken, undefined);
});

function assertThrowsMessage(fn: () => unknown, part: string): void {
  try {
    fn();
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes(part));
    return;
  }
  throw new Error("expected a throw");
}
