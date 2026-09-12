/**
 * Signature verification of update archives.
 *
 * The desktop updater (Tauri's plugin) and this one share a single signing
 * identity: release artifacts are signed with `tauri signer sign`, i.e. a
 * minisign signature over BLAKE2b-512(archive) with Ed25519. The format is
 * small enough to parse here, which keeps the standalone server free of a
 * second key to manage and rotation stories to write down. Both halves are
 * verified: the container (2-byte algorithm marker, 8-byte key id, 64-byte
 * signature) and the key id against the compiled-in public key, so a
 * signature made with another key can never be mistaken for a valid one.
 *
 * The digest is the only reason this module needs a crypto dependency:
 * Deno's WebCrypto has Ed25519 but no BLAKE2b (measured — `@noble/hashes`
 * is used for the digest alone, and the signature check itself is
 * WebCrypto).
 */
import { blake2b } from "@noble/hashes/blake2.js";

/**
 * Public key of the release signing key, in the base64 form
 * `tauri.conf.json` carries (`plugins.updater.pubkey`, i.e. the content of
 * the generated `.pub` file). `verify_test.ts` asserts that both files
 * agree, so a rotated desktop key cannot leave this one silently behind.
 */
export const RELEASE_PUBLIC_KEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDNENzdENTM2N0Y1NENBRjEKUldUeHlsUi9OdFYzUGJuZERCc3paSjRBaXY1VDFkelVJR1VUM3Fkei9NMHdlUmxuWmNwcFU5bmgK";

/** Algorithms minisign writes into the fixed-size header of a signature. */
const PUBLIC_KEY_ALGORITHM = "Ed";
/** Signatures Tauri emits: Ed25519 over the BLAKE2b-512 digest of the file
 * (minisign's prehashed mode). */
const SIGNATURE_ALGORITHM = "ED";

const KEY_ID_BYTES = 8;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
/** Header sizes: algorithm marker + key id, before the key material. */
const PUBLIC_KEY_HEADER = 2 + KEY_ID_BYTES;
const SIGNATURE_HEADER = 2 + KEY_ID_BYTES;

/** How many bytes are read per hash update (a 100 MB archive must not be
 * pulled into memory just to be verified). */
const HASH_CHUNK_BYTES = 1 << 20;

/** An archive that cannot be trusted (a broken container, a key mismatch,
 * or a digest that does not match the signature). */
export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureError";
  }
}

/** A minisign public key: its id (which a signature must repeat) and the
 * raw Ed25519 key. */
export interface DecodedPublicKey {
  keyId: Uint8Array<ArrayBuffer>;
  key: Uint8Array<ArrayBuffer>;
}

/** A minisign signature of one file. */
export interface DecodedSignature {
  keyId: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

/** Copy into a plain ArrayBuffer-backed view: WebCrypto's BufferSource
 * arguments reject the ArrayBufferLike-backed flavor the typed-array view
 * methods (slice/subarray) produce. */
function copyBytes(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(source.length);
  copy.set(source);
  return copy;
}

function decodeBase64(encoded: string, what: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(encoded.trim());
  } catch {
    throw new SignatureError(`${what}を base64 として解釈できません`);
  }
  // Built explicitly (rather than Uint8Array.from) so the result is backed
  // by a plain ArrayBuffer: WebCrypto's BufferSource arguments do not
  // accept the ArrayBufferLike-backed flavor the iterator form produces.
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Text lines of a minisign file, CR stripped (a signature that travelled
 * through a tool that rewrites line endings still verifies). */
function minisignLines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/\r$/, ""));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Decode the public key blob `tauri.conf.json` carries: base64 of a
 * minisign key file, whose second line is base64 of
 * `"Ed" + keyId(8) + key(32)`.
 */
export function decodeMinisignPublicKey(encoded: string): DecodedPublicKey {
  const text = new TextDecoder().decode(
    decodeBase64(encoded, "公開鍵"),
  );
  const lines = minisignLines(text).filter((line) => line.trim() !== "");
  const payloadLine = lines[1];
  if (payloadLine === undefined) {
    throw new SignatureError("公開鍵の形式が不正です (2行目がありません)");
  }
  const blob = decodeBase64(payloadLine, "公開鍵");
  if (blob.length !== PUBLIC_KEY_HEADER + PUBLIC_KEY_BYTES) {
    throw new SignatureError(`公開鍵の長さが不正です: ${blob.length} バイト`);
  }
  const algorithm = new TextDecoder().decode(blob.slice(0, 2));
  if (algorithm !== PUBLIC_KEY_ALGORITHM) {
    throw new SignatureError(`公開鍵のアルゴリズムが不正です: "${algorithm}"`);
  }
  return {
    keyId: copyBytes(blob.subarray(2, PUBLIC_KEY_HEADER)),
    key: copyBytes(blob.subarray(PUBLIC_KEY_HEADER)),
  };
}

