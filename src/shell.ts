// shell — ONE long-lived `bash` per session, via `docker exec -i` (no `-t`).
//
// The container-side bash is initialized with a `__micke_run` wrapper (below).
// The host writes one request line per command and parses the frame that comes
// back. Protocol (documented in docs/server-internals.md):
//
//   host -> container:  __micke_run <timeout_ms> <max_output_bytes> <base64-cmd>\n
//   container -> host:
//     ===BEGIN===\n
//     <stdout bytes>\n===STDERR===\n
//     <stderr bytes>\n[===TIMEOUT===\n]\n===END rc=N===\n
//
// The command runs in a background subshell (its own process group via `set -m`)
// so a per-command watchdog can TERM/KILL exactly that group on timeout while
// the persistent bash survives. cwd + exported env persist across commands:
// the wrapper diffs `export -p` before/after and re-applies changes globally.

import { MickeError } from "./supervisor.js";

export interface ShellResult {
  stdout: string;
  stderr: string;
  rc: number;
  timedOut: boolean;
  truncated: { stdout: boolean; stderr: boolean };
  durationMs: number;
}

const INIT = String.raw`
__micke_after() {
    # $1 = rc of the evaluated command; idempotent (first rc wins)
    if [ ! -s "$rcfile" ]; then printf '%s' "$1" > "$rcfile"; fi
    printf '%s' "$PWD" > "$dfile"
    export -p | sort > "$after"
}
__micke_sig() { __micke_after "$1"; exit "$1"; }
__micke_run() {
    # $1 = timeout_ms (0 = none), $2 = max_output_bytes per stream, $3 = base64 command
    local tmo="$1" limit="$2" b64="$3"
    local cmd out err rc before after dfile rcfile flag cpid wpid osz esz
    cmd="$(printf '%s' "$b64" | base64 -d)"
    out="$(mktemp /tmp/.micke-out.XXXXXX)"
    err="$(mktemp /tmp/.micke-err.XXXXXX)"
    before="$(mktemp /tmp/.micke-env.XXXXXX)"
    after="$(mktemp /tmp/.micke-env2.XXXXXX)"
    dfile="$(mktemp /tmp/.micke-dir.XXXXXX)"
    rcfile="$(mktemp /tmp/.micke-rc.XXXXXX)"
    flag="$(mktemp /tmp/.micke-flag.XXXXXX)"
    export -p | sort > "$before"
    printf '===BEGIN===\n'
    (
        trap '__micke_sig 143' TERM
        trap '__micke_sig 130' INT
        trap '__micke_sig 129' HUP
        trap '__micke_after $?' EXIT
        eval "$cmd"
        __micke_after $?
    ) > "$out" 2> "$err" < /dev/null &
    cpid=$!
    wpid=""
    if [ "$tmo" -gt 0 ] 2>/dev/null; then
        local secs="$((tmo / 1000)).$(printf '%03d' $((tmo % 1000)))"
        (
            sleep "$secs"
            if [ ! -s "$rcfile" ]; then
                printf '1' > "$flag"
                kill -TERM -- "-$cpid" 2>/dev/null
                sleep 2
                kill -KILL -- "-$cpid" 2>/dev/null
            fi
        ) &
        wpid=$!
    fi
    wait "$cpid"; rc=$?
    if [ -n "$wpid" ]; then kill -TERM -- "-$wpid" 2>/dev/null; wait "$wpid" 2>/dev/null; fi
    if [ -s "$rcfile" ]; then rc="$(cat "$rcfile")"; fi
    osz=$(wc -c < "$out"); esz=$(wc -c < "$err")
    if [ "$osz" -gt "$limit" ]; then
        head -c "$limit" "$out"; printf '\n…[truncated %s bytes]\n' "$((osz - limit))"
    else
        cat "$out"
    fi
    printf '\n===STDERR===\n'
    if [ "$esz" -gt "$limit" ]; then
        head -c "$limit" "$err"; printf '\n…[truncated %s bytes]\n' "$((esz - limit))"
    else
        cat "$err"
    fi
    if [ -s "$flag" ]; then printf '\n===TIMEOUT===\n'; fi
    printf '\n===END rc=%s===\n' "$rc"
    # Persist cwd + exported env, but only if the command completed (not killed)
    if [ -s "$rcfile" ] && [ -s "$dfile" ] && [ -s "$after" ] && [ ! -s "$flag" ]; then
        while read -r n; do
            case "$n" in ''|*[!A-Za-z0-9_]*|PWD|OLDPWD|SHLVL|_) continue ;; esac
            unset "$n" 2>/dev/null || true
        done < <(comm -23 "$before" "$after" | sed 's/^declare -[^ ]* \([^=]*\)=.*/\1/')
        while IFS= read -r l; do
            eval "$(printf '%s' "$l" | sed 's/^declare -x /declare -gx /')" 2>/dev/null || true
        done < <(comm -13 "$before" "$after" | grep -v -e 'PWD=' -e 'OLDPWD=' -e 'SHLVL=' -e '^[^ ]* _=')
        cd -- "$(cat "$dfile")" 2>/dev/null || true
    fi
    rm -f "$out" "$err" "$before" "$after" "$dfile" "$rcfile" "$flag"
}
# Desktop env (DISPLAY/D-Bus/AT-SPI) is published by the entrypoint; wait for it
# so agent-desktop works with no manual setup.
i=0
while [ "$i" -lt 100 ] && [ ! -f /tmp/session.env ]; do sleep 0.1; i=$((i+1)); done
. /tmp/session.env 2>/dev/null || true
set -m 2>/dev/null || true
echo '===SHELL_READY==='
`;

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
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private buf = Buffer.alloc(0);
  private stderrTail = "";
  private readyWaiter: (() => void) | null = null;
  private frameWaiter:
    | { resolve: (f: Frame) => void; reject: (err: Error) => void }
    | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private dead = false;

  constructor(private container: string) {}

  get alive(): boolean {
    return !!this.proc && !this.dead;
  }

  /** Spawn `docker exec -i bash`, run the init script, wait for readiness. */
  async start(): Promise<void> {
    if (this.proc) return;
    const proc = Bun.spawn(["docker", "exec", "-i", this.container, "bash"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    void this.readStderr();
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new MickeError("SHELL_UNAVAILABLE", `shell did not initialize in container ${this.container}`, "The container may have exited; check session_list.")),
        20_000,
      );
      this.readyWaiter = () => {
        clearTimeout(t);
        resolve();
      };
    });
    void this.readLoop(proc).catch(() => this.die("shell read loop failed"));
    await this.write(INIT + "\n");
    await ready;
  }

  private async readLoop(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    for await (const chunk of proc.stdout!) {
      this.buf = Buffer.concat([this.buf, chunk as Buffer]);
      // Consume init marker if pending.
      if (this.readyWaiter) {
        const rIdx = this.buf.indexOf("===SHELL_READY===\n");
        if (rIdx >= 0) {
          this.buf = Buffer.concat([
            this.buf.subarray(0, rIdx),
            this.buf.subarray(rIdx + "===SHELL_READY===\n".length),
          ]);
          const w = this.readyWaiter;
          this.readyWaiter = null;
          w();
        }
      }
      if (this.frameWaiter) this.tryExtract();
    }
    this.die("shell exited");
  }

  private async readStderr(): Promise<void> {
    // Diagnostics from the wrapper bash itself (not command output) — kept as a
    // tail for error messages.
    for await (const chunk of this.proc!.stderr!) {
      this.stderrTail = (this.stderrTail + (chunk as Buffer).toString()).slice(-4096);
    }
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
        new MickeError("SHELL_UNAVAILABLE", `shell protocol error: ${err}`, this.stderrTail || undefined),
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
    const proc = this.proc;
    if (!proc) throw new MickeError("SHELL_UNAVAILABLE", "shell is not running", undefined);
    proc.stdin.write(s);
    await proc.stdin.flush();
  }

  private die(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    if (this.frameWaiter) {
      const w = this.frameWaiter;
      this.frameWaiter = null;
      w.reject(new MickeError("SHELL_UNAVAILABLE", `shell channel died: ${reason}`, this.stderrTail || undefined));
    }
    if (this.readyWaiter) {
      // start()'s timeout will surface the error; nothing else to do here.
    }
    this.kill();
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
        `shell for container ${this.container} is not running`,
        "The session's shell died; close and re-create the session.",
      );
    }
    const t0 = Date.now();
    const b64 = Buffer.from(command, "utf8").toString("base64");
    const framePromise = new Promise<Frame>((resolve, reject) => {
      this.frameWaiter = { resolve, reject };
    });
    await this.write(`__micke_run ${Math.max(0, Math.floor(timeoutMs))} ${Math.max(1, Math.floor(maxBytes))} ${b64}\n`);
    // Host-side backstop: the container watchdog should fire first; if the
    // frame never arrives at all, the channel is unusable.
    const graceMs = Math.max(timeoutMs, 1_000) + 15_000;
    let frame: Frame;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    try {
      frame = await Promise.race([
        framePromise,
        new Promise<never>((_, reject) => {
          backstop = setTimeout(
            () => reject(new MickeError("SHELL_UNAVAILABLE", `no response after ${graceMs}ms; shell channel killed`, this.stderrTail || undefined)),
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
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.stdin?.end(); } catch { /* already closed */ }
      try { proc.kill(9); } catch { /* already gone */ }
      // Reap (also on the error paths below): a killed-but-unawaited child
      // could linger as a zombie and show up in leak-cycle counts (FR-10).
      void proc.exited.then(() => {}, () => {});
    }
  }
}
