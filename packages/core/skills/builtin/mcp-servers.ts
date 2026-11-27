import type { SkillDef } from "../discover.ts";

/**
 * The built-in "mcp-servers" skill: how to add and remove MCP servers.
 *
 * The tools (mcp_add / mcp_remove / mcp_list, see mcp/manage-tools.ts) are
 * discoverable rather than preloaded, and main-only: a conversation that
 * never touches the config pays nothing for them, and a sub-agent cannot
 * change a config that outlives its run. A main agent that does not know the
 * tools exist never offers to add a server, so this guide is what tells it —
 * and what the tool description cannot: when to ask, what to do with a
 * failed connection test, and which config the tools actually edit.
 *
 * Advertised only where the tools are (BuiltinContext.mcpAdmin): a session
 * without them must not be pointed at a dead end.
 */

/** The SKILL.md body. English, like the tool descriptions it quotes. */
const SKILL_MD = `# MCP servers

MCP servers extend what you can do: a local process or an HTTP service
that offers its own tools. The app keeps one list of them in Settings → MCP
servers, and every workspace and every session uses that list.

You can change it with three tools: mcp_add, mcp_remove and mcp_list. They
are not preloaded, so find them with tool_search first.

## When to use them

- The user asks to add, remove or change an MCP server.
- Do not add one "just in case", to try something out, or because a server
  might be useful later: every configured server runs (or is connected) in
  every session.

## Before adding

You need one of two things:

- a command for a local stdio server, plus any arguments, environment
  variables and working directory;
- a URL for a streamable HTTP server, plus any headers.

If the user gave only a name ("add the GitHub MCP server"), find the
server's documented command or URL with web_search. Do not guess a package
name from the server's name: a wrong package is an error the test will
report, but installing an unrelated one is worse.

Credentials belong in env (stdio) or headers (HTTP). Ask for a value you do
not have; never invent one.

## How to use it

1. tool_search with the query "mcp" to get the arguments of mcp_add,
   mcp_remove and mcp_list.
2. tool_call with name "mcp_list", no arguments, to see what is configured
   already. Names are unique: adding never replaces an existing server, so
   remove the old one first if the user wants it changed.
3. tool_call with name "mcp_add", either:
   { "name": "filesystem", "command": "npx",
     "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] }
   or:
   { "name": "example", "url": "https://example.com/mcp",
     "headers": { "Authorization": "Bearer ..." } }
4. Read the answer. The tool tests the connection first and saves nothing
   when the test fails, so the error is about this server and the config is
   unchanged. Fix the command, the package or the path; do not send the
   identical call again.
   - A first run that downloads a package can outlast the test. Retry once;
     if it still times out, add "verify": false to save it untested, and say
     so.
   - A server that answers "sign-in required" is saved anyway: tell the user
     to open Settings → MCP servers and sign in there. You cannot complete
     that sign-in from the conversation.
5. The server's tools become findable with tool_search once it connects,
   under the server's name. Discovery starts when the config change is
   applied, so an immediate search may still list nothing; search once more,
   and if the tools never appear, report the server as not connecting.

## After adding

- Say what was added, that it applies to every workspace and every session,
  and — when the test ran — how many tools the server offers.
- Use the new tools through tool_search / tool_call. Do not describe the
  server's abilities beyond the tools it listed.

## Removing

1. tool_search with the query "mcp" and tool_call "mcp_list" for the exact
   name.
2. tool_call "mcp_remove" with { "name": "..." }.
3. Tell the user which server was removed. The others are untouched, and
   the change applies to every session immediately.

## What these tools do not touch

- A workspace's \`.mcp.json\` and agent plugins can add servers too. Only the
  app-level list is edited here; a workspace entry with the same name
  overrides an app-level server of that name.
- MCP servers run beside Lumisca, not inside a stella machine: a filesystem
  server reaches the host's files, and \`cwd\` is a path on the host.
- Credentials passed in env or headers are stored in the app's settings
  file. Do not repeat them in your reply.
`;

/** Build the built-in mcp-servers skill definition. Content is embedded (no
 * filesystem), so it survives bundling and any working directory. */
export function mcpServersSkill(): SkillDef {
  return {
    name: "mcp-servers",
    description:
      "Use this skill whenever the user asks to add, remove or list MCP " +
      "servers — the app-level list in Settings → MCP servers that every " +
      "workspace and session uses. It teaches mcp_add, mcp_remove and " +
      "mcp_list, which are not preloaded: find them with tool_search first.",
    source: "builtin",
    read: (relativePath) => {
      if (relativePath !== undefined) {
        // One file per built-in skill: no follow-up files exist. The message
        // mirrors the file-based skills' read error.
        return Promise.reject(
          new Error(`No such file in skill "mcp-servers": ${relativePath}`),
        );
      }
      return Promise.resolve(SKILL_MD);
    },
  };
}