/**
 * Decode a `.sig` file as `tauri signer sign` writes it: base64 of a
 * minisign signature file, whose second line is base64 of
 * `"ED" + keyId(8) + signature(64)`. The trusted-comment line and its
 * global signature are not used: the global signature only binds the
 * comment text (timestamp / file name), and this updater takes the version
 * and URL from the manifest, never from the comment.
 */
export function decodeMinisignSignature(encoded: string): DecodedSignature {
  const text = new TextDecoder().decode(
    decodeBase64(encoded, "署名"),
  );
  const lines = minisignLines(text).filter((line) => line.trim() !== "");
  const payloadLine = lines[1];
  if (payloadLine === undefined) {
    throw new SignatureError("署名の形式が不正です (2行目がありません)");
  }
  const blob = decodeBase64(payloadLine, "署名");
  if (blob.length !== SIGNATURE_HEADER + SIGNATURE_BYTES) {
    throw new SignatureError(`署名の長さが不正です: ${blob.length} バイト`);
  }
  const algorithm = new TextDecoder().decode(blob.slice(0, 2));
  if (algorithm !== SIGNATURE_ALGORITHM) {
    throw new SignatureError(`署名のアルゴリズムが不正です: "${algorithm}"`);
  }
  return {
    keyId: copyBytes(blob.subarray(2, SIGNATURE_HEADER)),
    signature: copyBytes(blob.subarray(SIGNATURE_HEADER)),
  };
}

/** BLAKE2b-512 digest of a file, read in chunks. */
export async function hashFileBlake2b512(
  path: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const hasher = blake2b.create({ dkLen: 64 });
  const file = await Deno.open(path, { read: true });
  try {
    const buffer = new Uint8Array(HASH_CHUNK_BYTES);
    for (;;) {
      const read = await file.read(buffer);
      if (read === null) break;
      hasher.update(buffer.subarray(0, read));
    }
  } finally {
    file.close();
  }
  // noble's digest carries the ArrayBufferLike flavor; WebCrypto's
  // BufferSource arguments need the plain one.
  return copyBytes(hasher.digest());
}

/**
 * Verify that `file` was signed with `publicKey`. Throws
 * {@link SignatureError} with a user-facing message otherwise.
 *
 * The digest is computed before the key is imported so a corrupt archive
 * fails with "the bytes do not match the signature" rather than an
 * unrelated crypto error, and so a wrong-but-well-formed key still reports
 * the signature mismatch it actually is.
 */
export async function verifyFileSignature(options: {
  file: string;
  /** `.sig` file content (base64 of the minisign signature file). */
  signature: string;
  /** Release key by default; tests and forks pass their own. */
  publicKey?: string;
}): Promise<void> {
  const publicKey = decodeMinisignPublicKey(
    options.publicKey ?? RELEASE_PUBLIC_KEY,
  );
  const signature = decodeMinisignSignature(options.signature);
  if (hex(signature.keyId) !== hex(publicKey.keyId)) {
    throw new SignatureError(
      `署名の鍵 id が公開鍵と一致しません (署名: ${hex(signature.keyId)}, ` +
        `公開鍵: ${hex(publicKey.keyId)})`,
    );
  }
  const digest = await hashFileBlake2b512(options.file);
  const key = await crypto.subtle.importKey(
    "raw",
    publicKey.key,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key,
    signature.signature,
    digest,
  );
  if (!valid) {
    throw new SignatureError("更新アーカイブの署名が一致しません");
  }
}

/** Header offset helpers shared with the tests, so the container layout
 * lives in exactly one place. */
export const MINISIGN_LAYOUT = {
  /** Fixed header of a public key / signature blob. */
  headerBytes: PUBLIC_KEY_HEADER,
  publicKeyBytes: PUBLIC_KEY_BYTES,
  signatureBytes: SIGNATURE_BYTES,
  publicKeyAlgorithm: PUBLIC_KEY_ALGORITHM,
  signatureAlgorithm: SIGNATURE_ALGORITHM,
} as const;
