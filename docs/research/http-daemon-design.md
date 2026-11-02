# micke HTTP daemon design — stdio → persistent Streamable HTTP

Date: 2026-11-02. Repo: `~/git/micke` (M-min shipped: supervisor + 4 tools, stdio).
SDK read from installed source: `node_modules/@modelcontextprotocol/sdk@1.32.2`
(`dist/esm/…` paths cited below — read, not guessed). Spike:
`/tmp/opencode/micke-http-spike/spike.ts` (throwaway, not committed). Files read
before writing: `src/{main,mcp,supervisor,shell,dashboard,dockerio}.ts`,
`tests/*.ts`, `docs/server-internals.md`, `docs/prd.md` §5–8, `README.md`,
`opencode.json`. No files in `src/`, `tests/`, or existing docs were modified.

## 1. Decision & rationale

Migrate the MCP server from client-spawned stdio to a persistent daemon
(`bun start`) serving MCP over Streamable HTTP at `http://127.0.0.1:7800/mcp`,
with the existing static dashboard on `/` of the same port. stdio mode is
REMOVED — one way only, per the minimalist discipline
(docs/research/minimalist-cut.md §3). Target shape:

```
micke daemon (bun start, long-running; flock on <state dir>/supervisor.lock unchanged)
├── POST http://127.0.0.1:7800/mcp   <- MCP Streamable HTTP (stateless, same 4 tools)
└── GET  http://127.0.0.1:7800/      <- existing no-JS dashboard (behavior unchanged)
```

The three verified pains, and why the daemon fixes each:

1. **Client disconnect kills everything.** Today stdin EOF is a shutdown
   trigger (`src/main.ts:43-45`); every shell channel dies and containers
   become orphans. An MCP client restart mid-task loses all session shells.
   With HTTP, clients have no lifecycle coupling: a disconnect is a dropped
   TCP connection; the daemon, sessions, and shell channels don't notice.
   Proven in the spike: two clients connected, both closed, a third connected
   and called a tool — server state intact.
2. **Orphans are list/close-only.** `runShell` throws `SESSION_ORPHANED`
   (`src/supervisor.ts:198-199`) for any session from a previous run — even a
   desktop a human just logged into over noVNC is dead to the agent after a
   supervisor restart. In the daemon world the container is the session
   identity (it carries `micke.session=<id>` and survives us); the daemon can
   re-attach on demand (§5): open a FRESH shell channel into the live
   container, rediscover the noVNC port, flip the row back to `ready`.
3. **One client per host.** flock gives one supervisor per state dir, and the
   supervisor *is* the MCP server, so a second client dies with `LOCK_HELD`.
   With HTTP, N clients share the one daemon; the lock now protects exactly
   what it was designed for (state dir + containers), not client count.

**What we consciously give up:** client-managed process lifecycle. Today the
MCP client spawns micke and restarts it for free; after the migration the
daemon must be up before any client connects, and nothing auto-restarts it if
it dies (containers become adoptable orphans exactly as today, and the daemon
re-adopts them at startup — but the port is dark until restart). Mitigation: a
documented systemd **user** unit (§8) plus the re-attach path (§5) making
restarts cheap. This is the same trade every local daemon makes (docker,
ssh-agent); we pay it once and get pains 1–3 solved.

## 2. SDK findings (read from `node_modules/@modelcontextprotocol/sdk@1.32.2`)

### a. Which server transport class fits Bun.serve

**`WebStandardStreamableHTTPServerTransport`**, exported from
`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`
(`dist/esm/server/webStandardStreamableHttp.js`). Its header comment: "It can
run on any runtime that supports Web Standards: Node.js 18+, Cloudflare
Workers, Deno, **Bun**, etc." The shape is exactly what Bun.serve's `fetch`
wants:

```ts
handleRequest(req: Request, options?: { parsedBody?: unknown; authInfo?: AuthInfo }): Promise<Response>
```

