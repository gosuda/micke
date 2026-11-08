// service — register micke with the OS-native service manager.
//
// WHY the native managers (systemd --user on Linux, launchd on macOS,
// schtasks on Windows) instead of a hand-rolled daemonize: crash-restart,
// start-at-login and bounce-after-upgrade are solved problems there, and the
// OS already ships every tool. All registration is per-user — the daemon
// binds loopback only and gvx needs no root — so no step ever needs sudo.
//
// Windows note: a real Windows Service requires an elevated installer; a
// per-user ONLOGON scheduled task delivers the same start-at-login with no
// prompt at all, so that is what `micke service install` registers there.
//
// The generators (systemdUnit, launchdPlist, schtasksArgs, unitPath) are pure
// functions of their parameters — tests assert their content. The actions
// shell out through a local spawnSync `run()` helper, throw a plain Error
// carrying the remedy when a must-succeed command fails, and return a
// human-readable summary for the CLI to print. Re-running install is always
// safe: it overwrites the registration and bounces the daemon into the
// (possibly newer) binary — install doubles as the post-upgrade restart.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, userInfo } from "node:os";
import { defaultStateDir } from "./gvxio.js";

export const SERVICE_LABEL = "dev.gosuda.micke"; // launchd label (reverse-DNS)
export const WIN_TASK = "micke"; // schtasks task name
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

export function schtasksArgs(exe: string, action: "create" | "run" | "end" | "delete" | "query"): string[] {
  if (action === "create") {
    // /TR quotes the exe so "C:\Program Files\..." survives its space.
    return ["/Create", "/F", "/TN", WIN_TASK, "/TR", `"${exe}" daemon`, "/SC", "ONLOGON"];
  }
  const flag = `/${action[0].toUpperCase()}${action.slice(1)}`;
  return action === "delete" ? [flag, "/F", "/TN", WIN_TASK] : [flag, "/TN", WIN_TASK];
}

/**
 * Where this platform keeps our registration file, or null when there is no
 * file — on win32 the scheduled task IS the registration.
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
function run(cmd: string[]): RunResult {
  try {
    const r = Bun.spawnSync(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
 * schtasks /Run with a bounded retry. WHY: /End returns before the scheduler
 * reports the instance stopped, and the task's default IgnoreNew policy
 * refuses a /Run in that window — without the retry the daemon would just
 * stay down. Returns the last failed result so the caller can fail() with
 * the scheduler's own words.
 */
function schtasksRunWithRetry(): RunResult {
  let last: RunResult = { rc: 1, stdout: "", stderr: "" };
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) Bun.sleepSync(300);
    last = run(["schtasks", ...schtasksArgs("", "run")]);
    if (last.rc === 0) return last;
  }
  return last;
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
    return run(["schtasks", ...schtasksArgs("", "query")]).rc !== 0;
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

  // win32: the per-user ONLOGON task is the whole registration.
  const create = run(["schtasks", ...schtasksArgs(exe, "create")]);
  if (create.rc !== 0) fail("schtasks /Create", create);
  // /Create over a live task replaces the definition but leaves the old
  // instance running, and IgnoreNew then ignores the /Run until next logon —
  // so end it first (best-effort: it may not be running), like serviceRestart.
  run(["schtasks", ...schtasksArgs("", "end")]);
  const start = schtasksRunWithRetry();
  if (start.rc !== 0) fail("schtasks /Run", start);
  return `scheduled task "${WIN_TASK}" created and started (runs at logon)`;
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

  // win32: no file to stat — the task's presence is the registration.
  if (run(["schtasks", ...schtasksArgs("", "query")]).rc !== 0) return "micke service is not installed";
  run(["schtasks", ...schtasksArgs("", "end")]); // best-effort: may not be running
  const del = run(["schtasks", ...schtasksArgs("", "delete")]);
  if (del.rc !== 0) fail("schtasks /Delete", del);
  return `removed scheduled task "${WIN_TASK}"`;
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

  // win32: registrationMissing() already proved /Query succeeds. Prefer
  // PowerShell's State enum: Get-ScheduledTask prints locale-independent
  // names (Running/Ready/Disabled...), while schtasks /Query text is
  // localized and /running/i only matches English. Falls back to /Query.
  const ps = run(["powershell", "-NoProfile", "-Command", `(Get-ScheduledTask -TaskName '${WIN_TASK}').State`]);
  if (ps.rc === 0 && ps.stdout.trim()) {
    return `micke service: ${ps.stdout.trim().toLowerCase()}`;
  }
  const q = run(["schtasks", ...schtasksArgs("", "query")]);
  return /running/i.test(q.stdout) ? "micke service: running" : "micke service: registered (state unknown)";
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

  // win32: end is best-effort (the task may not be running), run must start it.
  run(["schtasks", ...schtasksArgs("", "end")]);
  const start = schtasksRunWithRetry();
  if (start.rc !== 0) fail("schtasks /Run", start);
}
