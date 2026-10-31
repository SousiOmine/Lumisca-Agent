import { agentAvatarHue, agentInitial } from "@lumisca/core/shared";
import { stellaAgentIconUrl } from "../../api-client.ts";

export interface AgentAvatarProps {
  /** The agent whose avatar this is: its id picks the colour, so the same
   * agent looks the same everywhere and after a restart. */
  agentId: string;
  /** The agent's name (its first character is the initial). */
  name: string;
  /** The stored picture's name, or "" for the initial. */
  icon: string;
  /** Diameter in pixels. The two surfaces that draw an avatar are the
   * sidebar row and the conversation's header, so the size is a number
   * rather than a class: one component, one shape. */
  size: number;
  /** Drawn on a raised surface (the header) rather than inside a list row. */
  className?: string;
}

/**
 * The face of one stella agent: the picture the user picked, or the agent's
 * initial on a colour derived from its id.
 *
 * The fallback is not a placeholder to be replaced — an agent without a
 * picture is a normal state, and the initial is how the sidebar has always
 * looked. That is why the colour is derived rather than stored: nothing has
 * to be generated at creation, nothing can go stale, and the same agent keeps
 * its colour across restarts and reorders.
 *
 * One component rather than two shapes at the two call sites: the sidebar and
 * the conversation header draw the same thing at different sizes, and a
 * second implementation would drift the moment one of them changed (the
 * initial's uppercase rule, the image's fit).
 */
export function AgentAvatar(
  { agentId, name, icon, size, className }: AgentAvatarProps,
) {
  // A var rather than an inline colour: tokens.css declares the default, so
  // the rule that reads it stays in the stylesheet (and a theme can adjust
  // the lightness without touching every call site).
  const style = {
    "--agent-avatar-hue": `${agentAvatarHue(agentId)}`,
    width: `${size}px`,
    height: `${size}px`,
    // The initial's size follows the circle: an initial that kept 13px in a
    // 40px circle would read as a dot in a hole.
    fontSize: `${Math.round(size * 0.44)}px`,
  } as Record<string, string>;
  const classes = `agent-avatar${
    className === undefined ? "" : ` ${className}`
  }`;
  if (icon !== "") {
    return (
      <img
        className={classes}
        style={style}
        src={stellaAgentIconUrl(agentId, icon)}
        alt=""
        width={size}
        height={size}
        draggable={false}
      />
    );
  }
  return (
    <span
      className={`${classes} agent-avatar-initial`}
      style={style}
      // Not "the agent's initial" to a screen reader: the name is right
      // next to it in every surface that draws one, and "A" before "Aide"
      // is noise.
      aria-hidden="true"
    >
      {agentInitial(name)}
    </span>
  );
}
