/**
 * OAuth 2.1 support for streamable HTTP MCP servers: the credential store
 * and the client provider the MCP specification's authorization flow needs.
 *
 * On a 401 the SDK's `auth()` walks the whole protocol — protected-resource
 * metadata (RFC 9728), authorization-server metadata (RFC 8414), dynamic
 * client registration (RFC 7591), PKCE, token exchange and refresh. The two
 * decisions it leaves to the application both live here:
 *
 * - **Where the credentials are kept between runs**: one settings entry per
 *   MCP server URL, holding the registered client, the tokens, the PKCE
 *   verifier and the cached discovery state. The values are credentials, so
 *   the settings guard hides the prefix from the generic settings API.
 * - **How the user agent is sent to the authorization server**: the sign-in
 *   flow's provider records the authorization URL for the UI to open, while
 *   a *connection* (session tool discovery, the settings test) refuses to
 *   start one — it can only report "sign in required" and let the UI run the
 *   flow.
 */
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { safeJsonParse } from "../shared/mod.ts";
import type { SettingsRepo } from "../settings/repo.ts";
import type { McpServerConfig } from "./config.ts";

/** Settings key prefix of one MCP server's OAuth state. Kept out of the
 * generic settings API by the server's settings guard (these are
 * credentials). */
export const MCP_OAUTH_KEY_PREFIX = "mcp_oauth:";

/** Where the authorization server returns the browser. A path of this
 * server, so the callback lands in the same process that holds the PKCE
 * verifier — a loopback listener (the usual native-app choice) would be
 * unreachable for a remotely hosted server whose browser is elsewhere. */
export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

/**
 * One server's OAuth state, as it is persisted.
 *
 * Everything the flow needs between two runs is one value, written as one
 * entry: a token without its registration (or a verifier without its flow)
 * could not be used, so the record is never partially updated.
 */
export interface McpOAuthRecord {
  /** The redirect URI the stored client registration was made for. A
   * registration is tied to one redirect URI, so a client registered
   * through another origin than the current one must be re-registered. */
  redirectUri?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** PKCE verifier of a sign-in that is waiting for the browser. */
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

/** Persistent storage of MCP OAuth credentials, keyed by server URL. */
export class McpOAuthStore {
  constructor(private readonly settings: SettingsRepo) {}

  read(serverUrl: string): McpOAuthRecord | undefined {
    return safeJsonParse<McpOAuthRecord>(
      this.settings.get(`${MCP_OAUTH_KEY_PREFIX}${serverUrl}`),
    );
  }

  /** Rewrite one server's record; returning undefined drops the entry. */
  update(
    serverUrl: string,
    mutate: (
      current: McpOAuthRecord | undefined,
    ) => McpOAuthRecord | undefined,
  ): void {
    const key = `${MCP_OAUTH_KEY_PREFIX}${serverUrl}`;
    const next = mutate(this.read(serverUrl));
    if (next === undefined) {
      this.settings.delete(key);
    } else {
      this.settings.set(key, JSON.stringify(next));
    }
  }

  /** Whether a token grant exists. This is the condition a connection tries
   * OAuth under: without a grant there is nothing to refresh, and starting
   * the flow from a background connect could neither open a browser nor
   * finish — such a server is reported as needing a sign-in instead. */
  hasGrant(serverUrl: string): boolean {
    return this.read(serverUrl)?.tokens !== undefined;
  }
}

/** A server connection failed because an interactive OAuth sign-in is
 * required (or the stored grant can no longer be used). Thrown by the
 * provider when a background connection would have to send the user to the
 * browser; callers surface it as "sign in to this server". */
export class McpAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAuthRequiredError";
  }
}

/** Whether a connection failure means "this server needs a sign-in" rather
 * than a broken server: the transport's own 401 (no provider was attached),
 * the SDK's `UnauthorizedError` (the authorization flow ended without
 * tokens) or our refusal to start a flow in the background.
 *
 * The SDK's failures are matched by shape, not with `instanceof`: its npm
 * subpaths resolve without their declarations here (the package's `types`
 * condition does not cover `<module>.js` subpaths), so the classes are
 * untyped and `instanceof` neither narrows nor survives a second copy of
 * the module. */
export function isMcpAuthRequired(error: unknown): boolean {
  if (error instanceof McpAuthRequiredError) return true;
  if (error instanceof Error && error.name === "UnauthorizedError") {
    return true;
  }
  return (error as { code?: unknown } | null | undefined)?.code === 401;
}

/** Fixed message of a `McpAuthRequiredError`; the UI renders its own
 * (translated) explanation and only carries this for logs and API clients. */
export const MCP_AUTH_REQUIRED_MESSAGE = "OAuth sign-in required";

