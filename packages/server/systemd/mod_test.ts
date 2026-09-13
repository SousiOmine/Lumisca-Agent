import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { pathUnitValue, quoteUnitValue } from "./compose.ts";
import { runServiceCommand, type ServiceDeps } from "./mod.ts";
import { DOCUMENT_NAME, UNIT_NAME } from "./plan.ts";
import type { CommandResult, ServiceRunner } from "./runner.ts";
import { SETTINGS_DIR_NAME } from "@lumisca/core";

/** A systemd that keeps the state the verbs ask about, so the whole command
 * can run without a user manager. */
class FakeSystemd {
  readonly calls: string[] = [];
  active = false;
  enabled = false;
  /** Whether `enable-linger` actually grants lingering (polkit refuses it on
   * some distributions). */
  grantLinger = true;
  linger = false;
  /** Command whose result must be a failure (systemd reporting a problem). */
  failOn: string | undefined;

  readonly runner: ServiceRunner = {
    systemctl: (args) =>
      this.#run(`systemctl ${args.join(" ")}`, () => {
        const [verb, ...rest] = args;
        switch (verb) {
          case "daemon-reload":
            return ok();
          case "is-active":
            return rest[0] === UNIT_NAME && this.active
              ? ok("active")
              : result(3, "inactive");
          case "is-enabled":
            return rest[0] === UNIT_NAME && this.enabled
              ? ok("enabled")
              : result(1, "disabled");
          case "enable":
            this.enabled = true;
            return ok();
          case "disable":
            this.active = false;
            this.enabled = false;
            return ok();
          case "restart":
            this.active = true;
            return ok();
          default:
            return result(1, `unknown verb ${verb}`);
        }
      }),
    loginctl: (args) =>
      this.#run(`loginctl ${args.join(" ")}`, () => {
        const [verb] = args;
        if (verb === "enable-linger") {
          if (this.grantLinger) this.linger = true;
          else return result(1, "Access denied");
          return ok();
        }
        if (verb === "show-user") {
          return ok(`Linger=${this.linger ? "yes" : "no"}`);
        }
        return result(1, `unknown verb ${verb}`);
      }),
  };

  #run(call: string, respond: () => CommandResult): Promise<CommandResult> {
    this.calls.push(call);
    if (this.failOn === call) {
      return Promise.resolve(result(1, "Unit entered failed state"));
    }
    return Promise.resolve(respond());
  }

  has(prefix: string): boolean {
    return this.calls.some((call) => call.startsWith(prefix));
  }
}

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

function result(code: number, stdout: string): CommandResult {
  return { code, stdout, stderr: stdout };
}

interface Harness {
  root: string;
  installDir: string;
  configHome: string;
  unitPath: string;
  documentPath: string;
  deps: ServiceDeps;
  systemd: FakeSystemd;
  lines: string[];
  errors: string[];
  cleanup: () => Promise<void>;
}

async function harness(
  options: {
    os?: string;
    standalone?: boolean;
    desktopManaged?: boolean;
    probe?: boolean;
    generateToken?: () => string;
    interfaces?: Deno.NetworkInterfaceInfo[];
  } = {},
): Promise<Harness> {
  const root = await Deno.makeTempDir({ prefix: "lumisca-service-test-" });
  const installDir = join(root, "install");
  await Deno.mkdir(installDir, { recursive: true });
  const os = options.os ?? "linux";
  const execPath = join(
    installDir,
    os === "windows" ? "lumisca-server.exe" : "lumisca-server",
  );
  await Deno.writeTextFile(execPath, "");
  const configHome = join(root, "config");
  const systemd = new FakeSystemd();
  const lines: string[] = [];
  const errors: string[] = [];
  const deps: ServiceDeps = {
    host: {
      os,
      standalone: options.standalone ?? true,
      desktopManaged: options.desktopManaged ?? false,
      execPath,
      home: join(root, "home"),
      user: "tester",
      cwd: root,
      xdgConfigHome: configHome,
    },
    runner: systemd.runner,
    probe: () => Promise.resolve(options.probe ?? true),
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    // Short enough to keep the tests quick, long enough to poll twice.
    probeIntervalMs: 1,
    probeTimeoutMs: 20,
    generateToken: options.generateToken ?? (() => "generated-token"),
    interfaces: () => options.interfaces ?? [],
  };
  return {
    root,
    installDir,
    configHome,
    unitPath: join(configHome, "systemd", "user", UNIT_NAME),
    documentPath: join(configHome, SETTINGS_DIR_NAME, DOCUMENT_NAME),
    deps,
    systemd,
    lines,
    errors,
    cleanup: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return undefined;
  }
}

