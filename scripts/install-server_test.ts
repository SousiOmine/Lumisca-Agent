import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "@std/assert";

/** The bootstrap is Linux-only, because the service it installs is a systemd
 * user unit. The tests run it with a fake curl and a fake archive, so no
 * network or systemd is involved. */
const linux = process.platform === "linux";
const SCRIPT = new URL("../install-server.sh", import.meta.url).pathname;

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("install-server: --help names the options and the root rule", () => {
  if (!linux) return;
  const result = run(["--help"]);
  assertEquals(result.status, 0);
  assertStringIncludes(result.stdout, "--no-service");
  assertStringIncludes(result.stdout, "root では実行しないでください");
});

test("install-server: a bad port is refused before anything is read", () => {
  if (!linux) return;
  const result = run(["--port", "99999", "--no-service"]);
  assertEquals(result.status, 1);
  assertStringIncludes(result.stderr, "1 から 65535");
});

test("install-server: --no-service downloads, checks and places the package", () => {
  if (!linux) return;
  const root = fs.mkdtempSync(join(tmpdir(), "lumisca-install-test-"));
  try {
    const fixture = join(root, "fixture");
    const payload = join(fixture, "lumisca-server-linux-x64");
    fs.mkdirSync(payload, { recursive: true });
    const binary = join(payload, "lumisca-server");
    fs.writeFileSync(binary, "#!/bin/sh\necho fake\n");
    fs.chmodSync(binary, 0o755);
    const archive = join(fixture, "archive.tar.gz");
    const tar = spawnSync(
      "tar",
      ["-czf", archive, "-C", fixture, "lumisca-server-linux-x64"],
      { encoding: "utf8" },
    );
    assertEquals(tar.status, 0, tar.stderr);

    const manifest = {
      version: "9.9.9",
      target: "x86_64-unknown-linux-gnu",
      url: "https://example.test/lumisca-server-9.9.9-linux-x64.tar.gz",
      size: fs.statSync(archive).size,
      signature: "test",
    };
    fs.writeFileSync(
      join(fixture, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    const bin = join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      join(bin, "curl"),
      `#!/bin/sh
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --retry | --connect-timeout) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *latest-server*) cp "$FIXTURE/manifest.json" "$out" ;;
  *) cp "$FIXTURE/archive.tar.gz" "$out" ;;
esac
`,
    );
    fs.chmodSync(join(bin, "curl"), 0o755);

    const dir = join(root, "server");
    const result = run(["--version", "9.9.9", "--dir", dir, "--no-service"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FIXTURE: fixture,
    });
    assertEquals(result.status, 0, result.stderr);
    assertStringIncludes(result.stdout, "Lumisca v9.9.9");
    const installed = join(dir, "lumisca-server");
    assertEquals(fs.existsSync(installed), true);
    assertEquals((fs.statSync(installed).mode & 0o111) !== 0, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
