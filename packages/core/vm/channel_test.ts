import { assertEquals } from "@std/assert";
import { openVmChannel } from "./channel.ts";

/** The channel is the one place the server speaks to a live process inside
 * the machine, so it is exercised against a real local process (`sh`)
 * rather than a fake: what matters is that lines survive the round trip,
 * that the end of the stream is reported, and that a stop reaches the
 * process. */
const posix = process.platform !== "win32";

Deno.test({
  name: "channel: lines round-trip through a live process",
  ignore: !posix,
  async fn() {
    const channel = await openVmChannel(["sh", "-c", "cat"], {
      timeoutMs: 5_000,
    });
    await channel.write("first");
    await channel.write("second");
    assertEquals(await channel.read(), "first");
    assertEquals(await channel.read(), "second");
    await channel.write("last");
    assertEquals(await channel.read(), "last");
    channel.kill();
  },
});

Deno.test({
  name: "channel: the end of stdout is reported as no line",
  ignore: !posix,
  async fn() {
    const channel = await openVmChannel(["sh", "-c", "printf 'only\\n'"], {
      timeoutMs: 5_000,
    });
    assertEquals(await channel.read(), "only");
    assertEquals(await channel.read(), undefined);
    assertEquals(
      channel.exitCode() === 0 || channel.exitCode() === undefined,
      true,
    );
  },
});

Deno.test({
  name: "channel: stderr is kept for the failure it explains",
  ignore: !posix,
  async fn() {
    const channel = await openVmChannel(
      ["sh", "-c", "printf 'boom\\n' >&2; exit 3"],
      { timeoutMs: 5_000 },
    );
    assertEquals(await channel.read(), undefined);
    assertEquals(channel.stderr().includes("boom"), true);
  },
});

Deno.test({
  name: "channel: the timeout stops the process",
  ignore: !posix,
  async fn() {
    const started = Date.now();
    const channel = await openVmChannel(["sh", "-c", "sleep 30"], {
      timeoutMs: 200,
    });
    assertEquals(await channel.read(), undefined);
    assertEquals(Date.now() - started < 10_000, true);
    channel.kill();
  },
});
