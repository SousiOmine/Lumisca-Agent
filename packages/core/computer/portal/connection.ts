/**
 * The D-Bus session bus, and the only module that touches a D-Bus library.
 *
 * @jellybrick/dbus-next is a maintained fork of dbus-next whose transport is
 * plain `node:net` unix sockets — no native addon — which is what lets the
 * packaged Deno server speak D-Bus without shipping a C library. Nothing
 * else in the computer-use code imports it: replacing the transport means
 * rewriting this file alone.
 *
 * Three behaviours of the library (and of dbus-daemon) shape this module:
 *
 * - Match rule values must be SINGLE quoted (`type='signal'`). Double quotes
 *   end up inside the value, and dbus-daemon rejects the rule with
 *   `Invalid message type ("signal") in match rule`.
 * - Every transport failure — including a failed connect — is emitted as an
 *   `error` event on the bus, and a pending call never settles. An
 *   EventEmitter `error` with no listener throws, so this module always
 *   listens, remembers the failure, and rejects the calls that are stuck;
 *   otherwise a missing session bus would kill the server process.
 * - The bus is opened lazily and connects in the background, so "is the bus
 *   there" is answered by an explicit handshake call, not by constructing
 *   the connection.
 */
import {
  DBusError,
  Message,
  type MessageBus,
  MessageType,
  sessionBus,
  Variant,
} from "@jellybrick/dbus-next";
import { CoreError, errorMessage } from "../../errors.ts";

/** How long one method call may wait. Portal methods answer immediately:
 * waiting for the user (consent, screen selection) is not a method call —
 * it arrives later as a Response signal on the returned request object. */
export const CALL_TIMEOUT_MS = 10_000;
/** How long opening the bus may take before the machine counts as having
 * no usable session bus. */
export const CONNECT_TIMEOUT_MS = 5_000;

/** One D-Bus method call: where it goes and what it carries. */
export interface MethodCall {
  destination: string;
  path: string;
  interface: string;
  member: string;
  signature: string;
  body: unknown[];
}

export type SignalHandler = (...args: unknown[]) => void;

/** The session bus, as the portal modules use it. */
export interface PortalConnection {
  /** This connection's unique name (`:1.42`). Request object paths are
   * built from it. */
  readonly uniqueName: string;
  /** Call a method and return its reply body. Failures are CoreError. */
  call(call: MethodCall, timeoutMs?: number): Promise<unknown[]>;
  /** Run `handler` for one signal on one object path. The returned function
   * removes the match rule and the listener. */
  subscribe(
    path: string,
    interfaceName: string,
    member: string,
    handler: SignalHandler,
  ): Promise<() => Promise<void>>;
  /** Wrap a value so the bus library sends it as a D-Bus variant. */
  variant(signature: string, value: unknown): Variant;
  disconnect(): void;
}

/** The bus's `error` event is not in the library's event map (it names only
 * `connect` and `message`), but the library emits it for every transport
 * failure. */
interface ErrorEmittingBus {
  on(event: "error", listener: (error: unknown) => void): void;
}

interface MessageEmittingBus {
  on(event: "message", listener: (message: Message) => void): void;
  removeListener(event: "message", listener: (message: Message) => void): void;
}

/** The session bus address of this user, or undefined when the environment
 * does not say where it is. The fallback is the standard path every desktop
 * session bus socket lives at. */
export function sessionBusAddress(
  env: { get(key: string): string | undefined } = Deno.env,
): string | undefined {
  const address = env.get("DBUS_SESSION_BUS_ADDRESS");
  if (address !== undefined && address.length > 0) return address;
  const runtimeDir = env.get("XDG_RUNTIME_DIR");
  if (runtimeDir !== undefined && runtimeDir.length > 0) {
    return `unix:path=${runtimeDir}/bus`;
  }
  return undefined;
}

/** The filesystem path of a `unix:path=...` bus address, or undefined for
 * any other form (abstract sockets, tcp, a list of alternatives). It exists
 * to pre-flight the socket with Deno.connect, whose failure is an ordinary
 * rejection, while the library reports a failed connect as an unhandled
 * `error` event. */
export function unixSocketPath(address: string): string | undefined {
  for (const entry of address.split(";")) {
    const separator = entry.indexOf(":");
    if (separator < 0) continue;
    if (entry.slice(0, separator) !== "unix") continue;
    for (const parameter of entry.slice(separator + 1).split(",")) {
      if (parameter.startsWith("path=")) return parameter.slice(5);
    }
  }
  return undefined;
}

/** The value inside a `Variant`, or the value itself. Reply dictionaries
 * (`a{sv}`) arrive with their values wrapped; nothing outside this module
 * needs to know that. */
export function unwrapVariant(value: unknown): unknown {
  if (
    typeof value === "object" && value !== null && "signature" in value &&
    "value" in value
  ) {
    return (value as { value: unknown }).value;
  }
  return value;
}

/** One match rule for a single signal on a single object path. Values are
 * single quoted (see the module docs); object paths and interface names
 * cannot contain a quote, so no escaping is needed. */
