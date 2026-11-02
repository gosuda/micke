// supervisor — one process owning N micke sessions (Docker containers).
//
// A session is a labeled container (`--label micke.session=<id>`) plus a lazy
// long-lived shell channel. Persistent state lives under the XDG state dir so a
// restarted supervisor can discover containers from previous runs (listed as
// `orphaned`; reaped via session_close). All failures surface as MickeError
// with one JSON shape: {code, message, hint}.

import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, writeSync, closeSync, ftruncateSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { dlopen } from "bun:ffi";
import * as io from "./dockerio.js";
import { ShellChannel, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from "./shell.js";

// flock(2) via FFI: the kernel releases the lock when this process dies, so a
// crashed supervisor never leaves a stale lock behind (no pid-file recovery).
const LOCK_EX = 2;
const LOCK_NB = 4;
const flock: ((fd: number, op: number) => number) | null = (() => {
  try {
    return dlopen("libc.so.6", { flock: { args: ["i32", "i32"], returns: "i32" } }).symbols.flock;
  } catch {
    return null; // non-Linux / no libc — no lock (micke targets Linux hosts)
  }
})();

export class MickeError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint ?? null };
  }
}

export interface SessionRow {
  session_id: string;
  status: "ready" | "orphaned";
  image: string;
  novnc_url: string | null;
  container_id: string;
  container_name: string;
  workspace: string | null;
  screen: string;
  created_at: number;
  uptime_seconds: number;
}

interface SessionState {
  session_id: string;
  container_id: string;
  container_name: string;
  image: string;
  novnc_port: number | null;
  workspace: string | null;
  screen: string;
  created_at: number;
}

interface LiveSession extends SessionState {
  shell: ShellChannel | null;
}

const DEFAULT_IMAGE = "micke:latest";
const DEFAULT_SCREEN = "1280x800x24";
const READY_LINE = "micke: desktop ready";

const randId = () =>
  Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

export class Supervisor {
  private sessions = new Map<string, LiveSession>();
  private orphanStates = new Map<string, SessionState>();
  private stateFile: string;
  private bootLock: Promise<void> = Promise.resolve();
  private lockFd: number | null = null;

