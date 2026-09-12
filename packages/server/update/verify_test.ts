import { assertEquals, assertRejects } from "@std/assert";
import { blake2b } from "@noble/hashes/blake2.js";
import { removeDirRetry } from "@lumisca/core/test-utils";
import { createSigningKeys } from "./test-utils.ts";
import {
  decodeMinisignPublicKey,
  decodeMinisignSignature,
  hashFileBlake2b512,
  RELEASE_PUBLIC_KEY,
  SignatureError,
  verifyFileSignature,
} from "./verify.ts";

async function tempFile(content: Uint8Array | string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-verify-" });
  const path = `${dir}/package.bin`;
  await Deno.writeFile(
    path,
    typeof content === "string" ? new TextEncoder().encode(content) : content,
  );
  return path;
}

Deno.test("the compiled-in release key mirrors tauri.conf.json", async () => {
  // A rotated desktop key must not leave the server updater verifying
  // against the old one: both files carry the same minisign public key.
  const config = JSON.parse(
    await Deno.readTextFile(
      new URL("../../desktop/src-tauri/tauri.conf.json", import.meta.url),
    ),
  ) as { plugins?: { updater?: { pubkey?: string } } };
  const desktopKey = config.plugins?.updater?.pubkey;
  assertEquals(typeof desktopKey, "string");
  assertEquals(desktopKey, RELEASE_PUBLIC_KEY);
  // …and the key parses to the 32-byte Ed25519 material the verifier uses.
  assertEquals(decodeMinisignPublicKey(RELEASE_PUBLIC_KEY).key.length, 32);
});

Deno.test("a signature over the archive digest verifies", async () => {
  const keys = await createSigningKeys();
  const file = await tempFile("hello lumisca");
  try {
    const signature = await keys.sign(file);
    await verifyFileSignature({ file, signature, publicKey: keys.publicKey });
    // The same signature must not verify a different payload.
    await Deno.writeFile(file, new TextEncoder().encode("hello lumisca!"));
    await assertRejects(
      () => verifyFileSignature({ file, signature, publicKey: keys.publicKey }),
      SignatureError,
    );
  } finally {
    await removeDirRetry(file);
  }
});

Deno.test("a signature made with another key is rejected", async () => {
  const signer = await createSigningKeys();
  const other = await createSigningKeys();
  const file = await tempFile("payload");
  try {
    const signature = await signer.sign(file);
    await assertRejects(
      () =>
        verifyFileSignature({
          file,
          signature,
          publicKey: other.publicKey,
        }),
      SignatureError,
      "鍵 id が公開鍵と一致しません",
    );
  } finally {
    await removeDirRetry(file);
  }
});

Deno.test("a tampered archive is rejected", async () => {
  const keys = await createSigningKeys();
  const file = await tempFile("payload");
  try {
    const signature = await keys.sign(file);
    // A single flipped byte must fail: the digest no longer matches.
    const bytes = await Deno.readFile(file);
    bytes[0] = bytes[0]! ^ 0x01;
    await Deno.writeFile(file, bytes);
    await assertRejects(
      () => verifyFileSignature({ file, signature, publicKey: keys.publicKey }),
      SignatureError,
      "署名が一致しません",
    );
  } finally {
    await removeDirRetry(file);
  }
});

