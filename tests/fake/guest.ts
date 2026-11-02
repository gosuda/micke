// tests/fake/guest.ts — an in-process stand-in for the image's TCP shell driver.
//
// It speaks the guest half of the wire protocol byte-for-byte (see
// src/shell.ts): `===SHELL_READY===\n` on connect, one
// `__micke_run <timeout_ms> <max_bytes> <base64-cmd>\n` request per connection,
// and one frame back. No sandbox, no rungv, no image — the protocol is the
// thing under test, so a socket is enough.
//
// Behaviors are commands the test itself writes, so a test can name exactly
// one property per assertion:
//
//   echo <text>          stdout "<text>\n" (quotes stripped)
//   print <base64>       stdout decoded verbatim (exact bytes, newlines kept)
//   stderr <text>        stderr "<text>\n"
//   rc <n>               exit code n (stderr explains it)
//   sleep <seconds>      finishes, or emits a TIMEOUT frame at timeout_ms
//   big <bytes>          stdout "x" * bytes, capped at max_output_bytes
//   die-mid-frame        sends a partial frame, then closes the connection
//   pwd                  prints the directory selected by the host's cwd prefix
//
// The host prefixes every command with `cd -- '<dir>' … || { … exit 1; }`.
// The fake parses that prefix (the only quoting form shell.ts emits for simple
// paths) and answers with the guest's CWD marker for unknown directories, so
// the host's CWD_INVALID mapping is exercised end to end.

import { appendFileSync } from "node:fs";

const SHELL_READY = "===SHELL_READY===\n";
const BEGIN = "===BEGIN===\n";
const STDERR_MARK = "\n===STDERR===\n";
const TIMEOUT_MARK = "\n===TIMEOUT===\n";
const CWD_MARK = "micke: cannot enter cwd: ";
const DEFAULT_CWD = "/home/agent";
const DIRS = new Set([DEFAULT_CWD, "/tmp", "/workspace"]);

export interface FakeGuestOptions {
  /** Fake session hostname (`micke-<id>`), written into every log line. */
  session: string;
  /** Optional JSONL file: open/close/served events for concurrency assertions. */
  logPath?: string;
}

export interface FakeGuest {
  port: number;
  stop(): void;
}

interface Conn {
  buf: string;
  handled: boolean;
}

function frame(stdout: string, stderr: string, rc: number, timedOut = false): string {
  // The newline before each marker is always emitted; the parser strips exactly
  // that one, so stdout/stderr keep their own trailing newline (or lack of it).
  return `${BEGIN}${stdout}${STDERR_MARK}${stderr}${timedOut ? TIMEOUT_MARK : ""}\n===END rc=${rc}===\n`;
}

/** The image's per-stream cap, marker included. */
function capBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  const kept = buf.subarray(0, maxBytes).toString("utf8");
  return `${kept}\n…[truncated ${buf.length - maxBytes} bytes]\n`;
}

export function startFakeGuest(opts: FakeGuestOptions): FakeGuest {
  const conns = new Map<unknown, Conn>();
  let active = 0;
  let maxActive = 0;
  let served = 0;

  const log = (event: Record<string, unknown>) => {
    if (!opts.logPath) return;
    appendFileSync(opts.logPath, JSON.stringify({ session: opts.session, ...event }) + "\n");
  };

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        conns.set(socket, { buf: "", handled: false });
        active += 1;
        maxActive = Math.max(maxActive, active);
        log({ ev: "open", active, max_active: maxActive });
        socket.write(SHELL_READY);
      },
      data(socket, chunk) {
        const conn = conns.get(socket);
        if (!conn) return;
        conn.buf += chunk.toString();
        const nl = conn.buf.indexOf("\n");
        if (nl < 0) return;
        const line = conn.buf.slice(0, nl);
        conn.buf = conn.buf.slice(nl + 1);
        if (conn.handled) return;
        conn.handled = true;
        served += 1;
        log({ ev: "request", served });
        void handle(socket, line);
      },
      close(socket) {
        if (!conns.delete(socket)) return;
        active -= 1;
        log({ ev: "close", active });
      },
      error(socket, err) {
        if (!conns.delete(socket)) return;
        active -= 1;
        log({ ev: "error", active, message: err.message });
      },
    },
  });

  async function handle(socket: Bun.Socket, line: string): Promise<void> {
    const m = /^__micke_run (\d+) (\d+) (\S+)$/.exec(line);
    if (!m) {
      socket.end(frame("", "fake-guest: bad request line\n", 2));
      return;
    }
    const timeoutMs = Number.parseInt(m[1], 10);
    const maxBytes = Number.parseInt(m[2], 10);
    let command: string;
    try {
      command = Buffer.from(m[3], "base64").toString("utf8");
    } catch {
      socket.end(frame("", "fake-guest: bad base64 command\n", 2));
      return;
    }

    let cwd = DEFAULT_CWD;
    if (command.startsWith("cd -- '")) {
      const end = command.indexOf("'", 7);
      const dir = command.slice(7, end);
      const nl = command.indexOf("\n");
      if (nl >= 0) {
        command = command.slice(nl + 1);
        if (!DIRS.has(dir)) {
          socket.end(frame("", `${CWD_MARK}${dir}\n`, 1));
          return;
        }
        cwd = dir;
      }
    }

    const [verb, ...rest] = command.replace(/\n$/, "").split(/\s+/);
    const arg = rest.join(" ");

    try {
      switch (verb) {
        case "pwd":
          socket.end(frame(`${cwd}\n`, "", 0));
          return;
        case "echo": {
          const text = arg.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
          socket.end(frame(`${text}\n`, "", 0));
          return;
        }
        case "print":
          socket.end(frame(Buffer.from(arg, "base64").toString("utf8"), "", 0));
          return;
        case "stderr":
          socket.end(frame("", `${arg}\n`, 0));
          return;
        case "rc": {
          const rc = Number.parseInt(arg || "1", 10);
          socket.end(frame("", `exit ${rc}\n`, Number.isFinite(rc) ? rc : 1));
          return;
        }
        case "big":
          socket.end(frame(capBytes("x".repeat(Number.parseInt(arg || "0", 10)), maxBytes), "", 0));
          return;
        case "sleep": {
          const ms = Math.max(0, Math.round(Number.parseFloat(arg || "0") * 1000));
          if (timeoutMs > 0 && ms > timeoutMs) {
            await Bun.sleep(timeoutMs);
            socket.end(frame("", "command timed out\n", 143, true));
            return;
          }
          await Bun.sleep(ms);
          socket.end(frame("", "", 0));
          return;
        }
        case "die-mid-frame":
          // A partial frame is delivered, then the socket goes away before the
          // END marker: the host must report SHELL_UNAVAILABLE, not hang.
          socket.write(`${BEGIN}partial stdout`);
          socket.end();
          return;
        default:
          socket.end(frame(`${command}\n`, "", 0));
          return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        socket.end(frame("", `fake-guest: ${message}\n`, 1));
      } catch { /* peer already gone */ }
    }
  }

  return {
    port: server.port,
    stop: () => server.stop(true),
  };
}
