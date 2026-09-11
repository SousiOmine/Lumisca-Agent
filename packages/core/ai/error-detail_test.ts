import { assertEquals } from "@std/assert";
import { describeFailedCall, failureText } from "./error-detail.ts";

/** Stand-in for the AI SDK's APICallError shape. */
function apiCallError(
  message: string,
  extra: Record<string, unknown> = {},
): Error {
  return Object.assign(new Error(message), extra);
}

Deno.test("describeFailedCall renders the HTTP context", () => {
  const failed = describeFailedCall(apiCallError("Invalid JSON response", {
    statusCode: 502,
    url: "https://gateway.example/v1/chat/completions",
    responseBody: "<html>bad gateway</html>",
  }));
  assertEquals(failed.message, "Invalid JSON response");
  assertEquals(
    failed.detail,
    "status 502; url " +
      "https://gateway.example/v1/chat/completions; body <html>bad gateway</html>",
  );
});

Deno.test("describeFailedCall unwraps the cause chain", () => {
  // The shape the transport actually saw: a generic wrapper whose reason
  // hides one (or more) levels down.
  const cause = Object.assign(
    new Error("error reading a body from connection"),
    {
      code: "ECONNRESET",
      cause: new Error("socket closed"),
    },
  );
  const failed = describeFailedCall(
    apiCallError("Failed to process successful response", {
      statusCode: 200,
      cause,
    }),
  );
  assertEquals(
    failed.detail,
    "status 200; cause Error: error reading a body from connection " +
      "[ECONNRESET] → Error: socket closed",
  );
});

Deno.test("describeFailedCall keeps the provider's retryability flag", () => {
  const retryable = describeFailedCall(
    apiCallError("Cannot connect to API", { isRetryable: true }),
  );
  assertEquals(retryable.retryable, true);
  // Absent or false must not be reported as retryable.
  assertEquals(
    describeFailedCall(apiCallError("boom", { isRetryable: false })).retryable,
    undefined,
  );
  assertEquals(describeFailedCall(apiCallError("boom")).retryable, undefined);
});

Deno.test("describeFailedCall handles non-Error throws", () => {
  assertEquals(describeFailedCall("plain text"), { message: "plain text" });
  assertEquals(describeFailedCall(42), { message: "42" });
  assertEquals(describeFailedCall(null), { message: "null" });
});

Deno.test("describeFailedCall bounds the rendered detail", () => {
  const failed = describeFailedCall(apiCallError("boom", {
    responseBody: "x".repeat(5000),
  }));
  // A failure must not flood a banner or a transcript row.
  assertEquals(
    failed.detail !== undefined && failed.detail.length <= 241,
    true,
  );
});

Deno.test("describeFailedCall falls back to the error name for an empty message", () => {
  assertEquals(describeFailedCall(new TypeError("")).message, "TypeError");
});

Deno.test("failureText appends the detail only when there is one", () => {
  assertEquals(failureText({ message: "boom" }), "boom");
  assertEquals(
    failureText({ message: "boom", detail: "status 500" }),
    "boom (status 500)",
  );
});