The alternative, `StreamableHTTPServerTransport`
(`dist/esm/server/streamableHttp.js`), is a Node.js wrapper: its
`handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?)` takes
Node http objects and internally converts via `@hono/node-server`. Under
Bun.serve it would need fake IncomingMessage objects — strictly worse.
**Choice: the web-standard class.** It is the core implementation; the Node
variant is a thin wrapper around it (streamableHttp.js:4-7).

Routing (exact pattern, proven in the spike):

```ts
if (path === "/mcp" && req.method === "POST") {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // stateless
    enableJsonResponse: true,        // plain JSON responses, no SSE
  });
  const mcp = new Server({ name: "micke", version: "0.1.0" }, { capabilities: { tools: {} } });
  registerTools(mcp, sup);
  await mcp.connect(transport);
  return transport.handleRequest(req);
}
if (path === "/mcp") return new Response("Method not allowed\n", { status: 405, headers: { Allow: "POST" } });
```

### b. Stateless mode

- **Session ids off:** `sessionIdGenerator: undefined` (the constructor
  default is also undefined — `options = {}`, line 57 — but pass it
  explicitly for intent). In stateless mode `validateSession()` short-circuits
  (line 738: "If the sessionIdGenerator ID is not set, the session management
  is disabled"), no `Mcp-Session-Id` header is ever emitted, and every POST
  carrying an `initialize` request is treated as a fresh handshake. That is
  the correct semantic for us: micke sessions live in the Supervisor, not in
  the MCP transport.
- **CRITICAL — a stateless transport is single-use.** `handleRequest` throws
  `"Stateless transport cannot be reused across requests. Create a new
  transport per request."` on second use (lines 174-178). The route MUST
  construct a fresh transport per POST. And because the low-level `Server`
  refuses reconnecting while a transport is attached
  (`shared/protocol.js:220-222`: "Already connected to a transport… use a
  separate Protocol instance per connection"), the clean pattern is a fresh
  `Server` + fresh transport per request (registration of two request
  handlers is allocation-cheap). This also removes every cross-request race
  inside the SDK for free.
- **GET in stateless mode:** the router returns **405** itself (do not
  delegate). The transport's `handleGetRequest` would otherwise open a
  hanging standalone SSE stream. 405 is spec-blessed: the client source
  treats it as expected (`client/streamableHttp.js:114-118`: "405 indicates
  that the server does not offer an SSE stream at GET endpoint. This is an
  expected case that should not trigger an error"). This matters because the
  client DOES send one GET: after the `notifications/initialized` POST is
  answered 202 (notifications get no body — server line 573-578), the client
  auto-opens a GET SSE stream (client lines 384-391). Our 405 closes that
  path cleanly — verified in the spike run.
- **DELETE in stateless mode:** the router also returns 405. In practice it
  is never sent: `terminateSession()` no-ops without a session id (client
  lines 446-449), and stateless servers never set one. (Spec allows 405.)
- **Is SSE needed at all? No.** We have a tools-only server with zero
  server-initiated messages (no sampling, no subscriptions, no progress).
  With `enableJsonResponse: true` the transport answers each POST with a
  plain `application/json` body (server lines 590-608) and never spins up a
  ReadableStream or keep-alive timer. The client fully supports JSON
  responses (client lines 407-416: "For non-streaming servers, we might get
  direct JSON responses"). There is no dedicated stateless class in 1.32.2 —
  stateless is a mode of the same class; `enableJsonResponse: true` +
  `sessionIdGenerator: undefined` + fresh-per-request is the stateless
  recipe.
- **Body cap:** `maxRequestBodySize` defaults to 4 MiB, answered 413
  (server lines 109-115, 490-496). Our largest request body is a shell
  command string — fine. Response bodies (shell stdout+stderr, up to 2×256
  KiB + JSON) are NOT capped by the transport.

### c. Compatibility with our low-level `Server`

Direct. `src/mcp.ts` uses `Server` from `server/index.js` with
`setRequestHandler(ListToolsRequestSchema/CallToolRequestSchema, …)` and plain
JSON Schema — no zod, no high-level McpServer. `registerTools(server, sup)`
attaches to any `Server` instance and is transport-agnostic; only `main.ts`
changes (where `connect()` is called and with what transport). The per-request
`new Server(...)` + `registerTools(...)` pattern is exactly what the spike
exercised.

### d. Security-relevant options

- `allowedHosts?: string[]`, `allowedOrigins?: string[]`,
  `enableDnsRebindingProtection?: boolean` — all present in
  `WebStandardStreamableHTTPServerTransportOptions` and all **@deprecated**
  ("Use external middleware for host/origin validation instead",
  webStandardStreamableHttp.d.ts:80-96). Validation only runs when
  `enableDnsRebindingProtection: true`; Origin is checked only when present.
  **Decision: do not use them.** The loopback bind is the security property
  (FR-23 pattern), and our Bun.serve router IS the middleware: a 4-line
  Origin check (if an `Origin` header is present and is not
  `http://127.0.0.1:<port>` / `http://localhost:<port>` → 403) gives the same
  DNS-rebinding defense without deprecated options. Browsers always send
  `Origin` on cross-origin POSTs; MCP clients send none.
- No auth options exist on the transport (OAuth server pieces live in
  `server/auth/*`, unused by us — we never emit 401).

### e. Client side for tests

**`StreamableHTTPClientTransport`** from
`@modelcontextprotocol/sdk/client/streamableHttp.js`:
`new StreamableHTTPClientTransport(new URL("http://127.0.0.1:<port>/mcp"))`,
driven by the same low-level `Client` (`client/index.js`) the tests already
use. It is fetch-based by default (`this._fetch ?? fetch`, client line 100;
custom `fetch` injectable) — works under Bun unchanged. Sends exactly the
headers the server validates (`accept: application/json, text/event-stream`,
`content-type: application/json`, client lines 310-312), handles JSON
responses, tolerates GET 405, and `close()` merely aborts (client lines
294-301) — no DELETE, no teardown side effects on the daemon.

### f. Spike (throwaway, not committed)

`/tmp/opencode/micke-http-spike/spike.ts` (~95 lines incl. comments): Bun.serve
on `port: 0` (ephemeral, read back from `server.port`), the exact routing from
§2a, a trivial `echo` tool whose handler runs through a per-key promise queue
mirroring `ShellChannel.run()`'s serialization, then four checks.

Result — **all pass, first run**:

```
spike: daemon on http://127.0.0.1:44931/  mcp=http://127.0.0.1:44931/mcp
1) listTools -> echo
1) callTool -> hello (+300ms queued+run)
2) concurrent A -> A (+300ms queued+run), B -> B (+300ms queued+run)
3) after both clients closed -> after-reconnect (+300ms queued+run)
4) GET / -> 200 "dashboard", GET /mcp -> 405
SPIKE OK
```

Check 2 is the multi-client/shared-session case: two clients' tool calls on
one session serialized by the queue, no overlap. Check 3 is pains-1-and-3:
clients disconnect, daemon and state healthy. Check 4 proves one port serves
both routes and GET /mcp answers 405. Verdict: **the round trip works under
Bun with zero new dependencies** — the SDK already in `package.json` contains
everything. On "pick the simpler one if both work": both classes exist, but
only the web-standard class fits Bun.serve's `fetch` natively; the Node
wrapper would require fabricating `IncomingMessage`/`ServerResponse` objects,
so the simpler one IS the web-standard class, and it is chosen.

## 3. Process model

- **Startup:** `bun start` → `new Supervisor()` → `start()` (flock on
  `<state dir>/supervisor.lock`, load `sessions.json`, scan orphans) —
  unchanged, lock path and semantics identical. Then bind ONE Bun.serve on
  `127.0.0.1:$MICKE_PORT` (default 7800) serving `/` + `/mcp`, and print to
  stderr one line the tests and humans can parse:
  `micke: daemon at http://127.0.0.1:<port>/ (mcp: POST /mcp)`. Port from
  `server.port` (kernel-picked when `MICKE_PORT=0`).
- **Bind order & failure:** flock FIRST, then bind (a second micke with a
  different state dir still loses the port race cleanly). Unlike today —
  where a dashboard bind failure is non-fatal (`dashboard.ts:92-95`) — the
  daemon's port IS the product, so a bind failure is **fatal**: structured
  `{"code":"PORT_HELD", …}`-style message on stderr, exit 1, with the port
  and `MICKE_PORT` in the hint. flock conflicts keep today's `LOCK_HELD`
  path (`supervisor.ts:277-281`) — the daemon-exit UX for "second instance"
  is unchanged: prompt exit, structured stderr, nothing on stdout.
- **Signals:** SIGTERM/SIGINT → stop the HTTP server, kill all shell
  channels (`supervisor.shutdown()`), containers STAY and become adoptable
  orphans — byte-identical semantics to today (`main.ts:33-40`), minus the
  stdin trigger. systemd's default `KillSignal=SIGTERM` composes correctly;
  `TimeoutStopSec` should exceed any in-flight `session_shell` (else systemd
  SIGKILLs, which is also survivable — same as a hard kill).
- **stdin:** no longer meaningful — remove the `process.stdin.on("end"/"close")`
  shutdown hooks (`main.ts:43-45`). The daemon may be started from a terminal,
  `nohup`, or systemd; stdin can be `ignore`d. Stdout stays protocol-clean out
  of habit (nothing writes to it); diagnostics stay on stderr.

## 4. HTTP surface

One port, two routes, loopback only:

| Route | Method | Behavior |
| :-- | :-- | :-- |
| `/mcp` | POST | Stateless MCP (fresh transport+Server per request), JSON responses |
| `/mcp` | GET/DELETE/others | 405, `Allow: POST` |
| `/` | GET | Existing no-JS dashboard table (unchanged markup, meta-refresh) |
| anything else | any | 404 `not found` (as today, `dashboard.ts:79-81`) |

**Port config: rename `MICKE_DASHBOARD_PORT` → `MICKE_PORT`**, default 7800,
same semantics (`0` = kernel-picked, value read back and printed). All six
occurrences of the old name are ours and grep-clean
(`src/dashboard.ts:2,72`; `tests/mmin-phase2.test.ts:69,148`;
`tests/leak-cycles.test.ts:90`; `docs/server-internals.md:22,47`).
**Recommendation: break cleanly, no alias.** The repo is pre-1.0, there is no
external consumer, and an alias is a second code path — the minimalist
discipline says one name, one port, one meaning. The rename also matches
reality: the port no longer serves "a dashboard", it serves the daemon.

## 5. Session lifecycle & orphan re-attach

State today: `ready` (live in `sessions`, lazy shell) or `orphaned`
(`orphanStates`, listed, close-only). New transition:

```
              session_shell on orphan (container ALIVE)
orphaned ────────────────────────────────────────────> ready (reattached)
   │                                                      │ fresh ShellChannel opened on
   │ session_shell on orphan (container DEAD/ghost)       │ first use; port rediscovered
   └──────────────> SESSION_ORPHANED (unchanged error)    │ state saved as live
                                                          v
                                              normal session (close/list/shell)
```

Exact mechanics, in `Supervisor.runShell`'s `!live && orphanStates.has(id)`
branch (replacing the throw at `supervisor.ts:198-199`):

1. **Liveness check:** `io.containerRunning(container_id)` (`dockerio.ts:93-96`).
   Not running → keep throwing `SESSION_ORPHANED`, hint updated to "the
   container is not running; close it with session_close".
2. **Port rediscovery:** `io.hostPort(container_id, 6080)` (`docker port`,
   `dockerio.ts:48-53`) — same call `bootSession` uses at create time. A
   running container keeps its `-p 127.0.0.1::6080` mapping, so this normally
   succeeds; `null` (running but mapping gone, e.g. docker restarted) →
   proceed with `novnc_port: null`: shell still works, the dashboard row
   shows "—" for noVNC, as orphan rows already do (`dashboard.ts:35-36`).
3. **Promote the row:** move the `SessionState` from `orphanStates` to
   `sessions` with the rediscovered port and `shell: null`; `saveState()`
   (`supervisor.ts:356-365`) persists it in the same `sessions.json` — the
   file shape is unchanged (it already stores a flat array of session states;
   "orphan" is a runtime distinction, not a file distinction). `created_at`
   is preserved, so uptime in the dashboard is continuous across the daemon
   restart.
4. **Open a FRESH shell channel** and run the command — i.e. fall through to
   the existing lazy-open path (`supervisor.ts:203-206`): `ShellChannel.start()`
   waits for `/tmp/session.env` (shell.ts INIT loop) so the desktop env
   (DISPLAY/D-Bus/AT-SPI) is re-sourced automatically.

**Races — two clients hitting the same orphan simultaneously:** both would
pass the liveness check and both would promote + open a shell; the second
`sessions.set` would overwrite the first, leaking the first `docker exec`
child. The existing per-session serialization (§6) lives INSIDE
`ShellChannel` and only guards commands on an already-open channel — it
cannot guard the open itself. So adoption gets its own tiny per-id mutex, the
same promise-chaining pattern as `withBootLock` (`supervisor.ts:314-318`):
`adoptLocks: Map<string, Promise<LiveSession>>`; first caller performs
1-4, the second awaits it, finds the session already live with its shell
opening/opened, and just runs its command through the (already serialized)
channel. ~15 lines.

**What re-attach does NOT restore:**

- **Shell cwd and exported env** — the old bash died with the old daemon (or
  the hard-killed `docker exec`); the fresh bash starts at the image WORKDIR
  with only `/tmp/session.env` re-sourced. `cd`/`export` history is gone.
  (This is exactly the documented FR-14 boundary, now with a defined
  behavior: explicit fresh-shell semantics, never silent half-state.)
- **Background jobs of the old shell** — killed with the old channel or the
  hard kill; anything still alive in its own process group survives until
  close (known edge, FR-13 deferred, unchanged).
- **Snapshot refs held by the agent before the restart** — the desktop
  (Xvfb, chromium, windows, logged-in sessions) survives, but refs from an
  old snapshot may name processes the old shell owned; the honest contract is
  "take a fresh `agent-desktop snapshot` after re-attach". agent-desktop's
  own `state_root` under `/home/agent` persists in the container's writable
  layer, so its config/permissions survive.
- **In-flight command results** — a `session_shell` whose daemon died
  mid-frame is lost; the client sees a transport error, retries against the
  restarted daemon, re-attaches.

Sessions created by client A remain fully visible and drivable by client B
(§6) — re-attach is client-agnostic by the same token.

## 6. Concurrency contract

- **Stateless MCP = no client affinity.** Every POST is independent
  (fresh transport+Server); the Supervisor is the only stateful component and
  it keys everything by micke session id, never by client. Client count is
  unbounded; clients come and go freely (pain 3).
- **Per-session serialization (existing, verified):** `ShellChannel.run()`
  chains every command on a per-channel promise queue
  (`shell.ts:269-274`: "Serialized: one in-flight command per session"). Two
  clients shelling into one session interleave in arrival order; frames can
  never interleave (the protocol has one `frameWaiter`, `shell.ts:159-162`).
  The spike's check 2 exercised exactly this shape. The NEW adoption mutex
  (§5) extends the same guarantee to channel opening.
- **Cross-session parallelism:** separate channels, separate queues —
  commands on different sessions run concurrently (today's behavior,
  unchanged; phase-1 tests rely on nothing here, leak-cycles is sequential).
- **Global registries, all in-process (single event loop, no threads):**
  - `sessions` / `orphanStates` maps: mutated only between `await`s, so
    atomic w.r.t. other requests; adoption is mutex-guarded (§5).
  - `sessions.json` writes: `writeFileSync` (`supervisor.ts:363`) —
    synchronous, last-writer-wins, no torn file within the process. Same as
    today.
  - Pull/boot mutex: `withBootLock` (`supervisor.ts:314-318`) — unchanged;
    "never two pulls, never a pull beside a live session" holds regardless of
    client count.
  - `docker` CLI subprocesses: independent per call (`dockerio.ts`), no
    shared handle.
  - **Nothing needs a new lock** except the adoption mutex. flock already
    excludes a second daemon, so no cross-process locking is ever needed.
- **Fairness note:** MCP tool calls are serialized per session but NOT
  globally — a slow `session_create` (pull) does not block `session_list`
  (different code path), and a slow shell on session A does not block session
  B. One client's 120 s command does not time out another client's calls.

## 7. Test migration & plan

Current: all three suites spawn the server via `StdioClientTransport`
(phase1 ×2 incl. the restart block, phase2 ×2 via `spawnServer`,
leak-cycles ×1; grep receipts in §4 style). New harness, one helper per suite
(or a shared `tests/helpers.ts`, ~25 lines):

1. `Bun.spawn([process.execPath, MAIN], { env: { …, MICKE_STATE_DIR: tmpdir, MICKE_PORT: "0" }, stdin: "ignore", stderr: "pipe" })`.
2. Read stderr until the `micke: daemon at http://127.0.0.1:<port>/` line
   (regex the port) — this is why the daemon must print the bound port (§3).
   `MICKE_PORT=0` is chosen over pick-free-port-then-pass (the `freePort()`
   trick the tests use today) because it removes the TOCTOU window entirely;
   kernel-picked means no other process can have taken it.
3. `client.connect(new StreamableHTTPClientTransport(new URL(…)))` — same
   `call/callErr` helpers work untouched (they sit on `Client.callTool`).

Per-suite changes:

- **mmin-phase1:** swap both transport constructions for the helper; the
  §13 orphan block becomes the re-attach proof (below).
- **mmin-phase2:** `spawnServer` swaps its internals; the `LOCK_HELD` test
  already spawns a raw process and reads stderr — unchanged; dashboard tests
  point at the daemon port (same assertions, no second server needed —
  simpler than today, which ran the dashboard on its own port).
- **leak-cycles:** pid for `/proc/<pid>/fd` counting comes from
  `Bun.spawn().pid` directly (today it digs `transport.pid` — easier now);
  fd-count assertions may need the tolerance re-baselined once: HTTP
  connections add sockets per request; the tolerance is ±8 fds and requests
  are sequential, so it should hold — re-baseline only if the run says so
  (and document in-file, as the current tolerance is).
- **New tests required:**
  - (a) **Disconnect survival:** connect, `session_create`, `client.close()`,
    reconnect a fresh client, `session_shell` still works on the same
    session id (this is the pain-1 acceptance test; ~15 lines inside the new
    file).
  - (b) **Two clients, one session, serialization:** two `Client`s on one
    daemon; fire two `session_shell` calls concurrently on the same session
    (`sleep 0.3; echo A` vs `echo B`); assert both succeed and outputs don't
    interleave (rc 0, exact stdout each). Plus `session_list` from both shows
    the same row.
  - (c) **Orphan re-attach incl. desktop survival:** create session, launch
    chromium on example.com, wait for the window; hard-kill the daemon
    (`proc.kill(9)`), respawn on the same state dir (new ephemeral port),
    `session_list` → row `orphaned`; `session_shell` → succeeds (re-attach),
    row flips to `ready` with a `novnc_url`; `agent-desktop wait --window
    "Example Domain"` → still found (desktop state survived the daemon
    death); `pwd` ≠ any old cwd (fresh shell). Fold into phase1 §13, which
    already creates the orphan — it grows ~30 lines.
- **Keep as-is:** boot/noVNC-200/shell-persistence/output-cap/timeout-kill/
  workspace-bind/close-teardown/structured-errors (phase1), lock/floor/pull-
  serialization/dashboard (phase2), 20-cycle leak loop — all transport-
  agnostic once `call()` sits on the HTTP client.

**Runtime impact:** the suites swap per-test server *spawn* cost (bun boot
~0.3-0.5 s × restarts) for one spawn + HTTP connects (~ms each) — neutral to
slightly faster. Net new work is (c)'s extra container boot + restart +
re-attach (~10-20 s) and (a)/(b)'s connects (~1 s). Estimate: **~55 s →
~70-80 s** total for `bun test`. Docker pulls remain the only network
dependency (phase2's hello-world).

## 8. File-by-file change plan

| File | Change | Est. lines |
| :-- | :-- | ---: |
| `src/main.ts` (46) | Rewrite: drop `StdioServerTransport` + stdin hooks; own the ONE Bun.serve (hostname 127.0.0.1, `MICKE_PORT`), route `/mcp` POST (fresh transport+Server per request) / `/mcp` else 405 / `/` dashboard / 404; fatal structured exit on bind failure; same signal handlers; print the daemon line | ~+30 |
| `src/mcp.ts` (142) | Add `createMcpServer(sup): Server` factory (new Server + registerTools) so the route stays 3 lines; tool schemas/handlers untouched | ~+10 |
| `src/supervisor.ts` (381) | Orphan re-attach in `runShell` (liveness, port rediscovery, promote, fall through to lazy shell) + `adoptLocks` mutex; `SESSION_ORPHANED` kept for dead containers with updated hint | ~+35 |
| `src/dashboard.ts` (96) | Drop `startDashboard`'s Bun.serve + port env (~-30); export `dashboardResponse(listSessions): Promise<Response>` used by main.ts's router; `renderDashboard`/escaping unchanged | ~-22 |
| `tests/mmin-phase1.test.ts` (243) | Transport→daemon helper; orphan block → re-attach proof (incl. chromium survival) | ~+35 |
| `tests/mmin-phase2.test.ts` (198) | `spawnServer` internals; dashboard tests hit the daemon port | ~+5 |
| `tests/leak-cycles.test.ts` (142) | Spawn swap; pid from `Bun.spawn` | ~+5 |
| `tests/http-daemon.test.ts` (new) | (a) disconnect survival, (b) two clients serialize, shared `spawnDaemon` helper | ~+90 |
| `README.md` (140) | "Connecting an MCP client" → remote config snippet; daemon start note; drop stdio wording | ~+12 |
| `docs/server-internals.md` (162) | Env table row `MICKE_PORT`; transport section (stateless HTTP, 405s); signal semantics sans stdin; orphan → re-attach; updated test list | ~+30 |
| `docs/systemd-micke.service` (new) | systemd **user** unit example (`ExecStart=%h/.bun/bin/bun run /path/to/micke/src/main.ts`, `Restart=on-failure`, `WantedBy=default.target`, `Environment=…`), referenced from README | ~+15 |
| `opencode.json` (12) | `micke` → `{"type": "remote", "url": "http://127.0.0.1:7800/mcp"}` | ~0 |

Totals: **src ≈ +55 net** (~130 touched), **tests ≈ +135 net** (~200
touched), **docs/config ≈ +55**. Overall ≈ **+245 net lines** (~370 touched)
against a 1,685-line codebase — a lean delta for three structural pains, and
`shell.ts`/`dockerio.ts` (437 lines, the risky parts) are untouched.

## 9. Risks & unknowns

1. **OpenCode remote-MCP OAuth-by-default.** OpenCode docs: "Remote servers
   use OAuth by default" for `{"type":"remote","url":…}`. Expectation: the
   OAuth dance only starts when a server answers **401**; micke never emits
   401, so `initialize` should just succeed and `opencode mcp list` should
   show `✓ micke connected`. Mitigation if it ever shows `needs
   authentication`: set `"oauth": false` on the server entry (documented V2
   field for exactly this). **Verify after wiring: `opencode mcp add micke
   --url http://127.0.0.1:7800/mcp && opencode mcp list`.** (Also note
   OpenCode's remote `timeout.execution` default is 12 h — comfortably above
   our 120 s shell cap; the SDK `Client`'s own 60 s default request timeout
   applies to raw SDK tests, pre-existing behavior, not a regression.)
2. **Stateless single-use transport** — the sharpest SDK edge found: reusing
   one transport across POSTs throws (§2b). The route pattern (fresh
   transport+Server per POST) is mandatory; the spike validates it,
   including two concurrent POSTs (separate instances can't race each
   other). A code review must reject any "create transport once at startup"
   shortcut.
3. **Port-becomes-fatal.** Today a dashboard bind failure is shrugged off;
   after the merge it kills the daemon. A stale process on 7800 (e.g. an old
   micke dashboard-only process from before an upgrade) now blocks startup —
   mitigated by the structured error naming the port and pid-less hint to
   check `ss -ltnp`. Also: flock-before-bind means a *different-state-dir*
   micke loses on the port, not the lock — error message must say PORT, not
   LOCK, to avoid confusing debugging.
4. **JSON-response HTTP requests stay open for the whole tool call** (up to
   `timeout_ms + 15 s`, `shell.ts:292`). Loopback + no intermediaries → no
   idle timeouts in the path; Bun.serve has no default request timeout.
   Bun's `fetch` (test/OpenCode client side) has none either. If some future
   client's proxy times out at 30/60 s, long shells surface as transport
   errors — acceptable, and identical to what stdio does today on a client
   request timeout.
5. **4 MiB request-body cap** (`maxRequestBodySize`): a `session_shell`
   command string > 4 MiB would 413. Not a real case (commands are one-to-
   few KB); noted so nobody hunts a mystery 413 later.
6. **DNS rebinding** from a browser page to `127.0.0.1:7800`: loopback bind
   stops network exposure but not rebinding; the deprecated SDK options are
   deliberately unused — the 4-line router Origin check (§2d) is the defense.
   If we skip even that (minimalism), the attack surface is "a malicious page
   can drive your local desktop daemon" — real but bounded; recommend
   including the check.
7. **SDK drift.** 1.32.2's stateless/JSON-response behavior is contract-read
   from source, not from a stability guarantee; the class is young (web-
   standard variant is recent). Pin the version in `bun.lock` (already
   exact), and the three test groups (a/b/c) double as SDK-upgrade canaries.
8. **Unknown (small):** whether `leak-cycles`' ±8 fd tolerance holds with
   HTTP sockets in the picture (§7) — expected yes (sequential requests,
   connections close); re-baseline if the run disagrees.

## 10. Out of scope (explicit, trigger-gated per PRD)

- **Auth / TLS** — FR-28; trigger: first request to share beyond localhost.
- **Multi-host / remote bind** — FR-22 cut; localhost ports are the product.
- **Per-client quotas, session ownership/sharing permissions** — no FR; the
  daemon trusts all local clients equally (it's the same trust domain as the
  user's shell). Revisit only if a multi-user-local scenario appears.
- **SSE / server-initiated messages / resumability** — no sender; add only
  when a feature needs server pushes.
- **Auto-restart supervision inside micke** — systemd's job; we document the
  unit, we don't grow a supervisor-watcher.
