/**
 * Fixtures shared by the updater's tests.
 *
 * Archives are produced from first principles (a minimal zip writer and a
 * ustar writer) rather than checked in as binaries, so the reader is tested
 * against the container layout instead of against one recorded file. The
 * signer emits the minisign container `tauri signer sign` writes, measured
 * against the real tool (see verify_test.ts for the recorded signature).
 *
 * This module is test-only: nothing in the server's module graph imports it.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { hashFileBlake2b512, MINISIGN_LAYOUT } from "./verify.ts";

export interface FixtureFile {
  name: string;
  /** Text or raw bytes: the release packages carry the server binary, so
   * fixtures must be able to hold opaque data too. */
  content: string | Uint8Array<ArrayBuffer>;
  /** Write the entry uncompressed (exercises the stored path of a zip). */
  stored?: boolean;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function deflateRaw(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(
    new CompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Build a zip file the way the release workflow's packaging does. */
export async function buildZip(
  files: FixtureFile[],
): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  const locals: Uint8Array<ArrayBuffer>[] = [];
  const centrals: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const content = typeof file.content === "string"
      ? encoder.encode(file.content)
      : file.content;
    const method = file.stored ? 0 : 8;
    const data = file.stored ? content : await deflateRaw(content);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc32(content), true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, content.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc32(content), true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, content.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const archive = new Uint8Array(offset + centralSize + eocd.length);
  let cursor = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  return archive;
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const text = value.toString(8).padStart(length - 1, "0") + "\0";
  target.set(new TextEncoder().encode(text), offset);
}

export function ustarHeader(
  name: string,
  size: number,
  typeflag: string,
  mode = 0o755,
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(512);
  const encoder = new TextEncoder();
  header.set(encoder.encode(name).subarray(0, 100), 0);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 1_700_000_000);
  header.fill(0x20, 148, 156);
  header.set(encoder.encode(typeflag), 156);
  header.set(encoder.encode("ustar\0" + "00"), 257);
  header.set(encoder.encode("root"), 265);
  header.set(encoder.encode("root"), 297);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.set(
    encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "),
    148,
  );
  return header;
}

/** Build a gzipped tar file (the POSIX package format). */
export async function buildTarGz(
  files: FixtureFile[],
): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  const blocks: Uint8Array<ArrayBuffer>[] = [];
  for (const file of files) {
    const content = typeof file.content === "string"
      ? encoder.encode(file.content)
      : file.content;
    blocks.push(ustarHeader(file.name, content.length, "0"));
    const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
    padded.set(content);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const tar = new Uint8Array(
    blocks.reduce((sum, block) => sum + block.length, 0),
  );
  let cursor = 0;
  for (const block of blocks) {
    tar.set(block, cursor);
    cursor += block.length;
  }
  const stream = new Blob([tar]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A throwaway key pair standing in for the release key. */
export interface SigningKeys {
  /** Public key blob in the form `tauri.conf.json` carries. */
  publicKey: string;
  /** Produce the `.sig` file content for a file. */
  sign(file: string): Promise<string>;
}

export async function createSigningKeys(): Promise<SigningKeys> {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const rawPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", keys.publicKey),
  );
  const blob = new Uint8Array(
    MINISIGN_LAYOUT.headerBytes + MINISIGN_LAYOUT.publicKeyBytes,
  );
  blob.set(new TextEncoder().encode(MINISIGN_LAYOUT.publicKeyAlgorithm), 0);
  blob.set(rawPublic.slice(0, 8), 2);
  blob.set(rawPublic, MINISIGN_LAYOUT.headerBytes);
  const publicText =
    `untrusted comment: minisign public key: 0000000000000000\n${
      base64(blob)
    }\n`;

  return {
    publicKey: base64(new TextEncoder().encode(publicText)),
    async sign(file: string): Promise<string> {
      const digest = await hashFileBlake2b512(file);
      const signature = new Uint8Array(
        await crypto.subtle.sign("Ed25519", keys.privateKey, digest),
      );
      const signatureBlob = new Uint8Array(
        MINISIGN_LAYOUT.headerBytes + MINISIGN_LAYOUT.signatureBytes,
      );
      signatureBlob.set(
        new TextEncoder().encode(MINISIGN_LAYOUT.signatureAlgorithm),
        0,
      );
      signatureBlob.set(rawPublic.slice(0, 8), 2);
      signatureBlob.set(signature, MINISIGN_LAYOUT.headerBytes);
      const text = [
        "untrusted comment: signature from tauri secret key",
        base64(signatureBlob),
        `trusted comment: timestamp:1789188253\tfile:${
          file.replace(/^.*[\\/]/, "")
        }`,
        base64(signature),
        "",
      ].join("\n");
      return base64(new TextEncoder().encode(text));
    },
  };
}

/** BLAKE2b-512 of a byte string (used by tests that sign in-memory). */
export function digestOf(bytes: Uint8Array): Uint8Array {
  return blake2b(bytes, { dkLen: 64 });
}
