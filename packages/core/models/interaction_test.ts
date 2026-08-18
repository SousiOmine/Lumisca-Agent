import { assertEquals } from "@std/assert";
import { autoAnswerSelect } from "./interaction.ts";

Deno.test("autoAnswerSelect picks a device-code option when offered", () => {
  assertEquals(
    autoAnswerSelect([
      { id: "browser", label: "Browser login (default)" },
      { id: "device_code", label: "Device code login (headless)" },
    ]),
    "device_code",
  );
  // The label alone is enough (description may mention it).
  assertEquals(
    autoAnswerSelect([
      { id: "method", label: "Sign in with a device code" },
    ]),
    "method",
  );
});

Deno.test("autoAnswerSelect returns undefined when there is no device option", () => {
  assertEquals(
    autoAnswerSelect([
      { id: "a", label: "Option A" },
      { id: "b", label: "Option B" },
    ]),
    undefined,
  );
  assertEquals(autoAnswerSelect([]), undefined);
});
