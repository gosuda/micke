// shell — ONE TCP connection per command to the guest's socket driver
// (image/driver.sh). gvx has no exec: the driver listens on
// 127.0.0.1:<picked host port> -> guest :7801 and forks one fresh bash per
// connection.
//
// session_shell is STATELESS by construction: there is no persistent shell, so
// there is no durable cwd, no durable exported env, and nothing that can wedge
// for longer than one call. A call is: connect -> wait for ===SHELL_READY=== ->
// write the request line -> read exactly one frame -> close. The desktop env
// (DISPLAY/D-Bus/AT-SPI) still reaches each fresh bash: the guest handler
// sources /tmp/session.env at startup (see image/driver.sh).
//
// The wire protocol is unchanged, so a stale cached image keeps working:
//
//   host -> guest:  __micke_run <timeout_ms> <max_output_bytes> <base64-cmd>\n
//   guest -> host:
//     ===BEGIN===\n
//     <stdout bytes>\n===STDERR===\n
//     <stderr bytes>\n[===TIMEOUT===\n]\n===END rc=N===\n
//
// The `__micke_run` wrapper lives in the image: the command runs in a
// background process group so a per-command watchdog can TERM/KILL exactly
// that group.
//
// Why stateless, concretely: the old design kept one bash per session and
// replayed exported env between commands by diffing `export -p` snapshots in
// the guest. That replay (driver.sh, now deleted) `unset` changed variables
// BEFORE re-running `comm`/`grep`/`sed`, which resolve through the very PATH it
// had just unset. One `export PATH=/x:$PATH` therefore left the handler with an
// empty PATH: every later call died at `mktemp` before emitting the frame
// (empty stdout/stderr, rc 1, permanently — only session_close recovered it).
// A fresh bash per call deletes that whole bug class; it also removes the
// host-side queue (one slow command no longer blocks the session) and makes a
// wedged shell impossible, because nothing long-lived exists to wedge.

import { MickeError } from "./supervisor.js";

export interface ShellResult {
  stdout: string;
  stderr: string;
  rc: number;
  timedOut: boolean;
  truncated: { stdout: boolean; stderr: boolean };
  durationMs: number;
}

const SHELL_READY = "===SHELL_READY===\n";
const BEGIN = "===BEGIN===\n";
const STDERR_MARK = "\n===STDERR===\n";
const TIMEOUT_MARK = "\n===TIMEOUT===\n";
const TRUNC_RE = /\n…\[truncated (\d+) bytes\]\n|\n\.\.\.\[truncated (\d+) bytes\]\n$/;

// The wrapper prints CWD_MARK to stderr when it cannot enter the requested
// directory; the host maps that to a structured CWD_INVALID error.
const CWD_MARK = "micke: cannot enter cwd: ";