/** A port nothing is listening on right now. */
function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

Deno.test("install writes the definition and starts the service", async () => {
  const test = await harness();
  try {
    const code = await runServiceCommand(["install"], test.deps);
    assertEquals(code, 0, test.errors.join("\n"));

    const unit = await Deno.readTextFile(test.unitPath);
    assertStringIncludes(
      unit,
      `ExecStart=${quoteUnitValue(test.deps.host.execPath)}`,
    );
    assertStringIncludes(
      unit,
      `WorkingDirectory=${pathUnitValue(test.installDir)}`,
    );
    assertStringIncludes(
      unit,
      `EnvironmentFile=${pathUnitValue(test.documentPath)}`,
    );
    assertStringIncludes(unit, "Restart=always");

    const document = await Deno.readTextFile(test.documentPath);
    assertStringIncludes(document, 'LUMISCA_HOST="127.0.0.1"');
    assertStringIncludes(document, 'LUMISCA_PORT="8000"');
    assertStringIncludes(document, 'LUMISCA_TOKEN="generated-token"');
    assertStringIncludes(document, 'LUMISCA_UPDATE_RESTART="supervisor"');

    // systemd owns the lifecycle: reload after writing, enable, then restart
    // (which is what applies a changed definition to a running service).
    assert(test.systemd.has("systemctl daemon-reload"));
    assert(test.systemd.has(`systemctl enable ${UNIT_NAME}`));
    assert(test.systemd.has(`systemctl restart ${UNIT_NAME}`));
    assert(test.systemd.has("loginctl enable-linger tester"));
    // The check creates the staging area the updater will use and leaves no
    // probe file behind.
    const staging = join(test.installDir, ".lumisca-update");
    assert((await Deno.stat(staging)).isDirectory);
    assertEquals(await readIfPresent(join(staging, ".write-test")), undefined);

    const output = test.lines.join("\n");
    assertStringIncludes(output, "疎通確認: ok");
    assertStringIncludes(output, "自動起動: ok");
    assertStringIncludes(
      output,
      "http://127.0.0.1:8000/?token=generated-token",
    );
    assertStringIncludes(output, "journalctl --user -u lumisca");
    assertEquals(test.errors, []);
  } finally {
    await test.cleanup();
  }
});

Deno.test("reinstalling keeps the installed values and credential", async () => {
  const test = await harness();
  try {
    assertEquals(
      await runServiceCommand(["install", "--port", "8100"], test.deps),
      0,
    );
    // A second install must not generate a credential: the clients that
    // already hold the installed one would be locked out.
    test.deps.generateToken = () => {
      throw new Error("must not regenerate the credential");
    };
    assertEquals(await runServiceCommand(["install"], test.deps), 0);
    const document = await Deno.readTextFile(test.documentPath);
    assertStringIncludes(document, 'LUMISCA_PORT="8100"');
    assertStringIncludes(document, 'LUMISCA_TOKEN="generated-token"');
  } finally {
    await test.cleanup();
  }
});

Deno.test("explicit flags override the installed layer", async () => {
  const test = await harness();
  try {
    assertEquals(
      await runServiceCommand(["install", "--port", "8100"], test.deps),
      0,
    );
    assertEquals(
      await runServiceCommand([
        "install",
        "--port",
        "8200",
        "--db",
        "data/x.db",
      ], test.deps),
      0,
    );
    const document = await Deno.readTextFile(test.documentPath);
    assertStringIncludes(document, 'LUMISCA_PORT="8200"');
    // A relative database path is resolved at install time, so the unit does
    // not depend on systemd's working directory.
    assertStringIncludes(
      document,
      `LUMISCA_DB="${join(test.root, "data", "x.db").replace(/\\/g, "\\\\")}"`,
    );
  } finally {
    await test.cleanup();
  }
});

