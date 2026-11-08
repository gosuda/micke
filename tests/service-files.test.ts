// tests/service-files.test.ts — the pure service-registration generators.
//
// service.ts's actions shell out to systemctl/launchctl/powershell; this
// host has no systemd user bus and the fast tier never invokes OS managers.
// The generators are pure functions of their parameters, so every property
// here is a content assertion with the home dir injected — never read from
// the environment under test.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compiledExe, launchdPlist, systemdUnit, unitPath, WIN_DAEMON_PS, WIN_RUNKEY_PS, WIN_TASK, WIN_TASK_PS } from "../src/service.js";

const ROOT = join(import.meta.dir, "..");

describe("systemdUnit", () => {
  test("ExecStart points at the quoted exe with the daemon subcommand", () => {
    // JSON.stringify is systemd's own quoting for ExecStart paths.
    expect(systemdUnit("/usr/local/bin/micke", "/home/tester"))
      .toContain(`ExecStart=${JSON.stringify("/usr/local/bin/micke")} daemon`);
  });

  test("restarts on failure, two seconds apart", () => {
    const unit = systemdUnit("/usr/local/bin/micke", "/home/tester");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=2");
  });

  test("installs into the user default target after the network", () => {
    const unit = systemdUnit("/usr/local/bin/micke", "/home/tester");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("After=network-online.target");
  });

  test("PATH spans the system dirs and the injected home's ~/.local/bin", () => {
    const unit = systemdUnit("/usr/local/bin/micke", "/home/tester");
    // Quoted whole: an unquoted value with a space-containing home would
    // split into two assignments in systemd.
    expect(unit).toContain(`Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/tester/.local/bin"`);
    expect(unit).toContain("/usr/local/bin");
    expect(unit).toContain("/home/tester/.local/bin");
  });
});

describe("launchdPlist", () => {
  test("carries the reverse-DNS label", () => {
    expect(launchdPlist("/usr/local/bin/micke", "/tmp/micke/daemon.log"))
      .toContain("<key>Label</key><string>dev.gosuda.micke</string>");
  });

  test("ProgramArguments runs the exe with `daemon` after it", () => {
    const plist = launchdPlist("/usr/local/bin/micke", "/tmp/micke/daemon.log");
    const exeTag = "<string>/usr/local/bin/micke</string>";
    expect(plist).toContain(exeTag);
    expect(plist).toContain("<string>daemon</string>");
    expect(plist.indexOf(exeTag)).toBeLessThan(plist.indexOf("<string>daemon</string>"));
  });

  test("starts at login and stays alive", () => {
    const plist = launchdPlist("/usr/local/bin/micke", "/tmp/micke/daemon.log");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
  });

  test("XML-escapes & in the exe and log paths", () => {
    const plist = launchdPlist("/a & b/micke", "/a & b/daemon.log");
    expect(plist).toContain("<string>/a &amp; b/micke</string>");
    expect(plist).not.toContain("/a & b");
  });
});