export interface McpOAuthProviderOptions {
  store: McpOAuthStore;
  /** The MCP server's URL: the key of the server's credential record. */
  serverUrl: string;
  /** Whether this provider may send the user agent to the authorization
   * server. True only in the sign-in flow; connections pass false and are
   * told to report "sign-in required" instead (see
   * redirectToAuthorization). */
  interactive: boolean;
  /** Where the authorization server returns the browser. Required for an
   * interactive provider; a connection reuses the stored registration's URI
   * instead (see redirectUrl). */
  redirectUri?: string;
  /** OAuth `state` of the flow, so the callback can be matched to the
   * sign-in that started it. */
  state?: string;
  clientName?: string;
}

/**
 * The SDK's OAuth client, backed by {@link McpOAuthStore} and scoped to one
 * MCP server.
 *
 * Two modes, one class: the interactive provider starts a flow (and hands
 * the authorization URL to the UI), while a connection's provider only
 * reads, refreshes and — when that is not enough — reports that a sign-in
 * is needed.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  /** Authorization URL of the last `redirectToAuthorization`; the sign-in
   * flow reads it to open the browser. */
  authorizationUrl?: URL;

  constructor(private readonly options: McpOAuthProviderOptions) {}

  private get store(): McpOAuthStore {
    return this.options.store;
  }

  private get serverUrl(): string {
    return this.options.serverUrl;
  }

  /**
   * The redirect URI of the stored registration for a connection: reading
   * tokens and refreshing them do not depend on which URI the client was
   * registered with; only the authorize request does, and that one is
   * always started with an explicit URI (the page the user is looking at).
   */
  get redirectUrl(): string | undefined {
    return this.options.redirectUri ??
      this.store.read(this.serverUrl)?.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUri = this.redirectUrl;
    if (redirectUri === undefined) {
      // No registration to (re)use: nothing about this client can be
      // presented to an authorization server, so the way out is a sign-in
      // from the UI — which is what this error asks for.
      throw new McpAuthRequiredError(MCP_AUTH_REQUIRED_MESSAGE);
    }
    return {
      client_name: this.options.clientName ?? "Lumisca",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A public client: the PKCE verifier is the proof of possession, and
      // there is no secret to store (or to leak).
      token_endpoint_auth_method: "none",
    };
  }

  state(): string | undefined {
    return this.options.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const record = this.store.read(this.serverUrl);
    if (record?.clientInformation === undefined) return undefined;
    // A registration is tied to one redirect URI, so the interactive flow
    // must not present a client registered for another one (the SDK then
    // registers a fresh client for the URI the user is actually on).
    if (
      this.options.interactive && record.redirectUri !== this.redirectUrl
    ) {
      return undefined;
    }
    return record.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.store.update(this.serverUrl, (current) => ({
      ...current,
      clientInformation,
      redirectUri: this.redirectUrl,
    }));
  }

  tokens(): OAuthTokens | undefined {
    return this.store.read(this.serverUrl)?.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.update(this.serverUrl, (current) => ({ ...current, tokens }));
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.update(this.serverUrl, (current) => ({
      ...current,
      codeVerifier,
    }));
  }

  codeVerifier(): string {
    const verifier = this.store.read(this.serverUrl)?.codeVerifier;
    if (verifier === undefined) {
      throw new McpAuthRequiredError(MCP_AUTH_REQUIRED_MESSAGE);
    }
    return verifier;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.store.read(this.serverUrl)?.discoveryState;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.store.update(this.serverUrl, (current) => ({
      ...current,
      discoveryState: state,
    }));
  }

  /** Drop what the SDK found unusable (`invalidateCredentials`), so the
   * next attempt re-discovers, re-registers or re-authorizes instead of
   * repeating the failing request. */
  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    if (scope === "all") {
      this.store.update(this.serverUrl, () => undefined);
      return;
    }
    this.store.update(this.serverUrl, (current) => {
      if (current === undefined) return undefined;
      const next = { ...current };
      if (scope === "client") {
        delete next.clientInformation;
        delete next.redirectUri;
      }
      if (scope === "tokens") delete next.tokens;
      if (scope === "verifier") delete next.codeVerifier;
      if (scope === "discovery") delete next.discoveryState;
      return next;
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.options.interactive) {
      throw new McpAuthRequiredError(MCP_AUTH_REQUIRED_MESSAGE);
    }
    this.authorizationUrl = authorizationUrl;
  }
}

/** The OAuth client a *connection* may use for one server: undefined unless
 * the server is HTTP and a grant is stored. Attaching a provider without a
 * grant would make the SDK walk discovery and registration only to end in
 * an authorization it cannot finish (the 401 alone is the shorter, side
 * effect free way to report the same thing). */
export function connectionOAuthProvider(
  store: McpOAuthStore,
  server: McpServerConfig,
): McpOAuthProvider | undefined {
  const url = server.url;
  if (server.type !== "http" || url === undefined) return undefined;
  if (!store.hasGrant(url)) return undefined;
  return new McpOAuthProvider({
    store,
    serverUrl: url,
    interactive: false,
  });
}