  constructor() {
    const base = process.env.MICKE_STATE_DIR
      ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "micke");
    mkdirSync(base, { recursive: true });
    this.stateFile = join(base, "sessions.json");
  }

  async start(): Promise<void> {
    await this.acquireLock();
    this.loadState();
    await this.scanOrphans();
  }

  // ---- lifecycle ----------------------------------------------------------
  //
  // create = validate cheaply, then run the whole pull+boot phase under ONE
  // in-process mutex (FR-31/32): never two pulls, never a pull beside a live
  // session, and concurrent creates of a missing image wait for one pull,
  // then all proceed.

  async createSession(opts: { image?: string; workspace?: string; screen?: string }): Promise<SessionRow> {
    const image = opts.image || process.env.MICKE_IMAGE || DEFAULT_IMAGE;
    const screen = opts.screen || DEFAULT_SCREEN;
    if (!/^\d{2,5}x\d{2,5}x\d{1,3}$/.test(screen)) {
      throw new MickeError("SCREEN_INVALID", `invalid screen "${screen}"`, "Expected WIDTHxHEIGHTxDEPTH, e.g. 1280x800x24.");
    }
    let workspace: string | null = null;
    if (opts.workspace != null) {
      workspace = opts.workspace;
      if (!isAbsolute(workspace) || !existsSync(workspace)) {
        throw new MickeError("WORKSPACE_INVALID", `workspace "${workspace}" must be an absolute host path that exists`, `It is bind-mounted at /workspace (-v ${workspace}:/workspace).`);
      }
    }
    this.checkMemoryFloor();
    if (!(await io.dockerAvailable())) {
      throw new MickeError("DOCKER_UNAVAILABLE", "docker daemon is not reachable", "Is dockerd running and does this user have access (docker ps)?");
    }
    return this.withBootLock(() => this.bootSession(image, workspace, screen));
  }

  private async bootSession(image: string, workspace: string | null, screen: string): Promise<SessionRow> {
    await this.ensureImage(image);

    const id = randId();
    const name = `micke-${id}`;
    const args = [
      "run", "-d", "--init", "--shm-size=1g", "--pull=never",
      "--name", name, "--label", `micke.session=${id}`,
      "-e", `MICKE_SCREEN=${screen}`,
      "-p", "127.0.0.1::6080/tcp", // Docker picks the host port; read back below
    ];
    if (workspace) args.push("-v", `${workspace}:/workspace`);
    args.push(image);
    const run = await io.docker(args, 60_000);
    if (run.rc !== 0) {
      throw new MickeError("DOCKER_ERROR", `docker run failed: ${run.stderr.trim().slice(0, 500)}`, `Try: docker run --rm ${image} true`);
    }
    const containerId = run.stdout.trim();

    const port = await io.hostPort(containerId, 6080);
    if (port == null) {
      await io.removeContainer(containerId).catch(() => {});
      throw new MickeError("DOCKER_ERROR", "could not read back the allocated host port for 6080/tcp");
    }

    // Wait for the entrypoint's ready line (desktop up; /tmp/session.env written).
    const bootTimeout = parseInt(process.env.MICKE_BOOT_TIMEOUT_MS || "30000", 10);
    const t0 = Date.now();
    let logs = "";
    while (Date.now() - t0 < bootTimeout) {
      logs = await io.containerLogs(containerId);
      if (logs.includes(READY_LINE)) break;
      if (!(await io.containerRunning(containerId))) {
        await io.removeContainer(containerId).catch(() => {});
        throw new MickeError("DESKTOP_BOOT_TIMEOUT", `container exited during boot:\n${logs.slice(-800)}`);
      }
      await Bun.sleep(150);
    }
    if (!logs.includes(READY_LINE)) {
      await io.removeContainer(containerId).catch(() => {});
      throw new MickeError("DESKTOP_BOOT_TIMEOUT", `"${READY_LINE}" not seen within ${bootTimeout} ms:\n${logs.slice(-800)}`, "Raise MICKE_BOOT_TIMEOUT_MS or inspect the image manually.");
    }

    const session: LiveSession = {
      session_id: id, container_id: containerId, container_name: name,
      image, novnc_port: port, workspace, screen, created_at: Date.now(),
      shell: null,
    };
    this.sessions.set(id, session);
    this.saveState();
    return this.row(session, "ready");
  }

  async closeSession(id: string): Promise<{ closed: string; container_removed: boolean }> {
    const live = this.sessions.get(id);
    const state: SessionState | undefined = live ?? this.orphanStates.get(id);
    if (!state) {
      throw new MickeError("SESSION_NOT_FOUND", `no session "${id}"`, "Call session_list to see live and orphaned sessions.");
    }
    live?.shell?.kill();
    const r = await io.removeContainer(state.container_id).catch(() => ({ rc: 1 }));
    this.sessions.delete(id);
    this.orphanStates.delete(id);
    this.saveState();
    return { closed: id, container_removed: r.rc === 0 };
  }

  async runShell(
    id: string,
    command: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  ) {
    const live = this.sessions.get(id);
    if (!live) {
      if (this.orphanStates.has(id)) {
        throw new MickeError("SESSION_ORPHANED", `session "${id}" belongs to a previous supervisor run`, "Close it with session_close, then session_create a fresh one.");
      }
      throw new MickeError("SESSION_NOT_FOUND", `no session "${id}"`, "Call session_list first.");
    }
    if (!live.shell) {
      live.shell = new ShellChannel(live.container_name);
      await live.shell.start();
    }
    return live.shell.run(command, timeoutMs, maxOutputBytes);
  }

  async listSessions(): Promise<SessionRow[]> {
    const labeled = new Set((await io.listLabeledContainers()).map((c) => c.sessionId));
    for (const [id, s] of this.sessions) {
      if (!labeled.has(id)) { // container crashed or was removed behind our back
        s.shell?.kill();
        this.sessions.delete(id);
      }
    }
    const rows = [
      ...[...this.sessions.values()].map((s) => this.row(s, "ready")),
      ...[...this.orphanStates.values()].map((s) => this.row(s, "orphaned")),
    ];
    rows.sort((a, b) => a.created_at - b.created_at);
    return rows;
  }

  /** Kill shell channels (supervisor exit). Containers stay; they become orphans. */
  async shutdown(): Promise<void> {
    for (const s of this.sessions.values()) s.shell?.kill();
  }

  // ---- image policy (FR-31/32) ---------------------------------------------

  /** Pull-if-missing. MUST run under the boot lock: one pull at a time, never beside a live session. */
  private async ensureImage(image: string): Promise<void> {
    if (await io.imageExists(image)) return;
    if (this.sessions.size > 0) {
      throw new MickeError(
        "IMAGE_MISSING",
        `image "${image}" is not available locally, and micke never pulls while sessions are live`,
        `Close live sessions first, or run: docker pull ${image}`,
      );
    }
    const r = await io.pullImage(image);
    if (r.rc !== 0) {
      throw new MickeError("IMAGE_MISSING", `image "${image}" missing locally and docker pull failed: ${r.stderr.trim().slice(0, 300)}`, `docker pull ${image}`);
    }
  }

  // ---- guards (FR-18/19) ---------------------------------------------------

  /**
   * Instance lock (FR-19): flock on <state dir>/supervisor.lock, held until
   * process exit. Scoped to the state dir because that is the shared state a
   * second supervisor would corrupt (sessions.json + its containers); the
   * default config locks ~/.local/state/micke/supervisor.lock as specified.
   */
  private async acquireLock(): Promise<void> {
    if (!flock) {
      console.error("micke: warning: flock(2) unavailable — running without the instance lock");
      return;
    }
    const path = join(dirname(this.stateFile), "supervisor.lock");
    const fd = openSync(path, "a"); // create if missing; never truncates — the holder's pid must stay readable
    // A previous instance may be mid-exit (restart race): retry briefly before refusing.
    const deadline = Date.now() + 1_500;
    for (;;) {
      if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
        ftruncateSync(fd, 0); // drop any stale pid from a crashed predecessor
        writeSync(fd, `${process.pid}\n`);
        this.lockFd = fd; // keep the fd open for the process lifetime
        return;
      }
      if (Date.now() >= deadline) {
        closeSync(fd);
        let holder = "unknown";
        try { holder = readFileSync(path, "utf8").trim() || "unknown"; } catch { /* empty */ }
        throw new MickeError(
          "LOCK_HELD",
          `another micke supervisor (pid ${holder}) holds ${path}`,
          "One supervisor per state dir owns port allocation and pulls; stop the other instance first.",
        );
      }
      await Bun.sleep(100);
    }
  }

  /**
   * Free-RAM floor (FR-18): refuse new sessions when MemAvailable is below
   * MICKE_MIN_FREE_MB (default 1024; 0 or invalid disables; /proc/meminfo
   * missing → skip, i.e. non-Linux hosts fail open).
   */
  private checkMemoryFloor(): void {
    const floorMb = parseInt(process.env.MICKE_MIN_FREE_MB || "1024", 10);
    if (!Number.isFinite(floorMb) || floorMb <= 0) return;
    let meminfo: string;
    try {
      meminfo = readFileSync("/proc/meminfo", "utf8");
    } catch {
      return;
    }
    const m = meminfo.match(/^MemAvailable:\s+(\d+) kB$/m);
    if (!m) return;
    const availMb = Math.floor(parseInt(m[1], 10) / 1024);
    if (availMb < floorMb) {
      throw new MickeError(
        "INSUFFICIENT_MEMORY",
        `host has ${availMb} MiB free (MemAvailable), below the ${floorMb} MiB floor`,
        "Close sessions (each chromium session holds ~500 MiB), free host RAM, or lower MICKE_MIN_FREE_MB (0 disables the floor).",
      );
    }
  }

  /** Serialize a pull+boot phase against all others (FR-31/32 mutex). */
  private withBootLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.bootLock.then(fn);
    this.bootLock = run.then(() => {}, () => {});
    return run;
  }

  // ---- persistence ----------------------------------------------------------

  private loadState(): void {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, "utf8"));
      for (const s of raw.sessions ?? []) this.orphanStates.set(s.session_id, s);
    } catch { /* no state yet */ }
  }

  /** Adopt micke.session-labeled containers (from previous runs) as orphans. */
  private async scanOrphans(): Promise<void> {
    const labeled = await io.listLabeledContainers();
    for (const c of labeled) {
      const known = this.orphanStates.get(c.sessionId);
      if (known) {
        known.container_id = c.containerId;
        if (!c.running) known.novnc_port = null;
      } else {
        this.orphanStates.set(c.sessionId, {
          session_id: c.sessionId,
          container_id: c.containerId,
          container_name: `micke-${c.sessionId}`,
          image: "unknown",
          novnc_port: c.running ? await io.hostPort(c.containerId, 6080) : null,
          workspace: null,
          screen: "unknown",
          created_at: Date.now(),
        });
      }
    }
    for (const id of this.orphanStates.keys()) {
      if (!labeled.some((c) => c.sessionId === id)) this.orphanStates.delete(id);
    }
    this.saveState();
  }

  private saveState(): void {
    const sessions = [...this.sessions.values(), ...this.orphanStates.values()]
      .map((s) => {
        const { shell: _shell, ...state } = s as LiveSession;
        return state;
      });
    try {
      writeFileSync(this.stateFile, JSON.stringify({ sessions }, null, 2));
    } catch { /* best effort */ }
  }

  private row(s: SessionState, status: SessionRow["status"]): SessionRow {
    return {
      session_id: s.session_id,
      status,
      image: s.image,
      novnc_url: s.novnc_port ? `http://127.0.0.1:${s.novnc_port}/vnc.html` : null,
      container_id: s.container_id,
      container_name: s.container_name,
      workspace: s.workspace,
      screen: s.screen,
      created_at: s.created_at,
      uptime_seconds: Math.floor((Date.now() - s.created_at) / 1000),
    };
  }
}
