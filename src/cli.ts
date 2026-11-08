// cli — the `micke` command line: one thin argv dispatch, no flags of its own.
//
// WHY hand-rolled argv parsing: the surface is a handful of fixed subcommands
// with no options — an argument-parsing library would be a new dependency
// (repo policy: none) for zero behavior. The CLI writes usage and summaries to
// stdout; the daemon it can launch keeps its own stdout clean with
// diagnostics on stderr. `daemon` is a dynamic import so `micke help` never
// loads the supervisor.

import { MICKE_VERSION } from "./version.js";
import { serviceInstall, serviceRestart, serviceStatus, serviceUninstall } from "./service.js";

const USAGE = `micke ${MICKE_VERSION} — gvx sandbox desktops, managed over MCP

Usage: micke <command>

Commands:
  daemon              run the micke daemon in the foreground (what the service launches)
  service install     register micke with this OS's service manager and start it now
  service uninstall   stop micke and remove the service registration
  service status      report whether the registered micke daemon is running
  service restart     bounce the registered daemon (e.g. after an upgrade)
  upgrade             replace this micke binary with the latest release
  version             print the micke version
  help                show this help

Environment (daemon): MICKE_PORT (default 7800), MICKE_STATE_DIR, MICKE_IMAGE — see the README.
`;

/** Run one CLI invocation; resolves to the exit code or throws a user error. */
async function main(argv: string[]): Promise<number> {
  const [cmd, sub] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(USAGE);
      return 0;
    case "daemon":
      // Foreground, exactly what service managers launch. Never returns
      // (signal handlers exit); if it ever does, that was a clean stop.
      await (await import("./main.js")).main();
      return 0;
    case "version":
    case "-v":
    case "--version":
      console.log(MICKE_VERSION);
      return 0;
    case "service":
      switch (sub) {
        case "install":
          console.log(serviceInstall());
          return 0;
        case "uninstall":
          console.log(serviceUninstall());
          return 0;
        case "status":
          console.log(serviceStatus());
          return 0;
        case "restart":
          serviceRestart();
          console.log("micke service restarted");
          return 0;
        default:
          process.stderr.write(USAGE);
          return 1;
      }
    case "upgrade":
      // Self-update ships in a later unit; until then, an honest failure.
      throw new Error("upgrade is not implemented yet");
    default:
      process.stderr.write(USAGE);
      return 1;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`micke: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  });
  if (code !== 0) process.exit(code); // 0 falls through, letting stdout drain
}
