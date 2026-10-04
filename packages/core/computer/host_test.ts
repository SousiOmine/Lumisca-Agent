import { assert, assertEquals } from "@std/assert";
import { createComputerHost } from "./host.ts";

Deno.test("createComputerHost reports the platform when it has no host", {
  ignore: Deno.build.os === "windows",
}, () => {
  const result = createComputerHost();
  assertEquals(result.available, false);
  if (result.available) return; // narrowed for the assertions below
  assert(
    result.reason.includes(Deno.build.os),
    `the reason must name the platform: ${result.reason}`,
  );
});

Deno.test("createComputerHost returns either a usable host or a reason", () => {
  const result = createComputerHost();
  if (result.available) {
    try {
      // A host that cannot describe itself or list a display would be
      // unusable: the tool layer resolves regions from that list.
      assert(result.host.describe().length > 0);
      assert(result.host.displays().length > 0);
    } finally {
      result.host.close();
    }
    return;
  }
  assert(
    result.reason.length > 0,
    "an unavailable host must say why (the settings toggle shows it)",
  );
});