export function signalMatchRule(
  path: string,
  interfaceName: string,
  member: string,
): string {
  return `type='signal',path='${path}',interface='${interfaceName}',` +
    `member='${member}'`;
}

/** Reject when `work` does not settle within `timeoutMs`. */
function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => CoreError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** One D-Bus reply body: the library rejects error replies itself, so the
 * body is the method's return value. */
function replyBody(reply: Message): unknown[] {
  return reply.body;
}

/** Turn whatever the library throws into the CoreError the caller reports. */
function callFailure(call: MethodCall, error: unknown): CoreError {
  if (error instanceof CoreError) return error;
  if (error instanceof DBusError) {
    const type = (error as unknown as { type?: string }).type;
    const text = (error as unknown as { text?: string }).text;
    return new CoreError(
      `${call.interface}.${call.member} failed: ${type}${
        text !== undefined && text.length > 0 ? ` (${text})` : ""
      }`,
      "unavailable",
    );
  }
  return new CoreError(
    `${call.interface}.${call.member} failed: ${errorMessage(error)}`,
    "unavailable",
  );
}

/**
 * Open the session bus and make sure it answers. Fails with a CoreError that
 * says what is missing (no address, no socket, no handshake) — never with a
 * crashed process.
 */
export async function connectPortalBus(
  env: { get(key: string): string | undefined } = Deno.env,
): Promise<PortalConnection> {
  const address = sessionBusAddress(env);
  if (address === undefined) {
    throw new CoreError(
      "the session bus address is unknown: DBUS_SESSION_BUS_ADDRESS and " +
        "XDG_RUNTIME_DIR are both unset",
      "unavailable",
    );
  }
  const socketPath = unixSocketPath(address);
  if (socketPath !== undefined) {
    try {
      (await Deno.connect({ path: socketPath, transport: "unix" })).close();
    } catch (error) {
      throw new CoreError(
        `no session bus at ${socketPath} (${errorMessage(error)})`,
        "unavailable",
      );
    }
  }

  const bus = sessionBus({ busAddress: address }) as MessageBus;
  let connectionFailure: Error | undefined;
  (bus as unknown as ErrorEmittingBus).on("error", (error) => {
    connectionFailure ??= error instanceof Error
      ? error
      : new Error(String(error));
  });

  const call = async (
    request: MethodCall,
    timeoutMs: number = CALL_TIMEOUT_MS,
  ): Promise<unknown[]> => {
    if (connectionFailure !== undefined) {
      throw new CoreError(
        `the session bus connection failed: ${connectionFailure.message}`,
        "unavailable",
      );
    }
    let pending: Promise<Message | null>;
    try {
      pending = bus.call(
        new Message({
          destination: request.destination,
          path: request.path,
          interface: request.interface,
          member: request.member,
          signature: request.signature,
          body: request.body,
        }),
      );
    } catch (error) {
      throw callFailure(request, error);
    }
    let reply: Message | null;
    try {
      reply = await withTimeout(pending, timeoutMs, () =>
        new CoreError(
          `${request.interface}.${request.member} did not answer within ` +
            `${timeoutMs}ms`,
          "unavailable",
        ));
    } catch (error) {
      throw callFailure(request, error);
    }
    if (reply === null) {
      throw new CoreError(
        `${request.interface}.${request.member} returned no reply`,
        "unavailable",
      );
    }
    return replyBody(reply);
  };

  try {
    await call({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
      member: "GetId",
      signature: "",
      body: [],
    }, CONNECT_TIMEOUT_MS);
  } catch (error) {
    bus.disconnect();
    throw new CoreError(
      `could not open the session bus at ${address}: ${
        error instanceof CoreError ? error.message : errorMessage(error)
      }`,
      "unavailable",
    );
  }

  let closed = false;
  return {
    get uniqueName() {
      return bus.name ?? "";
    },
    call,
    async subscribe(path, interfaceName, member, handler) {
      const rule = signalMatchRule(path, interfaceName, member);
      await call({
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        member: "AddMatch",
        signature: "s",
        body: [rule],
      });
      const listener = (message: Message) => {
        if (
          message.type !== MessageType.SIGNAL ||
          message.path !== path ||
          message.interface !== interfaceName ||
          message.member !== member
        ) {
          return;
        }
        handler(...message.body);
      };
      (bus as unknown as MessageEmittingBus).on("message", listener);
      return async () => {
        (bus as unknown as MessageEmittingBus).removeListener(
          "message",
          listener,
        );
        try {
          await call({
            destination: "org.freedesktop.DBus",
            path: "/org/freedesktop/DBus",
            interface: "org.freedesktop.DBus",
            member: "RemoveMatch",
            signature: "s",
            body: [rule],
          });
        } catch {
          // The rule disappears with the connection anyway; a failed
          // RemoveMatch must not turn an unsubscribe into an error.
        }
      };
    },
    variant(signature, value) {
      return new Variant(signature, value);
    },
    disconnect() {
      if (closed) return;
      closed = true;
      bus.disconnect();
    },
  };
}
