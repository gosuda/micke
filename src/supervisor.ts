// supervisor — one process owning N micke sessions (gvx sandboxes).
//
// A session is ONE foreground `rungv run` child plus a lazy TCP shell channel
// into the guest's socket driver. Identity is the per-session pidfile under
// <state>/sessions/<id>.json (gvx has no labels, ps, or daemon state): it
// records the rungv pid and both host ports, survives daemon death, and lets
// the next daemon adopt still-running sandboxes.
//
// Every failure surfaces as MickeError with one JSON shape: {code, message, hint}.

import { chmodSync, existsSync, mkdirSync, readFileSync, openSync, readSync, statSync, writeSync, closeSync, ftruncateSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { dlopen } from "bun:ffi";
import * as io from "./gvxio.js";
import { ShellChannel, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from "./shell.js";
import { guestCanWrite, guestIds } from "./workspace.js";

// flock(2) via FFI: the kernel releases the lock when this process dies, so a
// crashed supervisor never leaves a stale lock behind (no pid-file recovery).
const LOCK_EX = 2;
const LOCK_NB = 4;
const flock: ((fd: number, op: number) => number) | null = (() => {
  for (const lib of ["libc.so.6", "libSystem.B.dylib"]) {
    try {
      return dlopen(lib, { flock: { args: ["i32", "i32"], returns: "i32" } }).symbols.flock;
    } catch { /* try the next libc */ }
  }
  return null; // no libc — run without the lock (micke targets Linux/macOS)
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
  rungv_pid: number;
  hostname: string;
  workspace: string | null;
  screen: string;
  created_at: number;
  uptime_seconds: number;
}

interface LiveSession extends io.SessionRecord {
  shell: ShellChannel | null;
  shellReady: Promise<ShellChannel> | null;
  child: io.SessionProcess | null;
}

const randId = () =>
  Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

export class Supervisor {
  private sessions = new Map<string, LiveSession>();
  private orphanStates = new Map<string, io.SessionRecord>();
  private stateDir: string;
  private bootLock: Promise<void> = Promise.resolve();
  private lockFd: number | null = null;

  constructor() {
    this.stateDir = process.env.MICKE_STATE_DIR
      ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "micke");
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(io.sessionsDir(this.stateDir), { recursive: true });
  }

  async start(): Promise<void> {
    await this.acquireLock();
    this.adoptSessions();
  }

  // ---- lifecycle ----------------------------------------------------------
  //
  // create = validate cheaply, then run the whole pull+boot phase under ONE
  // in-process mutex: never two pulls, never a pull beside a live
  // session, and concurrent creates of a missing image wait for one pull,
  // then all proceed.

  async createSession(opts: { image?: string; workspace?: string; screen?: string }): Promise<SessionRow> {
    const image = opts.image || process.env.MICKE_IMAGE || io.DEFAULT_IMAGE;
    const screen = opts.screen || io.DEFAULT_SCREEN;
    if (!/^\d{2,5}x\d{2,5}x\d{1,3}$/.test(screen)) {
      throw new MickeError("SCREEN_INVALID", `invalid screen "${screen}"`, "Expected WIDTHxHEIGHTxDEPTH, e.g. 1280x800x24.");
    }
    let workspace: string | null = null;
    if (opts.workspace != null) {
      workspace = opts.workspace;
      if (!isAbsolute(workspace) || !existsSync(workspace)) {
        throw new MickeError("WORKSPACE_INVALID", `workspace "${workspace}" must be an absolute host path that exists`, `It is mounted at /workspace (-v ${workspace}:/workspace).`);
      }
      // gvx mounts without uid remapping: the guest writes as uid 1000, so the
      // HOST mode decides whether /workspace is writable. Fail here, with the
      // remedy, instead of letting the first write fail later with a bare
      // "Permission denied" that looks like a broken mount.
      const st = statSync(workspace);
      if (!st.isDirectory()) {
        throw new MickeError("WORKSPACE_INVALID", `workspace "${workspace}" is not a directory`, "It is mounted at /workspace, so it must be a directory.");
      }
      const { uid, gid } = guestIds();
      if (!guestCanWrite(st, uid, gid)) {
        throw new MickeError(
          "WORKSPACE_NOT_WRITABLE",
          `workspace "${workspace}" is not writable by the guest (uid ${uid}, gid ${gid}); /workspace would be read-only in the sandbox`,
          `Run \`chmod -R a+w ${workspace}\` (or pass a directory the guest can write). gvx mounts without uid remapping; micke only chmods the workspace it creates itself.`,
        );
      }
    }
    this.checkMemoryFloor();
    if (!(await io.rungvAvailable())) {
      throw new MickeError("RUNGV_UNAVAILABLE", "the rungv binary is not available", "Install gvx and put `rungv` on PATH (or set MICKE_RUNGV to its absolute path).");
    }
    return this.withBootLock(() => this.bootSession(image, workspace, screen));
  }

  private async bootSession(image: string, workspace: string | null, screen: string): Promise<SessionRow> {
    await this.ensureImage(image);

    const id = randId();
    const hostname = `micke-${id}`;
    // No workspace requested? Hand back one anyway: artifacts (screenshots,
    // downloads, dumps) must be retrievable from the host without pushing
    // base64 through session_shell's 256 KiB cap. It lives beside the pidfile,
    // so MICKE_STATE_DIR / XDG_STATE_HOME governs its lifetime. Explicit
    // workspaces are validated by createSession and never rewritten.
    if (workspace === null) {
      workspace = join(this.stateDir, "workspaces", id);
      mkdirSync(workspace, { recursive: true });
      // Documented, disposable exception: rungv has no uid mapping, so a
      // 0755 dir owned by the host uid is read-only for the uid-1000 guest.
      // This directory is ours, holds no user data, and is the one place we
      // may widen permissions; user-supplied workspaces are only checked.
      chmodSync(workspace, 0o777);
    }
    // The child's stdout/stderr go to a REAL FILE, not a pipe: rungv outlives a
    // crashed daemon, and a pipe whose reader died would make the guest's next
    // log write kill the listener (defeating adoption). The file also gives
    // post-mortem diagnostics. We poll it for ports + the ready line.
    const logPath = io.logfilePath(this.stateDir, id);
    const logFd = io.openLogfile(this.stateDir, id);
    let child: io.SessionProcess;
    try {
      child = io.spawnSession({ id, image, workspace, screen, logFd });
    } catch (err) {
      closeSync(logFd);
      io.deleteLogfile(this.stateDir, id);
      throw new MickeError(
        "GVX_ERROR",
        `rungv run failed to start: ${err instanceof Error ? err.message : String(err)}`,
        "Check MICKE_RUNGV and the rungv installation.",
      );
    }
    closeSync(logFd); // the child owns its copy now

    // Ports arrive as `rungv: publishing 127.0.0.1:<host> -> <guest>/tcp` lines,
    // before the guest starts. Readiness arrives from the in-guest driver.
    const ports = new Map<number, number>();
    let tail = "";
    let readySeen = false;
    let exited: number | null = null;
    void child.exited.then((code) => { exited = code; });

    let logOffset = 0;
    let lineBuf = "";
    const pollLog = () => {
      try {
        const size = statSync(logPath).size;
        if (size <= logOffset) return;
        const fd = openSync(logPath, "r");
        const len = size - logOffset;
        const buf = Buffer.allocUnsafe(len);
        let n = 0;
        try {
          n = readSync(fd, buf, 0, len, logOffset);
        } finally {
          closeSync(fd);
        }
        if (n <= 0) return;
        logOffset += n;
        const text = buf.subarray(0, n).toString("utf8");
        tail = (tail + text).slice(-4096);
        if (tail.includes(io.DESKTOP_READY_LINE)) readySeen = true;
        lineBuf += text;
        let idx: number;
        while ((idx = lineBuf.indexOf("\n")) >= 0) {
          const line = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          const p = io.parsePublishLine(line);
          if (p) ports.set(p.guestPort, p.hostPort);
        }
      } catch { /* file rotated/gone; the exit branch reports it */ }
    };
    const havePorts = () =>
      ports.has(io.SHELL_GUEST_PORT) && ports.has(io.NOVNC_GUEST_PORT);

    const rawTimeout = parseInt(process.env.MICKE_BOOT_TIMEOUT_MS || "30000", 10);
    const bootTimeout = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30_000;
    const bootDeadline = Date.now() + bootTimeout;
    const portDeadline = Date.now() + 5_000;
    while (exited === null) {
      pollLog();
      if (readySeen && havePorts()) break;
      if (!havePorts() && Date.now() > portDeadline) break;
      if (Date.now() > bootDeadline) break;
      await Bun.sleep(50);
    }
    pollLog();

    if (exited !== null) {
      await this.killChild(child);
      io.deleteLogfile(this.stateDir, id);
      throw new MickeError("DESKTOP_BOOT_TIMEOUT", `sandbox exited during boot (rc=${exited}):\n${tail.slice(-800)}`);
    }
    if (!havePorts()) {
      await this.killChild(child);
      io.deleteLogfile(this.stateDir, id);
      throw new MickeError(
        "GVX_ERROR",
        `no \`rungv: publishing\` lines within 5000 ms:\n${tail.slice(-800)}`,
        "The image entrypoint must be micke-driver (image/driver.sh) and rungv must be able to publish ports.",
      );
    }
    if (!readySeen) {
      await this.killChild(child);
      io.deleteLogfile(this.stateDir, id);
      throw new MickeError(
        "DESKTOP_BOOT_TIMEOUT",
        `"${io.DESKTOP_READY_LINE}" not seen within ${bootTimeout} ms:\n${tail.slice(-800)}`,
        "Raise MICKE_BOOT_TIMEOUT_MS or inspect the image manually with rungv run.",
      );
    }

    const rec: io.SessionRecord = {
      session_id: id,
      rungv_pid: child.pid,
      hostname,
      shell_host_port: ports.get(io.SHELL_GUEST_PORT)!,
      novnc_host_port: ports.get(io.NOVNC_GUEST_PORT)!,
      image,
      workspace,
      screen,
      created_at: Date.now(),
    };
    try {
      io.writePidfile(this.stateDir, rec); // pidfile first: it is the adoption record
    } catch (err) {
      await this.killChild(child);
      io.deleteLogfile(this.stateDir, id);
      throw new MickeError(
        "GVX_ERROR",
        `could not write session pidfile: ${err instanceof Error ? err.message : String(err)}`,
        `Check that ${io.sessionsDir(this.stateDir)} is writable.`,
      );
    }

    const session: LiveSession = { ...rec, shell: null, shellReady: null, child };
    this.sessions.set(id, session);
    return this.row(session, "ready");
  }

  async closeSession(id: string): Promise<{ closed: string; sandbox_removed: boolean }> {
    const live = this.sessions.get(id);
    const state: io.SessionRecord | undefined = live ?? this.orphanStates.get(id);
    if (!state) {
      throw new MickeError("SESSION_NOT_FOUND", `no session "${id}"`, "Call session_list to see live and orphaned sessions.");
    }
    live?.shell?.kill();
    const removed = await this.terminateSandbox(state.rungv_pid, live?.child ?? null, id);
    this.sessions.delete(id);
    this.orphanStates.delete(id);
    io.deletePidfile(this.stateDir, id);
    io.deleteLogfile(this.stateDir, id);
    return { closed: id, sandbox_removed: removed };
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
        throw new MickeError("SESSION_ORPHANED", `session "${id}" has a pidfile but its sandbox is gone`, "Close it with session_close, then session_create a fresh one.");
      }
      throw new MickeError("SESSION_NOT_FOUND", `no session "${id}"`, "Call session_list first.");
    }
    const shell = await this.ensureShell(live);
    return shell.run(command, timeoutMs, maxOutputBytes);
  }

  async listSessions(): Promise<SessionRow[]> {
    for (const [id, s] of this.sessions) {
      const alive = s.child
        ? s.child.exitCode === null
        : io.procAlive(s.rungv_pid) && io.procMatches(s.rungv_pid, id);
      if (!alive) { // sandbox died behind our back
        s.shell?.kill();
        this.sessions.delete(id);
        io.deletePidfile(this.stateDir, id);
        io.deleteLogfile(this.stateDir, id);
      }
    }
    const rows = [
      ...[...this.sessions.values()].map((s) => this.row(s, "ready")),
      ...[...this.orphanStates.values()].map((s) => this.row(s, "orphaned")),
    ];
    rows.sort((a, b) => a.created_at - b.created_at);
    return rows;
  }

  /**
   * Kill shell channels only (supervisor exit). rungv children deliberately
   * stay alive: desktops, chromium windows, and human noVNC logins survive a
   * daemon crash/restart, and the next start adopts them via their pidfiles.
   */
  async shutdown(): Promise<void> {
    for (const s of this.sessions.values()) s.shell?.kill();
  }

  // ---- shell channel ------------------------------------------------------

  private async ensureShell(live: LiveSession): Promise<ShellChannel> {
    if (live.shell?.alive) return live.shell;
    if (live.shellReady) return live.shellReady;
    live.shellReady = (async () => {
      const channel = new ShellChannel(live.shell_host_port);
      try {
        live.shell?.kill();
        live.shell = channel;
        await channel.start();
        return channel;
      } catch (err) {
        live.shell = null;
        throw err;
      } finally {
        live.shellReady = null;
      }
    })();
    return live.shellReady;
  }

  // ---- image policy --------------------------------------------------------

  /** Pull-if-missing. MUST run under the boot lock: one pull at a time, never beside a live session. */
  private async ensureImage(image: string): Promise<void> {
    if (await io.imageExists(image)) return;
    if (this.sessions.size > 0) {
      throw new MickeError(
        "IMAGE_MISSING",
        `image "${image}" is not available locally, and micke never pulls while sessions are live`,
        `Close live sessions first, or run: rungv pull -cache-dir ${io.gvxCacheDir()} ${image}`,
      );
    }
    // A gvx pull compiles layers in memory: this lock is the OOM-avoidance
    // mechanism, not merely hygiene.
    const r = await io.pullImage(image);
    if (r.rc !== 0) {
      throw new MickeError(
        "IMAGE_MISSING",
        `image "${image}" missing locally and rungv pull failed: ${r.stderr.trim().slice(0, 300)}`,
        `rungv pull -cache-dir ${io.gvxCacheDir()} ${image}`,
      );
    }
  }

  // ---- guards --------------------------------------------------------------

  /**
   * Instance lock: flock on <state dir>/supervisor.lock, held until
   * process exit. Scoped to the state dir because that is the shared state a
   * second supervisor would corrupt (pidfiles + their sandboxes); the default
   * config locks ~/.local/state/micke/supervisor.lock as specified.
   */
  private async acquireLock(): Promise<void> {
    if (!flock) {
      console.error("micke: warning: flock(2) unavailable — running without the instance lock");
      return;
    }
    const path = join(this.stateDir, "supervisor.lock");
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
   * Free-RAM floor: refuse new sessions when MemAvailable is below
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
        "Close sessions (under gvx budget ~2 GiB per chromium session, PSS), free host RAM, or lower MICKE_MIN_FREE_MB (0 disables the floor).",
      );
    }
  }

  /** Serialize a pull+boot phase against all others (boot mutex). */
  private withBootLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.bootLock.then(fn);
    this.bootLock = run.then(() => {}, () => {});
    return run;
  }

  // ---- adoption (pidfile discovery; no runtime state to scan) ---------------

  /**
   * On start, every pidfile is a candidate. A live pid whose cmdline still
   * matches `rungv … micke-<id>` is a still-running desktop (adopted as ready,
   * with its ports read from the file). Anything else is an honest orphan:
   * close-only, reaped by session_close.
   */
  private adoptSessions(): void {
    for (const rec of io.listPidfiles(this.stateDir)) {
      if (io.procAlive(rec.rungv_pid) && io.procMatches(rec.rungv_pid, rec.session_id)) {
        this.sessions.set(rec.session_id, { ...rec, shell: null, shellReady: null, child: null });
      } else {
        this.orphanStates.set(rec.session_id, rec);
      }
    }
  }

  // ---- process teardown -----------------------------------------------------

  private async killChild(child: io.SessionProcess): Promise<void> {
    try { if (child.exitCode === null) child.kill(9); } catch { /* already gone */ }
    await child.exited.catch(() => {});
  }

  /**
   * SIGTERM, escalate to SIGKILL after ~3 s. Measured teardown is ~0.1 s with
   * zero strays (the whole rungv process tree dies with the rungv pid).
   */
  private async terminateSandbox(
    pid: number,
    child: io.SessionProcess | null,
    sessionId: string,
  ): Promise<boolean> {
    if (child) {
      if (child.exitCode !== null) return true;
      try { child.kill(); } catch { /* raced to exit */ }
      const termDeadline = Date.now() + 3_000;
      while (Date.now() < termDeadline) {
        if (child.exitCode !== null) return true;
        await Bun.sleep(50);
      }
      try { child.kill(9); } catch { /* raced to exit */ }
      const killDeadline = Date.now() + 2_000;
      while (Date.now() < killDeadline) {
        if (child.exitCode !== null) return true;
        await Bun.sleep(50);
      }
      return child.exitCode !== null;
    }

    // Adopted pid: never signal a process that is not still OUR rungv run —
    // the pid may have been reused after the sandbox died.
    if (!io.procAlive(pid) || !io.procMatches(pid, sessionId)) return true;
    try { process.kill(pid, "SIGTERM"); } catch { /* raced to exit */ }
    const termDeadline = Date.now() + 3_000;
    while (Date.now() < termDeadline) {
      if (!io.procAlive(pid)) return true;
      await Bun.sleep(50);
    }
    // Re-check identity before escalating: SIGKILL on a reused pid would hit
    // an innocent process.
    if (!io.procMatches(pid, sessionId)) return true;
    try { process.kill(pid, "SIGKILL"); } catch { /* raced to exit */ }
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline) {
      if (!io.procAlive(pid)) return true;
      await Bun.sleep(50);
    }
    return !io.procAlive(pid);
  }

  private row(s: io.SessionRecord, status: SessionRow["status"]): SessionRow {
    return {
      session_id: s.session_id,
      status,
      image: s.image,
      novnc_url: status === "ready" && s.novnc_host_port ? `http://127.0.0.1:${s.novnc_host_port}/vnc.html` : null,
      rungv_pid: s.rungv_pid,
      hostname: s.hostname,
      workspace: s.workspace,
      screen: s.screen,
      created_at: s.created_at,
      uptime_seconds: Math.floor((Date.now() - s.created_at) / 1000),
    };
  }
}
