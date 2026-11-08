// service — register micke with the OS-native service manager.
//
// WHY the native managers (systemd --user on Linux, launchd on macOS,
// Task Scheduler / the Run key on Windows) instead of a hand-rolled
// daemonize: crash-restart, start-at-login and bounce-after-upgrade are
// solved problems there, and the OS already ships every tool. All
// registration is per-user — the daemon binds loopback only and gvx needs
// no root — so no step ever needs sudo.
//
// Windows note: a real Windows Service requires an elevated installer. The
// per-user start-at-login is a logon-triggered scheduled task registered
// the UNELEVATED way — PowerShell's ScheduledTasks module with the trigger
// scoped to $env:USERNAME and -RunLevel Limited. (schtasks /Create
// /SC ONLOGON, an earlier design, is denied for a standard user even for
// their own account: the trigger is machine-wide. Register-ScheduledTask
// with explicit per-user scoping is not.) On policy-locked boxes where even
// that is denied, the fallback is an HKCU Run entry — the per-user analogue
// of systemd --user. The task's ExecutionTimeLimit is set to PT0S by
// property assignment: the 3-day default would kill the daemon 72 hours
// after every logon, and the -ExecutionTimeLimit PARAMETER silently drops
// a zero timespan on some builds.
//
// The generators (systemdUnit, launchdPlist, the WIN_*_PS payloads, unitPath)
// are pure — tests assert their content. The actions shell out through a
// local spawnSync `run()` helper, throw a plain Error carrying the remedy
// when a must-succeed command fails, and return a human-readable summary
// for the CLI to print. Re-running install is always safe: it overwrites
// the registration.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, userInfo } from "node:os";
import { defaultStateDir } from "./gvxio.js";

export const SERVICE_LABEL = "dev.gosuda.micke"; // launchd label (reverse-DNS)
export const WIN_TASK = "micke"; // task name AND Run-key value name
const SYSTEMD_UNIT = "micke"; // systemd --user unit ("micke.service" on disk)

// ---- pure generators --------------------------------------------------------

export function systemdUnit(exe: string, home: string): string {
  return `[Unit]
Description=micke daemon (gvx sandbox desktops over MCP)
After=network-online.target

[Service]
# WHY the explicit PATH: systemd --user gets a minimal default PATH; a rungv
# in /usr/local/bin or ~/.local/bin would be invisible and micke would
# self-provision a second rungv over an existing install. Quoted whole: an
# unquoted value with a space-containing home splits into two assignments.
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${home}/.local/bin"
ExecStart=${JSON.stringify(exe)} daemon
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/** Escape the four characters XML reserves in element text and attributes. */
function xml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function launchdPlist(exe: string, logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${SERVICE_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(exe)}</string>
		<string>daemon</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ProcessType</key><string>Background</string>
	<key>StandardOutPath</key><string>${xml(logPath)}</string>
	<key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

/** Powershell host argv; a payload rides as one -Command argument. */
export function powershellArgs(payload: string): string[] {
  return ["powershell", "-NoProfile", "-Command", payload];
}

/**
 * The scheduled-task payloads (PS 5.1 syntax only — no ?? or ternaries).
 * The exe travels in $env:MICKE_EXE, so a path with spaces or non-ASCII
 * user names can never break quoting. `register` is the unelevated
 * recipe: current-user logon trigger + Limited run level (see the header).
 */
export const WIN_TASK_PS = {
  register: [
    "$a = New-ScheduledTaskAction -Execute $env:MICKE_EXE -Argument 'daemon'",
    "$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
    "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
    "$s.ExecutionTimeLimit = 'PT0S'",
    `Register-ScheduledTask -TaskName '${WIN_TASK}' -Action $a -Trigger $t -Settings $s -RunLevel Limited -Force`,
  ].join("; "),
  start: `Start-ScheduledTask -TaskName '${WIN_TASK}'`,
  state: `(Get-ScheduledTask -TaskName '${WIN_TASK}' -ErrorAction SilentlyContinue).State`,
  unregister: `Unregister-ScheduledTask -TaskName '${WIN_TASK}' -Confirm:$false -ErrorAction SilentlyContinue`,
} as const;

/**
 * The Run-key fallback for policy-locked machines (some domain-joined
 * boxes deny non-admin task creation entirely). The value name is
 * WIN_TASK, so the `get` payload's `.micke` property access below is that
 * same name spelled out.
 */
export const WIN_RUNKEY_PS = {
  set: `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${WIN_TASK}' -Value ('"' + $env:MICKE_EXE + '" daemon')`,
  get: `(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${WIN_TASK}' -ErrorAction SilentlyContinue).micke`,
  remove: `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${WIN_TASK}' -ErrorAction SilentlyContinue`,
} as const;

