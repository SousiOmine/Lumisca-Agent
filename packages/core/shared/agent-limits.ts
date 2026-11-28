/**
 * The lengths of an agent's own text, for the two sides that have to agree
 * about them: the server that stores it and the browser that types it.
 *
 * The identity lives here because the identity editor puts the limit on its
 * field (`maxLength`) and in its counter, while the repository refuses a text
 * one character over it — two numbers that must not drift. The name and the
 * role stay with the row (stella/agents.ts): no screen has a field for them
 * that the browser has to bound first, and the name is checked again on the
 * server for every route and tool.
 */

/** The longest identity: the agent's own note about itself, read when the
 * system prompt is generated and carried by every request of that prompt, so
 * it stays a short note rather than a document. */
export const MAX_AGENT_IDENTITY_CHARS = 4_000;
