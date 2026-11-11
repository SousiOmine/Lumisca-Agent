/**
 * The ChatGPT subscription provider: OAuth login, token refresh, and the
 * model catalog the signed-in account can use.
 *
 * The models speak the Responses API at the Codex backend; the request
 * shape that backend needs (instructions, store:false) is applied by the
 * transport (see ai/stream.ts `chatgptProviderOptions`).
 */
import type {
  Api,
  AuthInteraction,
  Credential,
  CredentialStore,
  Model,
  OAuthCredential,
  Provider,
} from "../../ai/types.ts";
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
  CHATGPT_ORIGINATOR,
  CHATGPT_REFRESH_MARGIN_MS,
  type ChatGptTokens,
  chatGptAccountId,
  expiresAtFor,
  loginWithBrowser,
  loginWithDeviceCode,
  refreshChatGptToken,
} from "./oauth.ts";

/** Display name of the provider in settings and pickers. */
export const CHATGPT_PROVIDER_NAME = "ChatGPT";

/** What the provider needs from its host. */
export interface ChatGptProviderDeps {
  credentials: CredentialStore;
  settings: SettingsRepo;
  /** HTTP client; injectable so tests never touch the network. */
  fetch?: FetchLike;
}

/** A stored credential that names its account (login refuses one without). */
interface ChatGptCredential extends OAuthCredential {
  accountId: string;
}

/** Build the provider. The model list is loaded once here and replaced
 * after a login; a restart reads the same list back from settings. */
export function chatgptProvider(deps: ChatGptProviderDeps): Provider {
  const fetchImpl: FetchLike =
    deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let models: readonly Model<Api>[] = readChatGptModels(deps.settings);
  let pendingRefresh: Promise<ChatGptCredential> | undefined;

  /** The credential with a valid access token, refreshing it when it is
   * about to expire. Concurrent callers share one refresh: the backend
   * rotates the refresh token, so a second exchange could invalidate the
   * first. */
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
    const tokens = await refreshChatGptToken(fetchImpl, refreshToken);
    const next: ChatGptCredential = {
      type: "oauth",
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? credential.refreshToken,
      expiresAt: expiresAtFor(tokens),
      accountId: chatGptAccountId(tokens.accessToken) ?? credential.accountId,
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
      throw new Error(
        "the ChatGPT login needs a method (browser or device_code)",
      );
    }
    let tokens: ChatGptTokens;
    if (method === "browser") {
      tokens = await loginWithBrowser(interaction, fetchImpl);
    } else if (method === "device_code") {
      tokens = await loginWithDeviceCode(interaction, fetchImpl);
    } else {
      throw new Error(`unknown ChatGPT login method: ${String(method)}`);
    }
    const credential = credentialFrom(tokens);
    // List models before returning. The caller stores the credential only
    // after this resolves, so a login that cannot list models leaves no
    // half-configured provider behind.
    models = await fetchChatGptModels(
      fetchImpl,
      { token: credential.token, accountId: credential.accountId },
      interaction.signal,
    );
    saveChatGptModels(deps.settings, models);
    return credential;
  }

  return {
    id: CHATGPT_PROVIDER_ID,
    name: CHATGPT_PROVIDER_NAME,
    baseUrl: CHATGPT_API_BASE,
    auth: {
      oauth: {
        name: CHATGPT_PROVIDER_NAME,
        methods: ["browser", "device_code"],
        login,
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
        headers: {
          "ChatGPT-Account-Id": valid.accountId,
          originator: CHATGPT_ORIGINATOR,
        },
      };
    },
  };
}

/** Turn a token response into the credential stored under the provider. */
function credentialFrom(tokens: ChatGptTokens): ChatGptCredential {
  const accountId =
    chatGptAccountId(tokens.accessToken) ??
    (tokens.idToken !== undefined
      ? chatGptAccountId(tokens.idToken)
      : undefined);
  if (accountId === undefined) {
    throw new Error("the ChatGPT token does not name an account");
  }
  return {
    type: "oauth",
    token: tokens.accessToken,
    ...(tokens.refreshToken !== undefined
      ? { refreshToken: tokens.refreshToken }
      : {}),
    expiresAt: expiresAtFor(tokens),
    accountId,
  };
}

/** A credential stored before `accountId` was recorded still has it in the
 * token's claims; refuse only when neither knows it. */
function asChatGptCredential(credential: OAuthCredential): ChatGptCredential {
  const accountId = credential.accountId ?? chatGptAccountId(credential.token);
  if (accountId === undefined) {
    throw new Error(
      "the ChatGPT credential does not name an account; sign in again",
    );
  }
  return { ...credential, accountId };
}
