/**
 * In-process fixtures for the HTTP transport and OAuth tests: a minimal
 * streamable HTTP MCP server and a minimal OAuth authorization server.
 *
 * They exist so the whole sign-in path — 401, protected-resource discovery,
 * dynamic registration, the authorization request, the code exchange and the
 * authenticated reconnect — runs over real HTTP on a loopback port, instead
 * of mocking the SDK's internals. Imported by `*_test.ts` files only.
 */

/** One request a fake server saw. */
export interface FakeRequest {
  method: string;
  path: string;
  /** Request headers, lowercased (what iterating `Headers` yields). */
  headers: Record<string, string>;
}

export interface FakeMcpServer {
  /** The MCP endpoint (`http://127.0.0.1:<port>/mcp`). */
  url: string;
  /** Where the 401 points the client for RFC 9728 discovery; the same
   * server answers it. */
  protectedResourceMetadataUrl: string;
  /** Every request the server answered, in order. */
  requests: FakeRequest[];
  close(): Promise<void>;
}

export interface FakeMcpServerOptions {
  /** Bearer token the server accepts; every other request gets a 401. */
  token?: string;
  /** Tools the server publishes (default: one `echo`). */
  tools?: string[];
  /** Authorization server advertised by the protected-resource metadata:
   * what the client discovers and then registers with. */
  authorizationServerUrl?: string;
}

/** The MCP endpoint path of the fixture (the resource identifier is its
 * URL, so a fix here and a test's expectations stay one thing). */
export const FAKE_MCP_PATH = "/mcp";

const FAKE_PRM_PATH = "/.well-known/oauth-protected-resource/mcp";

function json(body: unknown, status = 200, headers = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Answer one JSON-RPC message (the fixture speaks just enough of the
 * protocol for `initialize` and `tools/list`). */
function answer(message: Record<string, unknown>, tools: string[]): unknown {
  const params = message.params as Record<string, unknown> | undefined;
  switch (message.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "1.0.0" },
        },
      };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: tools.map((name) => ({
            name,
            description: `the ${name} tool`,
            inputSchema: { type: "object" },
          })),
        },
      };
    default:
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      };
  }
}

/** Start the fake MCP server on an ephemeral loopback port. */
export function startFakeMcpServer(
  options: FakeMcpServerOptions = {},
): FakeMcpServer {
  const requests: FakeRequest[] = [];
  const tools = options.tools ?? ["echo"];
  let baseUrl = "";

  const handler = async (req: Request): Promise<Response> => {
    const parsed = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const [name, value] of req.headers) headers[name] = value;
    requests.push({ method: req.method, path: parsed.pathname, headers });

    if (parsed.pathname === FAKE_PRM_PATH) {
      return json({
        resource: `${baseUrl}${FAKE_MCP_PATH}`,
        authorization_servers: options.authorizationServerUrl === undefined
          ? []
          : [options.authorizationServerUrl],
        scopes_supported: ["offline_access"],
      });
    }

    if (
      options.token !== undefined &&
      headers.authorization !== `Bearer ${options.token}`
    ) {
      return json(
        {
          jsonrpc: "2.0",
          error: { code: -31001, message: "Unauthorized" },
          id: null,
        },
        401,
        {
          "www-authenticate":
            `Bearer resource_metadata="${baseUrl}${FAKE_PRM_PATH}"`,
        },
      );
    }

    // The optional server-initiated stream is declined (405 is the
    // documented "no SSE here" answer).
    if (req.method === "GET") return new Response(null, { status: 405 });
    if (req.method === "DELETE") return new Response(null, { status: 204 });

    const body = await req.json();
    const messages = Array.isArray(body) ? body : [body];
    const answers = messages
      .filter((message) => message?.id !== undefined)
      .map((message) => answer(message, tools));
    // Notifications only: 202 with no body, as the transport expects.
    if (answers.length === 0) return new Response(null, { status: 202 });
    return json(answers.length === 1 ? answers[0] : answers);
  };

  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    handler,
  );
  baseUrl = `http://127.0.0.1:${server.addr.port}`;
  return {
    url: `${baseUrl}${FAKE_MCP_PATH}`,
    protectedResourceMetadataUrl: `${baseUrl}${FAKE_PRM_PATH}`,
    requests,
    close: () => server.shutdown(),
  };
}

export interface FakeAuthServer {
  /** The authorization server URL (its metadata's issuer). */
  url: string;
  /** Dynamic client registrations served. */
  registrations: number;
  /** Authorization requests served (what a browser would land on). */
  authorizations: number;
  /** Token requests served. */
  tokenRequests: number;
  /** Parameters of the last token request (grant_type, code_verifier, ...). */
  lastTokenRequest: URLSearchParams | undefined;
  close(): Promise<void>;
}

export interface FakeAuthServerOptions {
  /** Client id handed out by dynamic registration. */
  clientId?: string;
  /** Access token handed out by the token endpoint. */
  accessToken?: string;
  /** Refresh token handed out by the token endpoint. */
  refreshToken?: string;
}

/** Start the fake authorization server on an ephemeral loopback port. */
export function startFakeAuthServer(
  options: FakeAuthServerOptions = {},
): FakeAuthServer {
  const clientId = options.clientId ?? "test-client";
  let baseUrl = "";
  const state: FakeAuthServer = {
    url: "",
    registrations: 0,
    authorizations: 0,
    tokenRequests: 0,
    lastTokenRequest: undefined,
    close: () => server.shutdown(),
  };

  const metadata = () => ({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["offline_access"],
  });

  const handler = async (req: Request): Promise<Response> => {
    const parsed = new URL(req.url);
    if (
      parsed.pathname === "/.well-known/oauth-authorization-server" ||
      parsed.pathname === "/.well-known/openid-configuration"
    ) {
      return json(metadata());
    }
    if (parsed.pathname === "/authorize" && req.method === "GET") {
      // What a real user agent would land on: the consent screen is skipped
      // and the client is sent back with a code right away, so a browser
      // driving this fixture finishes the flow in one hop.
      state.authorizations++;
      const redirect = new URL(parsed.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "test-code");
      const stateParam = parsed.searchParams.get("state");
      if (stateParam !== null) redirect.searchParams.set("state", stateParam);
      return Response.redirect(redirect, 302);
    }
    if (parsed.pathname === "/register" && req.method === "POST") {
      state.registrations++;
      const registration = await req.json() as Record<string, unknown>;
      // RFC 7591: the registration is echoed back with the issued client id.
      return json({ ...registration, client_id: clientId }, 201);
    }
    if (parsed.pathname === "/token" && req.method === "POST") {
      state.tokenRequests++;
      state.lastTokenRequest = new URLSearchParams(await req.text());
      return json({
        access_token: options.accessToken ?? "access-token-1",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: options.refreshToken ?? "refresh-token-1",
      });
    }
    return new Response("not found", { status: 404 });
  };

  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    handler,
  );
  baseUrl = `http://127.0.0.1:${server.addr.port}`;
  state.url = baseUrl;
  return state;
}
