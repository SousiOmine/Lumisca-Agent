/**
 * The ChatGPT subscription provider: Sign in with ChatGPT, token refresh,
 * and the model catalog the signed-in account can use.
 *
 * The models speak the public Responses API with the OAuth access token;
 * the request shape that flow requires (instructions, store:false, no
 * max_output_tokens) travels on every model's `compat` entry (see
 * request.ts), which the transport reads.
 */

import type {
  AuthInteraction,
  Credential,
  CredentialStore,
  Model,
  OAuthCredential,
  Provider,
} from "../../ai/catalog.ts";
import type { Api } from "../../domain/model.ts";

import { errorMessage } from "../../errors.ts";
import type { SettingsRepo } from "../../settings/repo.ts";
import {
  CHATGPT_PROVIDER_ID,
  fetchChatGptModels,
  readChatGptModels,
  saveChatGptModels,
} from "./catalog.ts";
import type { FetchLike } from "./http.ts";
import {
  CHATGPT_API_BASE,
  CHATGPT_PLAN_SCOPE,
  CHATGPT_REFRESH_MARGIN_MS,
  type ChatGptExistingRegistration,
  type ChatGptLoginOptions,
  type ChatGptLoginResult,
  expiresAtFor,
  getOrCreateHostId,
  loginWithBrowser,
  refreshChatGptToken,
  revokeChatGptToken,
  splitScopes,
} from "./oauth.ts";

/** Display name of the provider in settings and pickers. */
export const CHATGPT_PROVIDER_NAME = "ChatGPT";

/** The login function, injectable so tests never open a browser. */
export type ChatGptLoginFn = (
  interaction: AuthInteraction,
  options: ChatGptLoginOptions,
) => Promise<ChatGptLoginResult>;

/** What the provider needs from its host. */
export interface ChatGptProviderDeps {
  credentials: CredentialStore;
  settings: SettingsRepo;
  /** HTTP client; injectable so tests never touch the network. */
  fetch?: FetchLike;
  /** Browser sign-in; injectable so tests can answer the callback. */
  login?: ChatGptLoginFn;
}

/** A stored credential that names its registration (refresh refuses one
 * without). */
interface ChatGptCredential extends OAuthCredential {
  clientId: string;
}

/** Build the provider. The model list is loaded once here and replaced
 * after a login; a restart reads the same list back from settings. */
