// gvxio — thin `rungv` CLI wrapper + the per-session pidfile registry.
//
// micke shells out to the `rungv` binary (no SDK): management commands are
// captured (stdout/stderr/exit code) and the small, stable textual outputs we
// rely on are parsed. A session itself is ONE foreground `rungv run` child
// owned by the supervisor; its host ports are parsed from the child's log file
// at launch and persisted in <state>/sessions/<id>.json — that pidfile is the
// session identity (gvx has no labels, ps, or daemon state).

import { mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

export const DEFAULT_IMAGE = "ghcr.io/gosuda/micke:latest";
export const DEFAULT_SCREEN = "1280x800x24";

/** Guest ports. The host ports are kernel-picked and come from stderr. */
export const SHELL_GUEST_PORT = 7801;
export const NOVNC_GUEST_PORT = 6080;

export const DESKTOP_READY_LINE = "micke: desktop ready";

export interface GvxResult {
  rc: number;
  stdout: string;
  stderr: string;
}

/** Path to the rungv binary (MICKE_RUNGV override for dev/absolute paths). */
export function rungvBinary(): string {
  return process.env.MICKE_RUNGV || "rungv";
}

/** micke owns its EROFS layer cache; never the gvx default and never a tmpfs. */
export function gvxCacheDir(): string {
  return process.env.MICKE_GVX_CACHE
    ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "micke", "gvx");
}

export async function rungv(args: string[], timeoutMs?: number): Promise<GvxResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([rungvBinary(), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    // ENOENT etc.: report it in the same result shape instead of throwing.
    return { rc: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs) timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const rc = await proc.exited;
  if (timer) clearTimeout(timer);
  return { rc, stdout, stderr };
}

/** Is the rungv binary present and runnable? (gvx has no daemon to health-check.) */
export async function rungvAvailable(): Promise<boolean> {
  const r = await rungv(["version"], 10_000);
  return r.rc === 0;
}

/** Does the image exist in micke's cache? */
export async function imageExists(ref: string): Promise<boolean> {
  const cache = gvxCacheDir();
  const r = await rungv(["inspect", "-cache-dir", cache, ref], 15_000);
  if (r.rc === 0) return true;
  // Older v0.4.x releases may lack `inspect`; fall back to the images table.
  if (/unknown (command|flag)|flag provided but not defined/i.test(r.stderr)) {
    const list = await rungv(["images", "-cache-dir", cache], 15_000);
    return list.rc === 0 && imageListContains(list.stdout, ref);
  }
  return false;
}

function imageListContains(table: string, ref: string): boolean {
  const at = ref.indexOf("@");
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  const repository = at >= 0 ? ref.slice(0, at) : colon > slash ? ref.slice(0, colon) : ref;
  const tag = at >= 0 ? "" : colon > slash ? ref.slice(colon + 1) : "latest";
  for (const line of table.split("\n")) {
    const [repo, rowTag] = line.trim().split(/\s+/);
    if (repo === repository && (tag === "" || rowTag === tag)) return true;
  }
  return false;
}

export async function pullImage(ref: string): Promise<GvxResult> {
  // Pulls compile layers in memory; generous ceiling, caller handles failure.
  return rungv(["pull", "-cache-dir", gvxCacheDir(), ref], 15 * 60_000);
}

export interface PublishLine {
  host: string;
  hostPort: number;
  guestPort: number;
}

/** Parse `rungv: publishing 127.0.0.1:38271 -> 6080/tcp`. */
export function parsePublishLine(line: string): PublishLine | null {
  const m = line.match(/^rungv: publishing (\S+):(\d+) -> (\d+)\/tcp$/);
  if (!m) return null;
  return {
    host: m[1],
    hostPort: parseInt(m[2], 10),
    guestPort: parseInt(m[3], 10),
  };
}

// ---- session pidfiles -------------------------------------------------------

export interface SessionRecord {
  session_id: string;
  rungv_pid: number;
  hostname: string;
  shell_host_port: number;
  novnc_host_port: number;
  image: string;
  workspace: string | null;
  screen: string;
  created_at: number;
}

export interface SpawnOptions {
  id: string;
  image: string;
  screen: string;
  workspace: string | null;
  cacheDir?: string;
  /** Write the child's stdout+stderr here (a real file survives daemon death). */
  logFd: number;
}

export type SessionProcess = Bun.Subprocess<any, any, any>;

export function sessionsDir(stateDir: string): string {
  return join(stateDir, "sessions");
}

export function pidfilePath(stateDir: string, id: string): string {
  return join(sessionsDir(stateDir), `${id}.json`);
}

export function logfilePath(stateDir: string, id: string): string {
  return join(sessionsDir(stateDir), `${id}.log`);
}

/** Open the per-session log file (truncating); close the parent copy after spawn. */
export function openLogfile(stateDir: string, id: string): number {
  mkdirSync(sessionsDir(stateDir), { recursive: true });
  return openSync(logfilePath(stateDir, id), "w");
}

export function deleteLogfile(stateDir: string, id: string): void {
  try {
    unlinkSync(logfilePath(stateDir, id));
  } catch { /* already gone */ }
}

/** Atomic write (temp + rename): a crash can never truncate a live record. */
export function writePidfile(stateDir: string, rec: SessionRecord): void {
  const dir = sessionsDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const path = pidfilePath(stateDir, rec.session_id);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
  renameSync(tmp, path);
}

export function readPidfile(stateDir: string, id: string): SessionRecord | null {
  try {
    const raw = JSON.parse(readFileSync(pidfilePath(stateDir, id), "utf8"));
    return validRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function listPidfiles(stateDir: string): SessionRecord[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir(stateDir));
  } catch {
    return [];
  }
  const out: SessionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const rec = readPidfile(stateDir, name.slice(0, -".json".length));
    if (rec) out.push(rec);
  }
  return out;
}

