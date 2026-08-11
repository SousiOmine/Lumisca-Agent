import { cpus, release } from "node:os";

/** Model facts for the system prompt's environment section. */
export interface EnvironmentModel {
  provider: string;
  modelId: string;
  /** Human-readable display name (falls back to provider/modelId). */
  name?: string;
}

/** Trimmed stdout of a probe command, or undefined when it fails (missing
 * binary, permission denied, nonzero exit). */
function probeOutput(command: string, args: string[]): string | undefined {
  try {
    const out = new Deno.Command(command, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (!out.success) return undefined;
    return new TextDecoder().decode(out.stdout).trim();
  } catch {
    return undefined;
  }
}

/** e.g. "Windows (x86_64) 10.0.26200". The kernel version needs --allow-sys
 * and is dropped when unavailable. */
function detectOs(): string {
  const os = Deno.build.os === "windows"
    ? "Windows"
    : Deno.build.os === "darwin"
    ? "macOS"
    : Deno.build.os === "linux"
    ? "Linux"
    : Deno.build.os;
  let version = "";
  try {
    version = ` ${release()}`;
  } catch {
    // no --allow-sys: best-effort, omit the version
  }
  return `${os} (${Deno.build.arch})${version}`;
}

/** e.g. "AMD Ryzen 7 7700 8-Core Processor (16 threads)". Windows pads the
 * model with NULs and spaces, hence the cleanup. */
function detectCpu(): string | undefined {
  try {
    const cores = cpus();
    const model = cores[0]?.model.replaceAll("\0", "").trim();
    if (!model) return undefined;
    return `${model} (${cores.length} threads)`;
  } catch {
    return undefined;
  }
}

let gpuProbed = false;
let gpuResult: string | undefined;

/** Best-effort GPU name(s), probed once per process and cached: spawning a
 * command on every session creation would be wasteful. Failures (missing
 * lspci, no display hardware, permission gaps) yield undefined. */
function detectGpu(): string | undefined {
  if (gpuProbed) return gpuResult;
  gpuProbed = true;
  switch (Deno.build.os) {
    case "windows": {
      // Get-CimInstance is the modern replacement for the deprecated wmic.
      const out = probeOutput("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_VideoController).Name -join ', '",
      ]);
      gpuResult = out ? out.split("\n").join(", ") : undefined;
      break;
    }
    case "darwin": {
      const out = probeOutput("system_profiler", [
        "SPDisplaysDataType",
        "-detailLevel",
        "mini",
      ]);
      gpuResult = out
        ?.split("\n")
        .map((l) => l.match(/Chipset Model:\s*(.+)/)?.[1])
        .filter((name): name is string => name !== undefined)
        .join(", ") || undefined;
      break;
    }
    case "linux": {
      // lspci lines like "0000:01:00.0 VGA compatible controller: NVIDIA
      // Corporation GA106 [GeForce RTX 3060]" — keep only the device part.
      const out = probeOutput("lspci", []);
      gpuResult = out
        ?.split("\n")
        .filter((l) => /vga|3d|display/i.test(l))
        .map((l) => l.replace(/^\S+\s*/, ""))
        .join(", ") || undefined;
      break;
    }
    default:
      gpuResult = undefined;
  }
  return gpuResult;
}

/** The terminal the app runs in, or undefined when launched without one
 * (e.g. a desktop app). */
function detectTerminal(): string | undefined {
  try {
    const program = Deno.env.get("TERM_PROGRAM");
    if (program) {
      const version = Deno.env.get("TERM_PROGRAM_VERSION");
      return version ? `${program} ${version}` : program;
    }
    if (Deno.env.get("WT_SESSION") !== undefined) return "Windows Terminal";
    const term = Deno.env.get("TERM");
    if (term && term !== "dumb" && term !== "unknown") return term;
  } catch {
    // no --allow-env: best-effort, omit the terminal
  }
  return undefined;
}

/** e.g. "2026-08-11 (Tuesday)". */
function today(): string {
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  return `${now.toISOString().slice(0, 10)} (${weekday})`;
}

function modelLabel(model: EnvironmentModel | undefined): string | undefined {
  if (!model) return undefined;
  return model.name ?? `${model.provider}/${model.modelId}`;
}

/** The environment section of the system prompt: machine facts, the model
 * and today's date, so the agent knows what it runs on and when. Bullets
 * whose facts could not be detected are omitted; the date is always
 * included (it is the only fact the model cannot observe). */
export function buildEnvironmentSection(model?: EnvironmentModel): string {
  const bullets = [`- OS: ${detectOs()}`];
  const cpu = detectCpu();
  if (cpu) bullets.push(`- CPU: ${cpu}`);
  const gpu = detectGpu();
  if (gpu) bullets.push(`- GPU: ${gpu}`);
  const terminal = detectTerminal();
  if (terminal) bullets.push(`- Terminal: ${terminal}`);
  const label = modelLabel(model);
  if (label) bullets.push(`- Model: ${label}`);
  bullets.push(`- Date: ${today()}`);
  return `\n\nEnvironment:\n${bullets.join("\n")}`;
}
