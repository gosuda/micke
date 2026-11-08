// winhide — the daemon hides its own console window on Windows.
//
// WHY: a logon-triggered scheduled task runs micke.exe directly, and a
// console-subsystem exe gets a console window — without this, the daemon
// would sit in the user's face at every logon. Task Scheduler has no "run
// hidden" switch (its Hidden setting only hides the task from the listing),
// so the daemon hides its own console the moment it starts. A sub-second
// flash remains while the process boots before its first statement runs —
// accepted: the zero-flash alternatives all trade it for a dependency (a
// wscript launcher dies where enterprises disable WSH; an S4U
// "whether user is logged on or not" task needs elevation and loses the
// interactive desktop the sessions run in).
//
// ONLY the daemon path may call this: the console is shared with the user's
// terminal, so hiding it from a CLI command would blank THEIR window.
// Never throws — a failure to hide is cosmetic, not fatal.
//
// Fast-tier note: on linux/macOS kernel32.dll does not exist, dlopen fails,
// and hideConsoleWindow() returns false — that null-guard path is what the
// suite exercises; the win32 window dance itself is untestable here (same
// deal as the flock FFI in supervisor.ts).

import { dlopen } from "bun:ffi";

const SW_HIDE = 0;

const kernel32 = (() => {
  try {
    return dlopen("kernel32.dll", {
      GetConsoleWindow: { args: [], returns: "ptr" },
      ShowWindow: { args: ["ptr", "i32"], returns: "i32" },
    });
  } catch {
    return null; // not Windows (or FFI unavailable): nothing to hide
  }
})();

/**
 * Hide this process's console window. Returns true when ShowWindow was
 * called (a console existed), false when there is nothing to hide on this
 * platform or no console is attached.
 */
export function hideConsoleWindow(): boolean {
  if (!kernel32) return false;
  const hwnd = kernel32.symbols.GetConsoleWindow();
  if (!hwnd) return false; // NULL — no console attached
  kernel32.symbols.ShowWindow(hwnd, SW_HIDE); // the return is prior visibility — irrelevant here
  return true;
}