interface Frame {
  stdout: string;
  stderr: string;
  rc: number;
  timedOut: boolean;
  bytes: number; // frame length consumed
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
/** What a fresh bash gets anyway (the image's WORKDIR); named so it is explicit. */
export const DEFAULT_CWD = "/home/agent";
export const DEFAULT_CONCURRENCY = 8;

function parseFrame(buf: Buffer): Frame | null {
  if (!buf.subarray(0, BEGIN.length).equals(Buffer.from(BEGIN))) {
    throw new Error(`shell stream out of sync: ${JSON.stringify(buf.subarray(0, 40).toString())}`);
  }
  const i = buf.indexOf(STDERR_MARK, BEGIN.length);
  if (i < 0) return null;
  let p = i + STDERR_MARK.length;
  const e = buf.indexOf("\n===END rc=", p);
  if (e < 0) return null;
  const lineEnd = buf.indexOf("\n", e + 1);
  if (lineEnd < 0) return null;
  const endLine = buf.toString("utf8", e + 1, lineEnd);
  const m = endLine.match(/^===END rc=(-?\d+)===$/);
  if (!m) throw new Error(`malformed END marker: ${JSON.stringify(endLine)}`);
  const tIdx = buf.indexOf(TIMEOUT_MARK, p);
  const timedOut = tIdx >= 0 && tIdx < e;
  const errEnd = timedOut ? tIdx : e;
  return {
    stdout: buf.toString("utf8", BEGIN.length, i),
    stderr: buf.toString("utf8", p, errEnd),
    rc: parseInt(m[1], 10),
    timedOut,
    bytes: lineEnd + 1,
  };
}

/** POSIX single-quote quoting: everything inside is literal. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Validate the optional cwd and return the prompt-free prefix that enters it.
 * The host must make the command run there; the wire protocol stays untouched,
 * so a stale image (whose fresh bash starts in /home/agent) still works.
 * Rejecting newlines/NUL leaves exactly one quoting path (`shellQuote`).
 */
function cwdPrefix(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new MickeError("BAD_ARGUMENT", "cwd must be a non-empty absolute path", `Omit cwd to use ${DEFAULT_CWD}.`);
  }
  if (/[\n\r\0]/.test(raw)) {
    throw new MickeError("BAD_ARGUMENT", "cwd must not contain newlines or NUL bytes", `Pass one absolute path, e.g. "/tmp".`);
  }
  if (!raw.startsWith("/")) {
    throw new MickeError("BAD_ARGUMENT", `cwd "${raw}" must be an absolute path`, `It runs in the guest, e.g. "/tmp", "/home/agent" or "/workspace".`);
  }
  return `cd -- ${shellQuote(raw)} 2>/dev/null || { printf '%s%s\\n' ${shellQuote(CWD_MARK)} ${shellQuote(raw)} >&2; exit 1; }\n`;
}

/** MICKE_SHELL_CONCURRENCY: default 8, 0 = unlimited, invalid falls back. */
function concurrencyLimit(): number {
  const raw = process.env.MICKE_SHELL_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CONCURRENCY;
  return n;
}

/**
 * One short-lived connection: connect, ready handshake, one request, one frame.
 * Nothing outlives a single run(), and a failure closes the socket immediately
 * — a retry is simply a new connection.
 */
class ShellConnection {
  private socket: Bun.Socket | null = null;
  private buf = Buffer.alloc(0);
  private diag = "";
  private readyWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private drainWaiter: (() => void) | null = null;
  private frameWaiter:
    | { resolve: (f: Frame) => void; reject: (err: Error) => void }
    | null = null;
  private dead = false;

  constructor(private readonly port: number) {}

