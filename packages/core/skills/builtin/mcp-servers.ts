import type { SkillDef } from "../discover.ts";

/**
 * The built-in "mcp-servers" skill: how to add and remove MCP servers.
 *
 * Two lists exist, and which one a server belongs to decides where it runs.
 * The shared app-level list runs on the host and is used by every agent and
 * every code-mode session. An agent's own list runs inside that agent's
 * machine and is seen by that agent alone. A server with a command is a local
 * process, so it can only be the agent's own: a shared entry would start it
 * on the host, outside the machine it was meant for.
 *
 * The tools (mcp_add / mcp_remove / mcp_list, see mcp/manage-tools.ts) are
 * discoverable rather than preloaded, and main-only: a conversation that
 * never touches the config pays nothing for them, and a sub-agent cannot
 * change a config that outlives its run. A main agent that does not know the
 * tools exist never offers to add a server, so this guide is what tells it —
 * and what the tool description cannot: when to ask, what to do with a
 * failed connection test, and which list the tools actually edit.
 *
 * Advertised only where the tools are (BuiltinContext.mcpAdmin): a session
 * without them must not be pointed at a dead end.
 */

/** The SKILL.md body. English, like the tool descriptions it quotes. */
const SKILL_MD = `# MCP servers

MCP servers extend what you can do: a local process or an HTTP service
that offers its own tools. There are two lists, and the list decides where
the server runs and who can use it.

- The shared list runs on the host. Every agent and every code-mode session
  uses it. An entry here starts its process on the host, outside any
  machine, so it is for HTTP services the user wants everywhere.
- This agent's own list runs inside this agent's machine. Only this agent
  sees it, and a server here reaches this machine's files and network.

You can change both lists with three tools: mcp_add, mcp_remove and mcp_list.
They are not preloaded, so find them with tool_search first.

## Which list to use

The type of the server decides most of it:

- A server with a command is a local process. It always goes into this
  agent's own list and runs inside the machine. Never try to put a command
  server in the shared list: that would start the process on the host, which
  is exactly what the machine exists to prevent.
- A server with a URL is reached over the network from either side. It goes
  into the shared list unless the user wants it for this agent only; pass
  scope "agent" for that.

Ask the user when the answer is not clear from what they said:

- "everywhere", "for all agents", "in code mode too": shared list.
- "only this agent", "only in this conversation", "it needs my files here":
  this agent's own list.
- A command they want "everywhere" cannot be honored as stated: a command
  server runs in one machine. Add it to this agent's list and say that the
  other agents need their own copy if they are to have it.

Do not add a server "just in case", to try something out, or because it
might be useful later: every configured server starts, or is connected, in
the conversation that uses it.

## Before adding

You need one of two things:

- a command for a local stdio server, plus any arguments, environment
  variables and working directory. The working directory is a path in this
  agent's machine; a relative path resolves against the agent's home.
- a URL for a streamable HTTP server, plus any headers.

If the user gave only a name ("add the GitHub MCP server"), find the
server's documented command or URL with web_search. Do not guess a package
name from the server's name: a wrong package is an error the test will
report, but installing an unrelated one is worse.

Credentials belong in env (stdio) or headers (HTTP). Ask for a value you do
not have; never invent one. A server on this agent's own list cannot use an
interactive sign-in: there is no sign-in screen for it, so a credential has
to travel in a header.

## How to use it

1. tool_search with the query "mcp" to get the arguments of mcp_add,
   mcp_remove and mcp_list.
2. tool_call with name "mcp_list", no arguments, to see both lists and what
   is already configured. Names are unique within a list, and this agent's
   own server wins over a shared one of the same name. To change a server,
   remove it from its list first and add it again.
3. tool_call with name "mcp_add", for a server inside this machine:
   { "name": "filesystem", "command": "npx",
     "args": ["-y", "@modelcontextprotocol/server-filesystem", "data"] }
   or a shared HTTP service:
   { "name": "example", "url": "https://example.com/mcp",
     "headers": { "Authorization": "Bearer ..." } }
   Add "scope": "agent" to an HTTP server that only this agent should use.
4. Read the answer. The tool tests the connection first and saves nothing
   when the test fails, so the error is about this server and the config is
   unchanged. Fix the command, the package or the path; do not send the
   identical call again.
   - A first run that downloads a package can outlast the test. Retry once;
     if it still times out, add "verify": false to save it untested, and say
     so.
   - A shared HTTP server that answers "sign-in required" is saved anyway:
     tell the user to open Settings → MCP servers and sign in there. You
     cannot complete that sign-in from the conversation. An agent's own
     server cannot be signed in at all, so put the credential in a header
     instead.
5. The server's tools become findable with tool_search once it connects,
   under the server's name. Discovery starts when the config change is
   applied, so an immediate search may still list nothing; search once more,
   and if the tools never appear, report the server as not connecting.

## After adding

- Say what was added and which list it went into, because that decides where
  it runs and who else sees it.
- When the test ran, say how many tools the server offers.
- Use the new tools through tool_search / tool_call. Do not describe the
  server's abilities beyond the tools it listed.

## Removing

1. tool_search with the query "mcp" and tool_call "mcp_list" for the exact
   name and its list.
2. tool_call "mcp_remove" with { "name": "..." }. Add "scope" when the same
   name is in both lists, because the tool refuses to guess.
3. Tell the user which server was removed and from which list. Removing a
   shared server takes it away from every agent and from code mode.

## What these tools do not touch

- A workspace's \`.mcp.json\` and agent plugins can add servers too. Only
  the two lists above are edited here; an entry with the same name overrides
  a shared server of that name.
- The settings page edits the shared list directly. An agent's own list has
  no page: you are its only editor.
`;

/** Build the built-in mcp-servers skill definition. Content is embedded (no
 * filesystem), so it survives bundling and any working directory. */
export function mcpServersSkill(): SkillDef {
  return {
    name: "mcp-servers",
    description:
      "Use this skill whenever the user asks to add, remove or list MCP " +
      "servers. It teaches mcp_add, mcp_remove and mcp_list, which are not " +
      "preloaded: find them with tool_search first. A command server runs " +
      "inside the agent's machine and belongs to its own list; an HTTP " +
      "server can be shared by every agent.",
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