Deno.test("malformed containers are rejected with a readable reason", async () => {
  const keys = await createSigningKeys();
  const file = await tempFile("payload");
  const dir = file.replace(/[\\/][^\\/]+$/, "");
  try {
    const valid = await keys.sign(file);

    // Not base64 at all.
    await assertRejects(
      () =>
        verifyFileSignature({
          file,
          signature: "!!not base64!!",
          publicKey: keys.publicKey,
        }),
      SignatureError,
      "base64",
    );

    // base64 of text that is not a minisign file.
    await assertRejects(
      () =>
        verifyFileSignature({
          file,
          signature: btoa("just one line\n"),
          publicKey: keys.publicKey,
        }),
      SignatureError,
      "2行目",
    );

    // A signature blob that is too short.
    await assertRejects(
      () =>
        verifyFileSignature({
          file,
          signature: btoa(
            `untrusted comment: x\n${
              btoa(String.fromCharCode(...new Uint8Array(10)))
            }\n`,
          ),
          publicKey: keys.publicKey,
        }),
      SignatureError,
      "署名の長さが不正です",
    );

    // A public key that is not 42 bytes.
    await assertRejects(
      () =>
        verifyFileSignature({
          file,
          signature: valid,
          publicKey: btoa(
            `untrusted comment: x\n${
              btoa(String.fromCharCode(...new Uint8Array(20)))
            }\n`,
          ),
        }),
      SignatureError,
      "公開鍵の長さが不正です",
    );
  } finally {
    await removeDirRetry(dir);
  }
});

Deno.test("a signature with CRLF line endings still verifies", async () => {
  const keys = await createSigningKeys();
  const file = await tempFile("payload");
  try {
    const signature = await keys.sign(file);
    const text = new TextDecoder().decode(
      Uint8Array.from(atob(signature), (c) => c.charCodeAt(0)),
    );
    // A signature that travelled through a tool that rewrites line endings
    // must keep working: the container is line-based base64.
    await verifyFileSignature({
      file,
      signature: btoa(text.replace(/\n/g, "\r\n")),
      publicKey: keys.publicKey,
    });
    assertEquals(decodeMinisignSignature(signature).signature.length, 64);
  } finally {
    await removeDirRetry(file);
  }
});

Deno.test("hashFileBlake2b512 matches the in-memory BLAKE2b-512 digest", async () => {
  const file = await tempFile("lumisca");
  try {
    const digest = await hashFileBlake2b512(file);
    assertEquals(digest.length, 64);
    assertEquals(
      [...digest],
      [...blake2b(new TextEncoder().encode("lumisca"), { dkLen: 64 })],
    );
  } finally {
    await removeDirRetry(file);
  }
});

/**
 * Recorded output of the real signing tool (`tauri signer sign` with a
 * thrown-away key), pinning the container the verifier parses. The release
 * workflow re-verifies the real signature of every published archive
 * (scripts/check-server-archive.ts), so a tool that changes the format fails
 * there rather than silently here.
 */
const RECORDED = {
  payload: "lumisca spike payload",
  publicKey:
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDVENTUzMjE4QUY3QzQ1NDMKUldSRFJYeXZHREpWWGE3a3lVNnJ4c2FST09YVUtGVWpXNVpHd0o2L2JRSjJPakNhVnAzSTJ5RE8K",
  signature:
    "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSRFJYeXZHREpWWFRKajdIQ04rTlhjYWJxV2hIdnFCZmlreUw4Y09GclZBNEhvaXV2Yk5ualRHdzZzWlpwZlZmanJtV3ZIUmRzYUxBMjhSRG9WVVR3alNHNjI0TXpSZGdBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg5MTg4MjUzCWZpbGU6cGF5bG9hZC5iaW4KNHVBNWtOTmwzaXdQQkJDMlFRbHdVdUVmQklBS0VSeE9GK0FiUytLRyt1SW5wYWU0c05NS2J3Ukh6U2xnZWNYWXNwNUFiUFl1cUViMnpqNGlBMUgwRHc9PQo=",
};

Deno.test("a recorded tauri signature verifies", async () => {
  const file = await tempFile(RECORDED.payload);
  try {
    await verifyFileSignature({
      file,
      signature: RECORDED.signature,
      publicKey: RECORDED.publicKey,
    });
    await Deno.writeFile(file, new TextEncoder().encode("tampered payload"));
    await assertRejects(
      () =>
        verifyFileSignature({
          file,
          signature: RECORDED.signature,
          publicKey: RECORDED.publicKey,
        }),
      SignatureError,
      "署名が一致しません",
    );
  } finally {
    await removeDirRetry(file);
  }
});
