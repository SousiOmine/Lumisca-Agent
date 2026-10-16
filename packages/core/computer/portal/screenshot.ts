/**
 * The Screenshot portal: one whole-desktop capture per call, handed back as
 * a file URI the portal wrote.
 *
 * What the user sees the first time is a permission dialog ("Allow
 * Applications to Take Screenshots?"); once granted, xdg-desktop-portal
 * remembers it in its permission store and later captures are silent, which
 * is what makes screenshot-per-step workable. A desktop that never asks
 * (no permission store entry and no dialog) is the user's own policy — the
 * portal answers 1 and this module reports that as a decline.
 *
 * The portal leaves the file behind, so the file is read and removed: one
 * leftover PNG per screenshot would pile up in the runtime directory.
 */
import { fileURLToPath } from "node:url";
import { CoreError, errorMessage } from "../../errors.ts";
import { decodePngToBgra } from "../image.ts";
import { type PortalConnection, unwrapVariant } from "./connection.ts";
import {
  callPortalRequest,
  newRequestToken,
  REQUEST_TIMEOUT_MS,
} from "./request.ts";
import type { ScreenImage } from "./types.ts";

export const PORTAL_DESTINATION = "org.freedesktop.portal.Desktop";
export const PORTAL_PATH = "/org/freedesktop/portal/desktop";
export const SCREENSHOT_INTERFACE = "org.freedesktop.portal.Screenshot";
export const REQUEST_INTERFACE = "org.freedesktop.portal.Request";

/** Capture the whole desktop (every monitor, in one image). */
export async function captureScreen(
  connection: PortalConnection,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<ScreenImage> {
  const token = newRequestToken();
  const outcome = await callPortalRequest(
    connection,
    {
      destination: PORTAL_DESTINATION,
      path: PORTAL_PATH,
      interface: SCREENSHOT_INTERFACE,
      member: "Screenshot",
      signature: "sa{sv}",
      body: [
        "", // no parent window: the capture is not tied to a surface
        {
          handle_token: connection.variant("s", token),
          // false = capture without the interactive UI; the permission dialog
          // is the portal's business either way.
          interactive: connection.variant("b", false),
        },
      ],
    },
    token,
    timeoutMs,
  );

  if (outcome.response === 1) {
    throw new CoreError(
      "the screenshot was declined: allow screenshots in the desktop's " +
        "permission dialog to let the agent see the screen",
      "unavailable",
    );
  }
  if (outcome.response !== 0) {
    throw new CoreError(
      `the screenshot request failed (portal response ${outcome.response}); ` +
        "the desktop's permission dialog has to be answered when it appears " +
        "— it gives up after about 25 seconds",
      "unavailable",
    );
  }
  const uri = unwrapVariant(outcome.results["uri"]);
  if (typeof uri !== "string" || uri.length === 0) {
    throw new CoreError(
      "the screenshot request reported no file (the desktop's screenshot " +
        "backend may have failed)",
      "unavailable",
    );
  }

  const path = fileURLToPath(uri);
  let encoded: Uint8Array;
  try {
    encoded = await Deno.readFile(path);
  } catch (error) {
    throw new CoreError(
      `could not read the screenshot file ${path}: ${errorMessage(error)}`,
      "unavailable",
    );
  }
  try {
    await Deno.remove(path);
  } catch {
    // A file the desktop wants to keep (or already removed) is not a
    // reason to fail a capture that succeeded.
  }
  return decodePngToBgra(encoded);
}
