import { decodeUtf8 } from "../shared/mod.ts";

/** Windows: the pids of every descendant of `rootPid`, walking
 * ParentProcessId recursively. A child keeps its dead parent's PID, so
 * descendants orphaned by an earlier kill are still found by this walk. */
function windowsDescendantPids(rootPid: number): number[] {
  const script = `$root=${rootPid};$found=@{};$queue=@($root);` +
    `while($queue.Count -gt 0){$next=@();foreach($p in $queue){` +
    `$kids=Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" -ErrorAction SilentlyContinue;` +
    `foreach($k in $kids){$id=[int]$k.ProcessId;if(-not $found.ContainsKey($id)){$found[$id]=$true;$next+=$id}}}` +
    `$queue=$next};$found.Keys -join ','`;
  try {
    const { stdout, success } = new Deno.Command("powershell.exe", {
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!success) return [];
    return decodeUtf8(stdout)
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** Force-kill the given pids with one taskkill call (no-op when empty). */
function taskkillPids(pids: number[]): void {
  if (pids.length === 0) return;
  const args: string[] = ["/F"];
  for (const pid of pids) args.push("/PID", String(pid));
  try {
    new Deno.Command("taskkill", {
      args,
      stdout: "null",
      stderr: "null",
    }).outputSync();
  } catch {
    // already exited
  }
}

/** Kill a spawned process and its whole tree, and wait for the kill to be
 * issued. Windows: taskkill /T /F awaited — killing the shell alone would
 * orphan everything it spawned, and the kill must have reached the whole
 * tree before the caller treats the command as dead (a descendant still
 * holding its working directory would otherwise block cleanup). The tree
 * is enumerated up front and every pid killed in one taskkill call, then
 * re-walked a few times: /T enumerates only once, so a child spawned
 * while the enumeration was in flight would otherwise survive as an
 * orphan (its parent dies; the child keeps the dead parent's PID, which
 * the sweep then finds). POSIX: SIGKILL (without a process group the
 * shell's children may survive on POSIX — best available without setsid). */
export async function killProcessTree(
  child: { pid: number; kill(signal: "SIGKILL"): void },
): Promise<void> {
  if (Deno.build.os !== "windows") {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
    return;
  }
  taskkillPids([...windowsDescendantPids(child.pid), child.pid]);
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stragglers = windowsDescendantPids(child.pid);
    if (stragglers.length === 0) return;
    taskkillPids(stragglers);
  }
}
