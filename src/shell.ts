// shell — ONE long-lived shell per session, over a TCP socket to the guest's
// socket driver (image/driver.sh). gvx has no exec: the driver listens on
// 127.0.0.1:<picked host port> -> guest :7801 and forks one bash per connection.
//
// The host writes one request line per command and parses the frame that comes
// back. Protocol (documented in docs/server-internals.md):
//
//   host -> guest:  __micke_run <timeout_ms> <max_output_bytes> <base64-cmd>\n
//   guest -> host:
//     ===BEGIN===\n
//     <stdout bytes>\n===STDERR===\n
//     <stderr bytes>\n[===TIMEOUT===\n]\n===END rc=N===\n
//
// The `__micke_run` wrapper lives in the image (byte-equal to the old exec
// INIT): the command runs in a background process group so a per-command
// watchdog can TERM/KILL exactly that group while the bash survives. cwd +
// exported env persist across commands within one connection.
//
// A dropped connection is recoverable: the desktop survives, a fresh connection
// gets a fresh bash (exec-channel semantics), and the NEXT run() reconnects.

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

interface Frame {
  stdout: string;
  stderr: string;
  rc: number;
  timedOut: boolean;
  bytes: number; // frame length consumed
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

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

export class ShellChannel {
  private socket: Bun.Socket | null = null;
  private buf = Buffer.alloc(0);
  private diag = "";
  private readyWaiter: (() => void) | null = null;
  private drainWaiter: (() => void) | null = null;
  private frameWaiter:
    | { resolve: (f: Frame) => void; reject: (err: Error) => void }
    | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private dead = false;

  constructor(private port: number) {}

  get alive(): boolean {
    return !!this.socket && !this.dead;
  }

  /** Connect to the in-guest listener and wait for ===SHELL_READY===. */
  async start(): Promise<void> {
    if (this.socket) return;
    this.dead = false;
    this.diag = "";
    this.buf = Buffer.alloc(0);
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
        await Bun.sleep(500);
      }
    }
    if (!this.socket) {
      this.die(`connect failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
      throw new MickeError(
        "SHELL_UNAVAILABLE",
        `cannot connect to the session shell on 127.0.0.1:${this.port}`,
        this.diag || "The sandbox may have exited; check session_list.",
      );
    }
    // Set the waiter after the TCP connect resolves: no data can be delivered
    // before this continuation yields, so the ready marker cannot be missed.
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new MickeError("SHELL_UNAVAILABLE", `shell did not initialize on 127.0.0.1:${this.port}`, "The sandbox may have exited; check session_list.")),
        20_000,
      );
      this.readyWaiter = () => {
        clearTimeout(t);
        resolve();
      };
    });
    try {
      await ready;
    } catch (err) {
      this.die("ready marker not received");
      throw err;
    }
  }

  private onData(chunk: Buffer): void {
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
        w();
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
    if (!socket) throw new MickeError("SHELL_UNAVAILABLE", "shell is not running", undefined);
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
      throw new MickeError("SHELL_UNAVAILABLE", "shell channel died while sending a command", this.diag || undefined);
    }
  }

  private die(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.diag = (this.diag + (this.diag ? " | " : "") + reason).slice(-2048);
    const drain = this.drainWaiter;
    this.drainWaiter = null;
    drain?.();
    if (this.frameWaiter) {
      const w = this.frameWaiter;
      this.frameWaiter = null;
      w.reject(new MickeError("SHELL_UNAVAILABLE", `shell channel died: ${reason}`, this.diag));
    }
    this.closeSocket();
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try { socket.end(); } catch { /* already closed */ }
    try { socket.terminate(); } catch { /* already closed */ }
  }

  /** Run one command. Serialized: one in-flight command per shell. */
  run(command: string, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_OUTPUT_BYTES): Promise<ShellResult> {
    const task = () => this.runOnce(command, timeoutMs, maxBytes);
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  private async runOnce(command: string, timeoutMs: number, maxBytes: number): Promise<ShellResult> {
    if (!this.alive) {
      throw new MickeError(
        "SHELL_UNAVAILABLE",
        `shell on port ${this.port} is not running`,
        "The session's shell dropped; the next call reconnects with a fresh shell (cwd/env reset).",
      );
    }
    const t0 = Date.now();
    const b64 = Buffer.from(command, "utf8").toString("base64");
    const framePromise = new Promise<Frame>((resolve, reject) => {
      this.frameWaiter = { resolve, reject };
    });
    await this.write(`__micke_run ${Math.max(0, Math.floor(timeoutMs))} ${Math.max(1, Math.floor(maxBytes))} ${b64}\n`);
    // Host-side backstop: the guest watchdog should fire first; if the frame
    // never arrives at all, the channel is unusable.
    const graceMs = Math.max(timeoutMs, 1_000) + 15_000;
    let frame: Frame;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    try {
      frame = await Promise.race([
        framePromise,
        new Promise<never>((_, reject) => {
          backstop = setTimeout(
            () => reject(new MickeError("SHELL_UNAVAILABLE", `no response after ${graceMs}ms; shell channel killed`, this.diag || undefined)),
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

  kill(): void {
    this.dead = true;
    if (this.frameWaiter) {
      const w = this.frameWaiter;
      this.frameWaiter = null;
      w.reject(new MickeError("SHELL_UNAVAILABLE", "shell channel closed", this.diag || undefined));
    }
    const drain = this.drainWaiter;
    this.drainWaiter = null;
    drain?.();
    this.closeSocket();
  }
}