/**
 * Daemon-process payloads. `stop`/`count` match the image micke.exe AND a
 * command line ending in ` daemon`: killing by image name alone would also
 * kill the `micke service ...` CLI that is running this very code. (On
 * Windows the supervisor lock is a no-op — no flock through the libc FFI —
 * so the lock file is NOT a reliable stop handle there.)
 */
export const WIN_DAEMON_PS = {
  stop: `Get-CimInstance Win32_Process -Filter "Name = 'micke.exe'" | Where-Object { $_.CommandLine -match ' daemon$' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
  start: `Start-Process -FilePath $env:MICKE_EXE -ArgumentList 'daemon' -WindowStyle Hidden`,
  count: `Get-CimInstance Win32_Process -Filter "Name = 'micke.exe'" | Where-Object { $_.CommandLine -match ' daemon$' } | Measure-Object | Select-Object -ExpandProperty Count`,
} as const;

/**
 * Where this platform keeps our registration file, or null when there is no
 * file — on win32 the scheduled task or Run entry IS the registration.
 */
export function unitPath(platform = process.platform): string | null {
  if (platform === "linux") return join(homedir(), ".config", "systemd", "user", `${SYSTEMD_UNIT}.service`);
  if (platform === "darwin") return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  return null;
}

/**
 * The binary a service file may point at. Throws under bun (the dev tree): a
 * registration pointing at ~/.bun/bin/bun breaks on the first bun upgrade and
 * never tracks the compiled binary's tag. Remedy: install micke first (see
 * the README's install command), then run `micke service install` again.
 */
export function compiledExe(): string {
  const exe = process.execPath;
  if (!basename(exe).toLowerCase().startsWith("micke")) {
    throw new Error(
      `service registration must point at the compiled micke binary, not the dev tree (running from ${exe}). ` +
        "Install micke first — see the install command in the README — then run `micke service install` again.",
    );
  }
  return exe;
}

// ---- process plumbing -------------------------------------------------------

interface RunResult {
  rc: number;
  stdout: string;
  stderr: string;
}

/** spawnSync + capture: service commands are short, one-shot, non-interactive. */
function run(cmd: string[], env: Record<string, string> = {}): RunResult {
  try {
    const r = Bun.spawnSync(cmd, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    return { rc: r.exitCode ?? 127, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } catch (err) {
    // ENOENT etc.: report it in the same shape instead of throwing.
    return { rc: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** Throw with the command's own words; the message is the CLI's remedy text. */
function fail(what: string, r: RunResult): never {
  const detail = (r.stderr || r.stdout).trim().slice(0, 300);
  throw new Error(`${what} failed (rc=${r.rc})${detail ? `: ${detail}` : ""}`);
}

/**
 * Start-ScheduledTask with a bounded retry. WHY: the scheduler's IgnoreNew
 * policy refuses a start while the just-ended instance is still winding
 * down — without the retry the daemon would just stay down. Returns the
 * last failed result so the caller can fail() with the scheduler's own
 * words.
 */
function winStartTaskWithRetry(): RunResult {
  let last: RunResult = { rc: 1, stdout: "", stderr: "" };
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) Bun.sleepSync(300);
    last = run(powershellArgs(WIN_TASK_PS.start));
    if (last.rc === 0) return last;
  }
  return last;
}

// ---- windows backend ---------------------------------------------------------

/** Which registration this Windows user carries: task, Run entry, or none. */
function winBackend(): "task" | "runkey" | null {
  if (run(powershellArgs(WIN_TASK_PS.state)).stdout.trim() !== "") return "task";
  if (run(powershellArgs(WIN_RUNKEY_PS.get)).stdout.trim() !== "") return "runkey";
  return null;
}

/** Stop exactly the running daemon (either backend). Best-effort by design. */
function winStopDaemon(): void {
  run(powershellArgs(WIN_DAEMON_PS.stop)); // none running → harmless no-op
}

/** Start the daemon through whatever registration exists. */
function winStartDaemon(exe: string, backend: "task" | "runkey"): RunResult {
  if (backend === "task") return winStartTaskWithRetry();
  return run(powershellArgs(WIN_DAEMON_PS.start), { MICKE_EXE: exe });
}

function requireSupportedPlatform(): void {
  if (!["linux", "darwin", "win32"].includes(process.platform)) {
    throw new Error(`no service-manager support for ${process.platform}`);
  }
}

const NOT_INSTALLED = "micke service is not installed (run: micke service install)";

/** The "is our registration there at all" check status and restart share. */
function registrationMissing(): boolean {
  if (process.platform === "win32") {
    return winBackend() === null;
  }
  const p = unitPath();
  return p === null || !existsSync(p);
}

// ---- actions ----------------------------------------------------------------

export function serviceInstall(): string {
  requireSupportedPlatform();
  const exe = compiledExe();

  if (process.platform === "linux") {
    if (run(["systemctl", "--version"]).rc !== 0) {
      throw new Error("no systemd; run `micke daemon` manually or add an autostart entry");
    }
    const unit = unitPath("linux")!;
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, systemdUnit(exe, homedir()));

    const reload = run(["systemctl", "--user", "daemon-reload"]);
    if (reload.rc !== 0) fail("systemctl --user daemon-reload", reload);
    const enable = run(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT]);
    if (enable.rc !== 0) fail("systemctl --user enable --now micke", enable);
    // ALWAYS restart after enable: re-running install over an existing
    // registration must bounce the daemon into the (newer) binary.
    const restart = run(["systemctl", "--user", "restart", SYSTEMD_UNIT]);
    if (restart.rc !== 0) fail("systemctl --user restart micke", restart);

    let summary = `installed ${unit}\nsystemd user service ${SYSTEMD_UNIT} enabled and started`;
    // Best-effort: without linger the unit only exists inside a login session.
    if (run(["loginctl", "enable-linger", userInfo().username]).rc !== 0) {
      summary += "\nwarning: could not enable linger; micke starts at login, not at boot (loginctl enable-linger)";
    }
    return summary;
  }

  if (process.platform === "darwin") {
    const plist = unitPath("darwin")!;
    const stateDir = defaultStateDir();
    mkdirSync(stateDir, { recursive: true }); // StandardOutPath target must exist
    const logPath = join(stateDir, "daemon.log");
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, launchdPlist(exe, logPath));
    run(["launchctl", "unload", plist]); // ignore rc: refreshes an existing registration
    const load = run(["launchctl", "load", plist]);
    if (load.rc !== 0) fail("launchctl load", load);
    return `installed ${plist}\nlaunchd agent ${SERVICE_LABEL} loaded (log: ${logPath})`;
  }

  // win32: the unelevated task first, the Run-key fallback for policy-locked
  // boxes. Either way the daemon is bounced so re-running install over an
  // existing registration lands on the new binary.
  const taskReg = run(powershellArgs(WIN_TASK_PS.register), { MICKE_EXE: exe });
  let backend: "task" | "runkey";
  if (taskReg.rc === 0) {
    backend = "task";
  } else {
    const runKey = run(powershellArgs(WIN_RUNKEY_PS.set), { MICKE_EXE: exe });
    if (runKey.rc !== 0) {
      // Both mechanisms denied: the user must see BOTH reasons, not just one.
      const taskWhy = (taskReg.stderr || taskReg.stdout).trim().slice(0, 200);
      const keyWhy = (runKey.stderr || runKey.stdout).trim().slice(0, 200);
      throw new Error(
        `could not register a start-at-login entry. Task Scheduler: ${taskWhy}. Run key: ${keyWhy}. ` +
          "Start the daemon manually instead (\u0060micke daemon\u0060) or retry from an elevated prompt.",
      );
    }
    backend = "runkey";
  }
  winStopDaemon(); // the old instance keeps running past a re-register
  const start = winStartDaemon(exe, backend);
  if (start.rc !== 0) fail(backend === "task" ? "Start-ScheduledTask" : "Start-Process (daemon)", start);
  return backend === "task"
    ? `scheduled task "${WIN_TASK}" registered (logon trigger, no elevation needed) and started`
    : `HKCU Run entry registered (Task Scheduler was denied — likely domain policy) and daemon started`;
}

export function serviceUninstall(): string {
  requireSupportedPlatform();

  if (process.platform === "linux") {
    const unit = unitPath("linux")!;
    if (!existsSync(unit)) return "micke service is not installed";
    run(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]); // best-effort
    rmSync(unit, { force: true });
    run(["systemctl", "--user", "daemon-reload"]); // best-effort
    run(["systemctl", "--user", "reset-failed", SYSTEMD_UNIT]); // best-effort
    return `removed ${unit}`;
  }

  if (process.platform === "darwin") {
    const plist = unitPath("darwin")!;
    if (!existsSync(plist)) return "micke service is not installed";
    run(["launchctl", "unload", plist]); // best-effort: may not be loaded
    rmSync(plist, { force: true });
    return `removed ${plist}`;
  }

  // win32: no file to stat — whichever registration exists IS the install.
  const backend = winBackend();
  if (backend === null) return "micke service is not installed";
  winStopDaemon(); // best-effort: may not be running
  run(powershellArgs(WIN_TASK_PS.unregister)); // both removed best-effort: the
  run(powershellArgs(WIN_RUNKEY_PS.remove)); // absent one is a no-op
  return backend === "task" ? `removed scheduled task "${WIN_TASK}"` : "removed the HKCU Run entry";
}

export function serviceStatus(): string {
  requireSupportedPlatform();
  if (registrationMissing()) return NOT_INSTALLED;

  if (process.platform === "linux") {
    // is-active prints active/inactive/activating/failed on stdout.
    const r = run(["systemctl", "--user", "is-active", SYSTEMD_UNIT]);
    return `micke service: ${r.stdout.trim() || "unknown"}`;
  }

  if (process.platform === "darwin") {
    const list = run(["launchctl", "list"]);
    if (list.rc !== 0) fail("launchctl list", list);
    // Rows are `PID\tStatus\tLabel`; PID "-" = loaded, not running.
    const row = list.stdout.split("\n").find((l) => l.trim().startsWith(SERVICE_LABEL));
    if (!row) return `micke service: registered, not loaded (run: micke service install)`;
    const pid = row.trim().split("\t")[0];
    return `micke service: ${pid === "-" ? "loaded, not running" : `running (pid ${pid})`}`;
  }

  // win32: registrationMissing() already proved a registration exists. The
  // task reports its State enum (locale-independent: Running/Ready/...); a
  // Run-key box has no scheduler state, so the daemon process count speaks.
  const backend = winBackend()!;
  if (backend === "task") {
    const r = run(powershellArgs(WIN_TASK_PS.state));
    return `micke service: ${(r.stdout.trim() || "unknown").toLowerCase()}`;
  }
  const n = run(powershellArgs(WIN_DAEMON_PS.count)).stdout.trim();
  return `micke service: ${Number(n) > 0 ? "running" : "registered (run key), not running"}`;
}

export function serviceRestart(): void {
  requireSupportedPlatform();
  if (registrationMissing()) throw new Error(NOT_INSTALLED);

  if (process.platform === "linux") {
    const r = run(["systemctl", "--user", "restart", SYSTEMD_UNIT]);
    if (r.rc !== 0) fail("systemctl --user restart micke", r);
    return;
  }

  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? parseInt(run(["id", "-u"]).stdout.trim(), 10);
    const target = `gui/${uid}/${SERVICE_LABEL}`;
    const r = run(["launchctl", "kickstart", "-k", target]);
    if (r.rc !== 0) fail(`launchctl kickstart -k ${target}`, r);
    return;
  }

  // win32: bounce = stop exactly the daemon, start it on whatever
  // registration exists. The task path races the scheduler's IgnoreNew
  // window; winStartDaemon retries through it.
  const backend = winBackend();
  if (backend === null) throw new Error(NOT_INSTALLED); // re-checked: it may have vanished
  winStopDaemon();
  const start = winStartDaemon(compiledExe(), backend);
  if (start.rc !== 0) fail("daemon start", start);
}
