import { decodeUtf8 } from "../../shared/mod.ts";
import { sleep } from "../../shared/misc.ts";

/** How many sweeps a POSIX tree gets before its root is killed, and how
 * long each waits: the sweep exists to catch a child spawned while the
 * process table was being read, and it must stay short enough that a kill
 * (and with it a tool call or a session close) settles promptly. */
const KILL_SWEEP_ATTEMPTS = 3;
const KILL_SWEEP_DELAY_MS = 100;

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

/** POSIX: the pids of every descendant of `rootPid`, deepest first, read
 * from one snapshot of the process table (`ps` is POSIX standard and
 * present on Linux and macOS alike; the table's header line fails the
 * numeric check). The order matters for the kill below: every child is
 * signalled before its parent. */
function posixDescendantPids(rootPid: number): number[] {
  let stdout: Uint8Array;
  try {
    ({ stdout } = new Deno.Command("ps", {
      args: ["-eo", "pid,ppid"],
      stdout: "piped",
      stderr: "null",
    }).outputSync());
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of decodeUtf8(stdout).split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number.parseInt(pidText ?? "", 10);
    const ppid = Number.parseInt(ppidText ?? "", 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = children.get(ppid);
    if (list === undefined) children.set(ppid, [pid]);
    else list.push(pid);
  }
  // Depth-first post-order: a child is emitted after its own subtree, so
  // the signal below always reaches a descendant before its parent. The
  // seen-set cannot fire on a real table (PIDs are unique and threads are
  // not listed), it only keeps a recycled parent link from looping.
  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const walk = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      walk(child);
      descendants.push(child);
    }
  };
  walk(rootPid);
  return descendants;
}

/** POSIX: SIGKILL a pid, ignoring one that is already gone. */
function signalKill(pid: number): void {
  try {
    Deno.kill(pid, "SIGKILL");
  } catch {
    // already exited
  }
}

/** POSIX: kill the descendants, then the root.
 *
 * The sweeps run while the root is still alive because a dead parent's
 * children are reparented to init: a walk over parent links cannot reach
 * them any more (on Windows the parent pid stays on the child record,
 * which is what the walk there relies on; POSIX rewrites it). Killing
 * children before parents keeps the tree addressable for the next sweep,
 * and the repeated sweeps catch a child spawned while the table was being
 * read. */
async function killPosixTree(rootPid: number): Promise<void> {
  for (let attempt = 0; attempt < KILL_SWEEP_ATTEMPTS; attempt++) {
    const descendants = posixDescendantPids(rootPid);
    if (descendants.length === 0) break;
    for (const pid of descendants) signalKill(pid);
    await sleep(KILL_SWEEP_DELAY_MS);
  }
  signalKill(rootPid);
}

/** Kill a spawned process and its whole tree, and wait until the kill has
 * reached the tree.
 *
 * Windows: taskkill /T /F awaited — killing the shell alone would orphan
 * everything it spawned, and the kill must have reached the whole tree
 * before the caller treats the command as dead (a descendant still holding
 * its working directory would otherwise block cleanup). The tree is
 * enumerated up front and every pid killed in one taskkill call, then
 * re-walked a few times: /T enumerates only once, so a child spawned while
 * the enumeration was in flight would otherwise survive as an orphan (its
 * parent dies; the child keeps the dead parent's PID, which the sweep then
 * finds).
 *
 * POSIX: the same tree, walked over `ps` and signalled deepest-first, then
 * the shell. Without the walk a signal reaches only the shell — the
 * process the caller holds — and everything the command started keeps
 * running (a reported kill that stopped nothing, and pipes and working
 * directories held by survivors). */
export async function killProcessTree(
  child: { pid: number },
): Promise<void> {
  if (Deno.build.os === "windows") {
    taskkillPids([...windowsDescendantPids(child.pid), child.pid]);
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(100);
      const stragglers = windowsDescendantPids(child.pid);
      if (stragglers.length === 0) return;
      taskkillPids(stragglers);
    }
    return;
  }
  await killPosixTree(child.pid);
}