Deno.test("install refuses a port another process holds", async () => {
  const test = await harness();
  const port = freePort();
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  try {
    const code = await runServiceCommand(
      ["install", "--port", String(port)],
      test.deps,
    );
    assertEquals(code, 2);
    assertStringIncludes(test.errors.join("\n"), "既に使用中です");
    assertEquals(await readIfPresent(test.unitPath), undefined);
    assertEquals(await readIfPresent(test.documentPath), undefined);
  } finally {
    listener.close();
    await test.cleanup();
  }
});

Deno.test("an active unit owns its port, so a reinstall does not test it", async () => {
  const test = await harness();
  const port = freePort();
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  test.systemd.active = true;
  try {
    const code = await runServiceCommand(
      ["install", "--port", String(port)],
      test.deps,
    );
    assertEquals(code, 0, test.errors.join("\n"));
    assert(test.systemd.has(`systemctl restart ${UNIT_NAME}`));
  } finally {
    listener.close();
    await test.cleanup();
  }
});

Deno.test("install fails fast where a user unit cannot work", async () => {
  for (
    const [options, expected] of [
      [{ os: "windows" }, "Linux のみ対応"],
      [{ standalone: false }, "パッケージ済みサーバー"],
      [{ desktopManaged: true }, "デスクトップアプリ"],
    ] as const
  ) {
    const test = await harness(options);
    try {
      const code = await runServiceCommand(["install"], test.deps);
      assertEquals(code, 2, `${JSON.stringify(options)} must be refused`);
      assertStringIncludes(test.errors.join("\n"), expected);
      assertEquals(await readIfPresent(test.unitPath), undefined);
      assertEquals(test.systemd.calls, []);
    } finally {
      await test.cleanup();
    }
  }
});

Deno.test("a systemd failure is reported with the reason it gave", async () => {
  const test = await harness();
  test.systemd.failOn = `systemctl restart ${UNIT_NAME}`;
  try {
    const code = await runServiceCommand(["install"], test.deps);
    assertEquals(code, 1);
    assertStringIncludes(test.errors.join("\n"), "Unit entered failed state");
    // The definition is on disk: the operator fixes the reason and restarts.
    assert((await readIfPresent(test.unitPath)) !== undefined);
  } finally {
    await test.cleanup();
  }
});

Deno.test("a server that never answers is a failure, not a silent success", async () => {
  const test = await harness({ probe: false });
  try {
    const code = await runServiceCommand(["install"], test.deps);
    assertEquals(code, 1);
    assertStringIncludes(test.lines.join("\n"), "疎通確認: 応答がありません");
    assertStringIncludes(
      test.errors.join("\n"),
      "journalctl --user -u lumisca",
    );
  } finally {
    await test.cleanup();
  }
});

Deno.test("a unit that cannot start at boot is a failure, with the one command left", async () => {
  const test = await harness();
  test.systemd.grantLinger = false;
  try {
    const code = await runServiceCommand(["install"], test.deps);
    assertEquals(code, 1);
    assertStringIncludes(
      test.errors.join("\n"),
      "sudo loginctl enable-linger tester",
    );
  } finally {
    await test.cleanup();
  }
});