export function chatgptProvider(deps: ChatGptProviderDeps): Provider {
  const fetchImpl: FetchLike =
    deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const loginImpl = deps.login ?? loginWithBrowser;
  let models: readonly Model<Api>[] = readChatGptModels(deps.settings);
  let pendingRefresh: Promise<ChatGptCredential> | undefined;

  /** The credential with a valid access token, refreshing it when it is
   * about to expire. Concurrent callers share one refresh: the token
   * endpoint rotates the refresh token, so a second exchange could
   * invalidate the first. */
  function validCredential(
    credential: ChatGptCredential,
  ): Promise<ChatGptCredential> | ChatGptCredential {
    if (
      credential.expiresAt !== undefined &&
      credential.expiresAt > Date.now() + CHATGPT_REFRESH_MARGIN_MS
    ) {
      return credential;
    }
    const refreshToken = credential.refreshToken;
    if (refreshToken === undefined) {
      throw new Error("the ChatGPT login has expired; sign in again");
    }
    pendingRefresh ??= refresh(credential, refreshToken).finally(() => {
      pendingRefresh = undefined;
    });
    return pendingRefresh;
  }

  async function refresh(
    credential: ChatGptCredential,
    refreshToken: string,
  ): Promise<ChatGptCredential> {
    const tokens = await refreshChatGptToken(fetchImpl, {
      clientId: credential.clientId,
      refreshToken,
    });
    const scopes =
      tokens.scope !== undefined
        ? splitScopes(tokens.scope)
        : (credential.scopes ?? []);
    if (!scopes.includes(CHATGPT_PLAN_SCOPE)) {
      throw new Error(
        "the ChatGPT plan permission was not granted; sign in again and allow it",
      );
    }
    const next: ChatGptCredential = {
      ...credential,
      type: "oauth",
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? credential.refreshToken,
      expiresAt: expiresAtFor(tokens),
      ...(tokens.idToken !== undefined ? { idToken: tokens.idToken } : {}),
      scopes,
    };
    await deps.credentials.modify(CHATGPT_PROVIDER_ID, (current) =>
      // A logout, or a re-login with another account, may have replaced the
      // credential while the refresh was in flight. That newer value wins:
      // writing this one would silently sign the user back in.
      current?.type === "oauth" && current.refreshToken === refreshToken
        ? Promise.resolve(next)
        : Promise.resolve(current),
    );
    return next;
  }

  async function login(interaction: AuthInteraction): Promise<Credential> {
    const method = interaction.method;
    if (method === undefined) {
      throw new Error("the ChatGPT login needs a method (browser)");
    }
    if (method !== "browser") {
      throw new Error(`unknown ChatGPT login method: ${String(method)}`);
    }
    const stored = await deps.credentials.read(CHATGPT_PROVIDER_ID);
    const existing = existingRegistration(stored);
    const hostId = getOrCreateHostId(deps.settings);
    const result = await loginImpl(interaction, {
      fetch: fetchImpl,
      hostId,
      ...(existing !== undefined ? { existing } : {}),
    });
    if (!result.scopes.includes(CHATGPT_PLAN_SCOPE)) {
      throw new Error(
        "ChatGPTプランの利用が許可されませんでした。もう一度ログインし、プランの利用を許可してください。",
      );
    }
    const credential = credentialFrom(result);
    // List models before returning. The caller stores the credential only
    // after this resolves, so a login that cannot list models leaves no
    // half-configured provider behind.
    models = await fetchChatGptModels(
      fetchImpl,
      { token: credential.token },
      interaction.signal,
    );
    saveChatGptModels(deps.settings, models);
    return credential;
  }

  async function logout(
    credential: OAuthCredential | undefined,
  ): Promise<string | undefined> {
    if (
      credential?.type !== "oauth" ||
      credential.clientId === undefined ||
      credential.refreshToken === undefined
    ) {
      return undefined;
    }
    try {
      await revokeChatGptToken(fetchImpl, {
        clientId: credential.clientId,
        refreshToken: credential.refreshToken,
      });
      return undefined;
    } catch (error) {
      return `ChatGPT側のセッション失効を確認できませんでした: ${errorMessage(
        error,
      )}`;
    }
  }

  return {
    id: CHATGPT_PROVIDER_ID,
    name: CHATGPT_PROVIDER_NAME,
    baseUrl: CHATGPT_API_BASE,
    auth: {
      oauth: {
        name: CHATGPT_PROVIDER_NAME,
        methods: ["browser"],
        login,
        logout,
      },
    },
    getModels: () => models,
    resolveCredential: async ({ credential }) => {
      if (credential?.type !== "oauth") return undefined;
      const current = asChatGptCredential(credential);
      const valid = await validCredential(current);
      return {
        auth: { apiKey: valid.token },
        source: "OAuth",
      };
    },
  };
}

/** Turn a completed login into the credential stored under the provider. */
function credentialFrom(result: ChatGptLoginResult): ChatGptCredential {
  return {
    type: "oauth",
    token: result.tokens.accessToken,
    ...(result.tokens.refreshToken !== undefined
      ? { refreshToken: result.tokens.refreshToken }
      : {}),
    expiresAt: expiresAtFor(result.tokens),
    clientId: result.clientId,
    hostId: result.hostId,
    idToken: result.idToken,
    subject: result.identity.subject,
    ...(result.identity.email !== undefined
      ? { email: result.identity.email }
      : {}),
    scopes: result.scopes,
  };
}

/** The registration to reuse for a returning sign-in. A credential from
 * the old Codex flow carries no client ID and is not reusable: the user
 * signs in again through the new flow. */
function existingRegistration(
  credential: Credential | undefined,
): ChatGptExistingRegistration | undefined {
  if (
    credential?.type !== "oauth" ||
    credential.clientId === undefined ||
    credential.clientId.length === 0
  ) {
    return undefined;
  }
  return {
    clientId: credential.clientId,
    ...(credential.idToken !== undefined
      ? { idToken: credential.idToken }
      : {}),
    ...(credential.email !== undefined ? { email: credential.email } : {}),
  };
}

/** A stored credential from before this flow cannot be refreshed; say so
 * instead of sending a token the public API will reject. */
function asChatGptCredential(credential: OAuthCredential): ChatGptCredential {
  if (credential.clientId === undefined || credential.clientId.length === 0) {
    throw new Error(
      "このChatGPTのログインは古い方式です。設定からログアウトし、もう一度ログインしてください。",
    );
  }
  return { ...credential, clientId: credential.clientId };
}
