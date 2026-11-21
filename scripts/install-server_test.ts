import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertEquals, assertStringIncludes } from "@std/assert";

/** The bootstrap is Linux-only, because the service it installs is a systemd
 * user unit. The tests run it with a fake curl and a fake archive, so no
 * network or systemd is involved. */
const linux = process.platform === "linux";
const SCRIPT = fileURLToPath(new URL("../install-server.sh", import.meta.url));

/** A podman that only has to satisfy `command -v podman`: the script does not
 * run it. Every test that does not exercise the installation path puts this
 * directory first in PATH. */
const PODMAN_SHIM = fs.mkdtempSync(join(tmpdir(), "lumisca-podman-shim-"));
fs.writeFileSync(join(PODMAN_SHIM, "podman"), "#!/bin/sh\nexit 0\n");
fs.chmodSync(join(PODMAN_SHIM, "podman"), 0o755);
process.on("exit", () =>
  fs.rmSync(PODMAN_SHIM, { recursive: true, force: true }),
);

/** Commands the script itself invokes. A test that needs podman to look
 * absent builds PATH from these symlinks alone, so a podman installed on the
 * machine running the tests cannot change the result. */
const TOOLS = [
  "bash",
  "uname",
  "id",
  "tar",
  "gzip",
  "mktemp",
  "sed",
  "head",
  "wc",
  "tr",
  "mkdir",
  "basename",
  "cat",
  "cp",
  "chmod",
  "mv",
  "rm",
];

function toolDir(root: string): string {
  const dir = join(root, "tools");
  fs.mkdirSync(dir);
  for (const name of TOOLS) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], {
      encoding: "utf8",
    });
    const path = found.stdout.trim();
    if (path !== "") fs.symlinkSync(path, join(dir, name));
  }
  return dir;
}

function run(
  args: string[],
  env: Record<string, string> = {},
  extraPath: string[] = [PODMAN_SHIM],
) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [...extraPath, process.env.PATH ?? ""].join(":"),
      ...env,
    },
  });
}

function makeFixture(root: string): string {
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
  return fixture;
}

function writeFakeCurl(bin: string): void {
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
}

function writeFakeSudo(bin: string): void {
  fs.writeFileSync(
    join(bin, "sudo"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$SUDO_LOG"
exec "$@"
`,
  );
  fs.chmodSync(join(bin, "sudo"), 0o755);
}

function writeFakeApt(bin: string, installPodman: boolean): void {
  const create = installPodman
    ? `  cat > "$SHIM/podman" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$SHIM/podman"
`
    : "  :\n";
  fs.writeFileSync(
    join(bin, "apt-get"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$APT_LOG"
if [ "$1" = "install" ]; then
${create}fi
`,
  );
  fs.chmodSync(join(bin, "apt-get"), 0o755);
}

test("install-server: --help names the options and the root rule", () => {
  if (!linux) return;
  const result = run(["--help"]);
  assertEquals(result.status, 0);
  assertStringIncludes(result.stdout, "--no-service");
  assertStringIncludes(result.stdout, "podman");
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
    const fixture = makeFixture(root);
    const bin = join(root, "bin");
    fs.mkdirSync(bin);
    writeFakeCurl(bin);

    const dir = join(root, "server");
    const result = run(["--version", "9.9.9", "--dir", dir, "--no-service"], {
      PATH: [bin, PODMAN_SHIM, process.env.PATH ?? ""].join(":"),
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

test("install-server: a missing podman is installed before the download", () => {
  if (!linux) return;
  const root = fs.mkdtempSync(join(tmpdir(), "lumisca-install-test-"));
  try {
    const fixture = makeFixture(root);
    const bin = join(root, "bin");
    fs.mkdirSync(bin);
    writeFakeCurl(bin);
    writeFakeSudo(bin);
    writeFakeApt(bin, true);
    const tools = toolDir(root);
    const aptLog = join(root, "apt.log");
    const sudoLog = join(root, "sudo.log");

    const dir = join(root, "server");
    const result = run(["--version", "9.9.9", "--dir", dir, "--no-service"], {
      PATH: [bin, tools].join(":"),
      FIXTURE: fixture,
      SHIM: bin,
      APT_LOG: aptLog,
      SUDO_LOG: sudoLog,
    });
    assertEquals(result.status, 0, result.stderr);
    assertStringIncludes(result.stdout, "podman が見つかりません");
    assertStringIncludes(fs.readFileSync(aptLog, "utf8"), "update");
    assertStringIncludes(fs.readFileSync(aptLog, "utf8"), "install -y podman");
    assertStringIncludes(fs.readFileSync(sudoLog, "utf8"), "apt-get");
    assertEquals(fs.existsSync(join(bin, "podman")), true);
    assertEquals(fs.existsSync(join(dir, "lumisca-server")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("install-server: a package manager that leaves podman missing stops the install", () => {
  if (!linux) return;
  const root = fs.mkdtempSync(join(tmpdir(), "lumisca-install-test-"));
  try {
    const fixture = makeFixture(root);
    const bin = join(root, "bin");
    fs.mkdirSync(bin);
    writeFakeCurl(bin);
    writeFakeSudo(bin);
    writeFakeApt(bin, false);
    const tools = toolDir(root);

    const result = run(
      ["--version", "9.9.9", "--dir", join(root, "server"), "--no-service"],
      {
        PATH: [bin, tools].join(":"),
        FIXTURE: fixture,
        SHIM: bin,
        APT_LOG: join(root, "apt.log"),
        SUDO_LOG: join(root, "sudo.log"),
      },
    );
    assertEquals(result.status, 1);
    assertStringIncludes(result.stderr, "PATH から見つかりません");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