Deno.test("install names every address a wildcard bind answers on", async () => {
  const test = await harness({
    interfaces: [
      {
        name: "eth0",
        family: "IPv4",
        address: "192.168.1.5",
        netmask: "255.255.255.0",
        scopeid: 0,
        mac: "00:00:00:00:00:00",
        cidr: "192.168.1.5/24",
      },
      {
        name: "lo",
        family: "IPv4",
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        scopeid: 0,
        mac: "00:00:00:00:00:00",
        cidr: "127.0.0.1/8",
      },
    ],
  });
  try {
    const code = await runServiceCommand(
      ["install", "--host", "0.0.0.0", "--allowed-hosts", "homeserver"],
      test.deps,
    );
    assertEquals(code, 0, test.errors.join("\n"));
    const output = test.lines.join("\n");
    assertStringIncludes(output, "http://127.0.0.1:8000/?token=");
    assertStringIncludes(output, "http://192.168.1.5:8000/?token=");
    const document = await Deno.readTextFile(test.documentPath);
    assertStringIncludes(document, 'LUMISCA_HOST="0.0.0.0"');
    assertStringIncludes(document, 'LUMISCA_ALLOWED_HOSTS="homeserver"');
  } finally {
    await test.cleanup();
  }
});

Deno.test("config shows what install would write, and changes nothing", async () => {
  const test = await harness();
  try {
    // `config` needs no systemd and no installed unit: it is the preview the
    // plan is made from.
    assertEquals(await runServiceCommand(["config"], test.deps), 0);
    assertEquals(test.systemd.calls, []);
    const preview = test.lines.join("\n");
    assertStringIncludes(preview, test.unitPath);
    assertStringIncludes(
      preview,
      `ExecStart=${quoteUnitValue(test.deps.host.execPath)}`,
    );
    assertStringIncludes(preview, "LUMISCA_TOKEN=<伏せ字>");
    assert(!preview.includes("generated-token"));
    assertEquals(preview.includes("not-installed"), false);
    assertEquals(await readIfPresent(test.unitPath), undefined);
    assertEquals(await readIfPresent(test.documentPath), undefined);
  } finally {
    await test.cleanup();
  }
});

Deno.test("config layers the installed document, --defaults does not", async () => {
  const test = await harness();
  try {
    assertEquals(
      await runServiceCommand(["install", "--port", "8100"], test.deps),
      0,
    );
    test.lines.length = 0;
    assertEquals(await runServiceCommand(["config"], test.deps), 0);
    assertStringIncludes(test.lines.join("\n"), 'LUMISCA_PORT="8100"');

    test.lines.length = 0;
    assertEquals(
      await runServiceCommand(["config", "--defaults"], test.deps),
      0,
    );
    const defaults = test.lines.join("\n");
    assertStringIncludes(defaults, 'LUMISCA_PORT="8000"');
    assert(!defaults.includes("8100"));
  } finally {
    await test.cleanup();
  }
});

Deno.test("config still requires a packaged server", async () => {
  const test = await harness({ standalone: false });
  try {
    assertEquals(await runServiceCommand(["config"], test.deps), 2);
    assertStringIncludes(test.errors.join("\n"), "パッケージ済みサーバー");
  } finally {
    await test.cleanup();
  }
});

Deno.test("status reports the installation, its drift, and where it is", async () => {
  const test = await harness();
  try {
    // Nothing installed yet.
    assertEquals(await runServiceCommand(["status"], test.deps), 1);
    assertStringIncludes(test.lines.join("\n"), "未インストール");

    assertEquals(
      await runServiceCommand(["install", "--port", "8100"], test.deps),
      0,
    );
    test.lines.length = 0;
    assertEquals(await runServiceCommand(["status"], test.deps), 0);
    const healthy = test.lines.join("\n");
    assertStringIncludes(healthy, "稼働:     active");
    assertStringIncludes(healthy, "自動起動: enabled / linger 有効");
    assertStringIncludes(
      healthy,
      "http://127.0.0.1:8100/?token=generated-token",
    );
    assert(!healthy.includes("一致しません"));

    // A unit written by another version of the template is drift: status must
    // not report a healthy installation that a restart would change.
    await Deno.writeTextFile(test.unitPath, "[Service]\nType=simple\n");
    test.lines.length = 0;
    assertEquals(await runServiceCommand(["status"], test.deps), 1);
    assertStringIncludes(test.lines.join("\n"), "一致しません");
  } finally {
    await test.cleanup();
  }
});

