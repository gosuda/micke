// tests/service-files.test.ts — the pure service-registration generators.
//
// service.ts's actions shell out to systemctl/launchctl/schtasks; this host
// has no systemd user bus and the fast tier never invokes OS managers. The
// generators are pure functions of their parameters, so every property here
// is a content assertion with the home dir injected — never read from the
// environment under test.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compiledExe, launchdPlist, schtasksArgs, systemdUnit, unitPath } from "../src/service.js";

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
    expect(unit).toContain("Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/tester/.local/bin");
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

describe("schtasksArgs", () => {
  test("create registers a forced, logon-triggered task named micke", () => {
    const args = schtasksArgs("C:\\Program Files\\micke\\micke.exe", "create");
    expect(args).toContain("/F");
    expect(args).toContain("/SC");
    expect(args).toContain("ONLOGON");
    expect(args[args.indexOf("/TN") + 1]).toBe("micke");
    expect(args).toContain(`"C:\\Program Files\\micke\\micke.exe" daemon`);
  });

  test("delete forces the task; run/end/query only name it", () => {
    const del = schtasksArgs("C:\\micke.exe", "delete");
    expect(del).toContain("/Delete");
    expect(del).toContain("/F");
    expect(del.indexOf("/F")).toBeLessThan(del.indexOf("/TN"));
    expect(schtasksArgs("C:\\micke.exe", "run")).toEqual(["/Run", "/TN", "micke"]);
    expect(schtasksArgs("C:\\micke.exe", "end")).toEqual(["/End", "/TN", "micke"]);
    expect(schtasksArgs("C:\\micke.exe", "query")).toEqual(["/Query", "/TN", "micke"]);
  });
});

describe("unitPath", () => {
  test("win32 has no file — the scheduled task IS the registration", () => {
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