describe("windows registration payloads", () => {
  // Two shipped Windows defects pinned here. v0.1.2: schtasks /Create
  // /SC ONLOGON is denied for a standard user — replaced by the unelevated
  // Register-ScheduledTask recipe. v0.1.3: the daemon hid its own console
  // with ShowWindow, which a scheduled task's startup race ignores on
  // Windows 10 (pyinstaller#8798) and Windows Terminal's emulated handle
  // ignores outright on Windows 11 (microsoft/terminal#15311) — replaced
  // by launching through conhost --headless, where no window ever exists.
  test("the task registers with a current-user logon trigger at Limited run level", () => {
    expect(WIN_TASK_PS.register).toContain("New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME");
    expect(WIN_TASK_PS.register).toContain("-RunLevel Limited");
    expect(WIN_TASK_PS.register).toContain(`-TaskName '${WIN_TASK}'`);
  });

  test("every launch goes through headless conhost — the window never exists", () => {
    // conhost is GUI-subsystem, so the default-terminal routing never
    // applies, and --headless creates the console with no window at all
    // (Win10 1809+; the same mechanism every ConPTY consumer runs on).
    expect(WIN_TASK_PS.register).toContain(`-Execute "$env:WINDIR\\System32\\conhost.exe"`);
    expect(WIN_TASK_PS.register).toContain(`('--headless "' + $env:MICKE_EXE + '" daemon')`);
    expect(WIN_RUNKEY_PS.set).toContain(`conhost.exe" --headless`);
    expect(WIN_DAEMON_PS.start).toContain(`'\\System32\\conhost.exe'`);
    expect(WIN_DAEMON_PS.start).toContain(`('--headless "' + $env:MICKE_EXE + '" daemon')`);
  });

  test("no payload hides a window from inside the process or shells out to schtasks", () => {
    // The in-process hide is the mechanism that failed both ways (Win10
    // race, Win11 handle emulation); it must not come back, and neither
    // must the denied schtasks path.
    const payloads = [...Object.values(WIN_TASK_PS), ...Object.values(WIN_RUNKEY_PS), ...Object.values(WIN_DAEMON_PS)];
    for (const p of payloads) {
      expect(p).not.toContain("ShowWindow");
      expect(p).not.toContain("schtasks");
      expect(p).not.toContain("ONLOGON");
    }
  });

  test("no 72-hour execution limit: PT0S as a property assignment, not a parameter", () => {
    // The -ExecutionTimeLimit PARAMETER silently drops a zero timespan on
    // some builds; the property assignment works everywhere.
    expect(WIN_TASK_PS.register).toContain("$s.ExecutionTimeLimit = 'PT0S'");
  });

  test("laptop-safe: the task may start and keep running on battery", () => {
    expect(WIN_TASK_PS.register).toContain("-AllowStartIfOnBatteries");
    expect(WIN_TASK_PS.register).toContain("-DontStopIfGoingOnBatteries");
  });

  test("the exe travels via $env:MICKE_EXE — no path quoting to break", () => {
    // A path with spaces or a non-ASCII user name must never be spliced
    // into command text; the payloads that need the exe read the env var.
    expect(WIN_TASK_PS.register).toContain("$env:MICKE_EXE");
    expect(WIN_RUNKEY_PS.set).toContain("$env:MICKE_EXE");
    expect(WIN_DAEMON_PS.start).toContain("$env:MICKE_EXE");
  });

  test("stop/count hit only the daemon, never the service CLI itself", () => {
    // Killing by image name alone would also kill `micke service ...`.
    expect(WIN_DAEMON_PS.stop).toContain(`Name = 'micke.exe'`);
    expect(WIN_DAEMON_PS.stop).toContain("-match ' daemon$'");
    expect(WIN_DAEMON_PS.count).toContain("-match ' daemon$'");
  });
});

// pwsh-gated: every payload parses on a real PowerShell engine. The fast
// tier cannot run Register-ScheduledTask (no Task Scheduler on unix), but a
// syntax error on PS 5.1 — the target host! — is exactly the class a
// parse check catches. Payloads are handed over base64-encoded so no
// quoting layer can corrupt them on the way into pwsh.
describe.skipIf(Bun.which("pwsh") === null)("windows payloads parse under a real pwsh", () => {
  test("every payload is valid PowerShell", () => {
    const payloads = [...Object.values(WIN_TASK_PS), ...Object.values(WIN_RUNKEY_PS), ...Object.values(WIN_DAEMON_PS)];
    for (const p of payloads) {
      const b64 = Buffer.from(p, "utf8").toString("base64");
      const r = Bun.spawnSync(
        ["pwsh", "-NoProfile", "-Command",
          `[scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))) | Out-Null; 'ok'`],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const out = r.stdout.toString().trim();
      expect(out).toBe("ok"); // a parse failure prints nothing and exits nonzero
    }
  });
});

describe("unitPath", () => {
  test("win32 has no file — the task or Run entry IS the registration", () => {
    expect(unitPath("win32")).toBeNull();
  });

  // os.homedir() roots the registration at $HOME, but bun caches homedir()
  // at its FIRST call per process — and earlier suites in the same process
  // have already called it. So the property is proven in a fresh child with
  // HOME injected, not by mutating this process's env.
  describe.skipIf(process.platform === "win32")("on posix", () => {
    test("roots the registration under the user's home ($HOME)", () => {
      const script = `import { unitPath } from ${JSON.stringify(join(ROOT, "src", "service.ts"))};`
        + `console.log(unitPath("linux"));console.log(unitPath("darwin"));`;
      const r = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: ROOT,
        env: { ...process.env, HOME: "/home/tester" },
        stdin: "ignore",
      });
      expect(r.exitCode).toBe(0);
      const [linux, darwin] = r.stdout.toString().trim().split("\n");
      expect(linux).toBe(join("/home/tester", ".config/systemd/user/micke.service"));
      expect(darwin).toBe(join("/home/tester", "Library/LaunchAgents/dev.gosuda.micke.plist"));
    });
  });
});

describe("compiledExe", () => {
  test("refuses the dev tree: bun's execPath is not the compiled micke", () => {
    // The fast tier always runs under bun, so basename(execPath) is "bun".
    expect(() => compiledExe()).toThrow(/dev tree/);
  });
});