Deno.test("status reports an inactive or non-lingering installation as unhealthy", async () => {
  const test = await harness();
  try {
    assertEquals(await runServiceCommand(["install"], test.deps), 0);
    test.systemd.active = false;
    test.lines.length = 0;
    assertEquals(await runServiceCommand(["status"], test.deps), 1);
    assertStringIncludes(test.lines.join("\n"), "稼働:     inactive");

    test.systemd.active = true;
    test.systemd.linger = false;
    test.lines.length = 0;
    assertEquals(await runServiceCommand(["status"], test.deps), 1);
    assertStringIncludes(
      test.lines.join("\n"),
      "sudo loginctl enable-linger tester",
    );
  } finally {
    await test.cleanup();
  }
});

Deno.test("uninstall stops the unit and keeps the operator's state", async () => {
  const test = await harness();
  try {
    assertEquals(await runServiceCommand(["uninstall"], test.deps), 1);
    assertStringIncludes(test.lines.join("\n"), "削除するユニットがありません");

    assertEquals(
      await runServiceCommand(["install", "--db", "data/x.db"], test.deps),
      0,
    );
    test.lines.length = 0;
    assertEquals(await runServiceCommand(["uninstall"], test.deps), 0);
    assert(test.systemd.has(`systemctl disable --now ${UNIT_NAME}`));
    assertEquals(await readIfPresent(test.unitPath), undefined);
    // The document holds the credential: keeping it is what lets a later
    // reinstall leave installed clients working.
    assert((await readIfPresent(test.documentPath)) !== undefined);
    const output = test.lines.join("\n");
    assertStringIncludes(output, test.documentPath);
    assertStringIncludes(output, join(test.root, "data", "x.db"));
    assertStringIncludes(output, "loginctl disable-linger tester");
  } finally {
    await test.cleanup();
  }
});

Deno.test("the command line is answered on the command line, not the service deps", async () => {
  const test = await harness();
  const logged: string[] = [];
  const errored: string[] = [];
  const original = { log: console.log, error: console.error };
  console.log = (line: string) => void logged.push(String(line));
  console.error = (line: string) => void errored.push(String(line));
  try {
    // `--help` is not an error, and must work even where the deps cannot be
    // built (it never builds them).
    assertEquals(await runServiceCommand(["--help"], test.deps), 0);
    assertStringIncludes(logged.join("\n"), "使い方:");
    assertEquals(errored, []);

    logged.length = 0;
    // An unknown verb or an option from another mode is a usage error, and
    // the usage text says what the accepted surface is.
    assertEquals(await runServiceCommand(["restart"], test.deps), 2);
    assertStringIncludes(errored.join("\n"), "不明なサブコマンド");
    assertStringIncludes(errored.join("\n"), "使い方:");
    assertEquals(test.systemd.calls, []);
    assertEquals(await readIfPresent(test.unitPath), undefined);
  } finally {
    console.log = original.log;
    console.error = original.error;
    await test.cleanup();
  }
});

Deno.test("a machine this command cannot resolve is reported, never a silent exit", async () => {
  // Reproduces a packaged-server bug the smoke test caught: resolving HOME and
  // the user happens inside the error mapping, so a missing HOME exits 2 with
  // a message. Building it outside let the rejection reach the server's
  // unhandled-rejection handler, which prints and keeps running — the process
  // then drained its event loop and exited 0 with no output at all.
  const errored: string[] = [];
  const original = { error: console.error };
  console.error = (line: string) => void errored.push(String(line));
  const env = { HOME: Deno.env.get("HOME"), USER: Deno.env.get("USER") };
  try {
    Deno.env.delete("HOME");
    Deno.env.delete("USER");
    Deno.env.delete("USERPROFILE");
    Deno.env.delete("USERNAME");
    const code = await runServiceCommand(["config", "--defaults"]);
    assertEquals(code, 2);
    assertStringIncludes(errored.join("\n"), "HOME が設定されていません");
  } finally {
    console.error = original.error;
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) Deno.env.set(key, value);
    }
  }
});