  /** Connect to the in-guest listener and wait for ===SHELL_READY===. */
  async open(): Promise<void> {
    // The driver starts its listener before the desktop finishes booting, but
    // a just-respawned listener can take ~0.5 s: retry briefly.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        this.socket = await Bun.connect({
          hostname: "127.0.0.1",
          port: this.port,
          socket: {
            data: (_socket, chunk) => this.onData(chunk as Buffer),
            close: () => this.die("socket closed"),
            error: (_socket, err) => this.die(`socket error: ${err.message}`),
            drain: () => {
              const w = this.drainWaiter;
              this.drainWaiter = null;
              w?.();
            },
          },
        });
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 9) await Bun.sleep(500);
      }
    }
    if (!this.socket) {
      throw new MickeError(
        "SHELL_UNAVAILABLE",
        `cannot connect to the session shell on 127.0.0.1:${this.port}`,
        `The sandbox may have exited; check session_list. (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`,
      );
    }
    // Set the waiter after the TCP connect resolves: no data can be delivered
    // before this continuation yields, so the ready marker cannot be missed.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new MickeError("SHELL_UNAVAILABLE", `shell did not initialize on 127.0.0.1:${this.port}`, "The sandbox may have exited; check session_list.")),
          20_000,
        );
        this.readyWaiter = { resolve, reject };
      });
    } finally {
      clearTimeout(timer);
      this.readyWaiter = null;
    }
  }

  private onData(chunk: Buffer): void {
    if (this.dead) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    // Consume the per-connection ready marker if pending.
    if (this.readyWaiter) {
      const rIdx = this.buf.indexOf(SHELL_READY);
      if (rIdx >= 0) {
        this.buf = Buffer.concat([
          this.buf.subarray(0, rIdx),
          this.buf.subarray(rIdx + SHELL_READY.length),
        ]);
        const w = this.readyWaiter;
        this.readyWaiter = null;
        w.resolve();
      }
    }
    if (this.frameWaiter) this.tryExtract();
  }

  private tryExtract(): void {
    if (!this.frameWaiter) return;
    let frame: Frame | null = null;
    try {
      frame = parseFrame(this.buf);
    } catch (err) {
      const w = this.frameWaiter;
      this.frameWaiter = null;
      this.die(String(err));
      w.reject(
        new MickeError("SHELL_UNAVAILABLE", `shell protocol error: ${err}`, this.diag || undefined),
      );
      return;
    }
    if (!frame) return;
    this.buf = this.buf.subarray(frame.bytes);
    const w = this.frameWaiter;
    this.frameWaiter = null;
    w.resolve(frame);
  }

  private async write(s: string): Promise<void> {
    const socket = this.socket;
    if (!socket) throw new MickeError("SHELL_UNAVAILABLE", "shell is not connected", undefined);
    const bytes = Buffer.from(s, "utf8");
    let off = 0;
    try {
      while (off < bytes.length) {
        const n = socket.write(bytes, off, bytes.length - off);
        if (n <= 0) throw new Error("socket is closed");
        off += n;
        if (off < bytes.length) {
          // Backpressure: wait for the drain callback before the next chunk.
          await new Promise<void>((resolve) => {
            this.drainWaiter = resolve;
          });
        }
      }
      socket.flush();
    } catch (err) {
      this.die(`write failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new MickeError("SHELL_UNAVAILABLE", "shell connection died while sending a command", this.diag || undefined);
    }
  }

  private die(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.diag = (this.diag + (this.diag ? " | " : "") + reason).slice(-2048);
    const drain = this.drainWaiter;
    this.drainWaiter = null;
    drain?.();
    const ready = this.readyWaiter;
    this.readyWaiter = null;
    ready?.reject(new MickeError("SHELL_UNAVAILABLE", `shell connection died before ready: ${reason}`, this.diag));
    if (this.frameWaiter) {
      const w = this.frameWaiter;
      this.frameWaiter = null;
      w.reject(new MickeError("SHELL_UNAVAILABLE", `shell connection died: ${reason}`, this.diag));
    }
    this.closeSocket();
  }

  close(): void {
    if (this.dead) return;
    this.dead = true;
    const drain = this.drainWaiter;
    this.drainWaiter = null;
    drain?.();
    const ready = this.readyWaiter;
    this.readyWaiter = null;
    ready?.reject(new MickeError("SHELL_UNAVAILABLE", "shell connection closed while starting", this.diag || undefined));
    const frame = this.frameWaiter;
    this.frameWaiter = null;
    frame?.reject(new MickeError("SHELL_UNAVAILABLE", "shell connection closed", this.diag || undefined));
    this.closeSocket();
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try { socket.end(); } catch { /* already closed */ }
    try { socket.terminate(); } catch { /* already closed */ }
  }

  /** Write one request and read exactly one frame. */
  async request(command: string, timeoutMs: number, maxBytes: number): Promise<ShellResult> {
    const t0 = Date.now();
    const b64 = Buffer.from(command, "utf8").toString("base64");
    const framePromise = new Promise<Frame>((resolve, reject) => {
      this.frameWaiter = { resolve, reject };
    });
    // If the write below throws, this promise rejects with nobody awaiting it;
    // the no-op handler keeps that from surfacing as an unhandled rejection.
    framePromise.catch(() => {});
    await this.write(`__micke_run ${Math.max(0, Math.floor(timeoutMs))} ${Math.max(1, Math.floor(maxBytes))} ${b64}\n`);
    // Host-side backstop: the guest watchdog should fire first; if the frame
    // never arrives at all, this connection is unusable (it is closed below).
    const graceMs = Math.max(timeoutMs, 1_000) + 15_000;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    let frame: Frame;
    try {
      frame = await Promise.race([
        framePromise,
        new Promise<never>((_, reject) => {
          backstop = setTimeout(
            () => reject(new MickeError("SHELL_UNAVAILABLE", `no response after ${graceMs}ms; shell connection closed`, this.diag || undefined)),
            graceMs,
          );
        }),
      ]);
    } catch (err) {
      this.die("host-side timeout");
      throw err;
    } finally {
      clearTimeout(backstop);
    }
    // Defensive re-cap (the wrapper already truncated) + marker detection.
    const cap = (s: string): { text: string; truncated: boolean } => {
      const truncated = TRUNC_RE.test(s);
      if (s.length > maxBytes + 128) return { text: s.slice(0, maxBytes) + `\n…[truncated ${s.length - maxBytes} bytes]\n`, truncated: true };
      return { text: s, truncated };
    };
    const out = cap(frame.stdout);
    const errS = cap(frame.stderr);
    return {
      stdout: out.text,
      stderr: errS.text,
      rc: frame.rc,
      timedOut: frame.timedOut,
      truncated: { stdout: out.truncated, stderr: errS.truncated },
      durationMs: Date.now() - t0,
    };
  }
}

/**
 * A session's shell endpoint. It holds no socket: each run() opens, uses, and
 * closes its own connection. Parallel runs are allowed up to a bound
 * (MICKE_SHELL_CONCURRENCY, default 8, 0 = unlimited) because the guest forks
 * one bash per connection and an unbounded fan-out would be a guest fork bomb.
 */
export class ShellChannel {
  private connections = new Set<ShellConnection>();
  private active = 0;
  private waiters: Array<() => void> = [];
  private readonly limit: number;
  private dead = false;

  constructor(private readonly port: number, limit = concurrencyLimit()) {
    this.limit = limit;
  }

  get alive(): boolean {
    return !this.dead;
  }

  async run(
    command: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
    cwd = DEFAULT_CWD,
  ): Promise<ShellResult> {
    // Validate before queueing: a bad argument fails immediately.
    const prefix = cwdPrefix(cwd);
    await this.acquire();
    let conn: ShellConnection | null = null;
    try {
      if (this.dead) {
        throw new MickeError(
          "SHELL_UNAVAILABLE",
          `shell for this session is closed`,
          "The session was closed; create a new one with session_create.",
        );
      }
      conn = new ShellConnection(this.port);
      this.connections.add(conn);
      await conn.open();
      const result = await conn.request(prefix + command, timeoutMs, maxBytes);
      if (result.rc !== 0 && result.stderr.startsWith(CWD_MARK)) {
        throw new MickeError(
          "CWD_INVALID",
          `cwd "${cwd}" does not exist in the guest (or is not a directory)`,
          `cwd must be an absolute path inside the sandbox, e.g. "/tmp", "/home/agent" or "/workspace".`,
        );
      }
      return result;
    } finally {
      if (conn) {
        this.connections.delete(conn);
        conn.close();
      }
      this.release();
    }
  }

  // ---- bounded concurrency ------------------------------------------------
  //
  // Exceeding the cap queues (no failure): run() awaits a slot. A released slot
  // is handed straight to the oldest waiter, so `active` never overshoots.

  private acquire(): Promise<void> | null {
    if (this.limit === 0 || this.active < this.limit) {
      this.active++;
      return null;
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    if (this.dead) return; // kill() already reset the counters
    const next = this.waiters.shift();
    if (next) {
      next(); // slot transferred; `active` is unchanged
      return;
    }
    this.active--;
  }

  /** Close in-flight connections. There is no long-lived socket to tear down. */
  kill(): void {
    this.dead = true;
    for (const conn of this.connections) conn.close();
    this.connections.clear();
    // Wake queued runs: they observe `dead` and fail fast instead of hanging.
    const queued = this.waiters.splice(0);
    this.active = 0;
    for (const wake of queued) wake();
  }
}