export function deletePidfile(stateDir: string, id: string): void {
  try {
    unlinkSync(pidfilePath(stateDir, id));
  } catch { /* already gone */ }
}

function validRecord(v: any): v is SessionRecord {
  return !!v
    && typeof v.session_id === "string"
    && typeof v.rungv_pid === "number"
    && typeof v.hostname === "string"
    && typeof v.shell_host_port === "number"
    && typeof v.novnc_host_port === "number";
}

// ---- process identity -------------------------------------------------------

/** Is the pid present? (signal 0 probes without touching the process) */
export function procAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM"; // exists, owned by someone else
  }
}

/** Full command line of a pid, or null if it is gone/unreadable. */
function cmdline(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return raw.split("\0").filter(Boolean).join(" ");
  } catch { /* not Linux, or gone */ }
  try {
    // Portable fallback (macOS/BSD). ps is in the base system.
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Pid-reuse guard: the process must still be a rungv run for OUR hostname.
 * The hostname embeds the session id (`micke-<id>`), so an unrelated process
 * that inherited the pid can never be mistaken for an adoptable sandbox.
 */
export function procMatches(pid: number, sessionId: string): boolean {
  const line = cmdline(pid);
  if (!line) return false;
  const argv = line.split(/\s+/).filter(Boolean);
  if (!argv.some((a) => {
    const b = basename(a);
    return b === "rungv" || b.startsWith("rungv-");
  })) return false;
  return argv.includes(`micke-${sessionId}`);
}

// ---- spawn ------------------------------------------------------------------

/**
 * Spawn ONE foreground rungv child for a session. stdin is closed: the shell
 * channel is the in-guest TCP listener, not stdin. No `-d`, `--init`, or
 * `--entrypoint` override — the image entrypoint IS the socket driver, and
 * Sentry is the guest's PID 1/reaper. stdout+stderr go to `logFd` (a file the
 * daemon only polls), so the sandbox keeps running after a daemon crash.
 */
export function spawnSession(o: SpawnOptions): SessionProcess {
  const args = [
    "run",
    "-cache-dir", o.cacheDir ?? gvxCacheDir(),
    "-pull=never",
    "-h", `micke-${o.id}`,
    "-m", process.env.MICKE_SESSION_MEMORY || "2g",
    "-e", `MICKE_SCREEN=${o.screen}`,
    "-e", `MICKE_SHELL_PORT=${SHELL_GUEST_PORT}`,
    "-p", String(SHELL_GUEST_PORT),
    "-p", String(NOVNC_GUEST_PORT),
  ];
  // Optional classic-VNC password; copy from the daemon's environment.
  if (process.env.MICKE_VNC_PASSWORD) args.push("-e", "MICKE_VNC_PASSWORD");
  if (o.workspace) args.push("-v", `${o.workspace}:/workspace`);
  args.push(o.image);
  return Bun.spawn([rungvBinary(), ...args], {
    stdin: "ignore",
    stdout: o.logFd,
    stderr: o.logFd,
  });
}
