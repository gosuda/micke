// dockerio — thin `docker` CLI wrapper.
//
// micke shells out to the `docker` binary (no Docker SDK): every command here
// is captured (stdout/stderr/exit code) and the small, stable textual outputs
// we rely on are parsed. Nothing streams except the shell channel (shell.ts).

export interface DockerResult {
  rc: number;
  stdout: string;
  stderr: string;
}

export async function docker(args: string[], timeoutMs?: number): Promise<DockerResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs) timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const rc = await proc.exited;
  if (timer) clearTimeout(timer);
  return { rc, stdout, stderr };
}

/** Is the docker daemon reachable? */
export async function dockerAvailable(): Promise<boolean> {
  const r = await docker(["version", "--format", "{{.Server.Version}}"], 10_000);
  return r.rc === 0;
}

/** Does the image exist locally? (docker image inspect) */
export async function imageExists(ref: string): Promise<boolean> {
  const r = await docker(["image", "inspect", ref], 15_000);
  return r.rc === 0;
}

export async function pullImage(ref: string): Promise<DockerResult> {
  // Pulls can be hundreds of MB; generous ceiling, caller handles failure.
  return docker(["pull", ref], 15 * 60_000);
}

/** Host port docker allocated for `containerPort` on a running container. */
export async function hostPort(container: string, containerPort: number): Promise<number | null> {
  const r = await docker(["port", container, `${containerPort}/tcp`], 10_000);
  if (r.rc !== 0) return null;
  const m = r.stdout.match(/:(\d+)/); // e.g. "127.0.0.1:32768"
  return m ? parseInt(m[1], 10) : null;
}

export interface LabeledContainer {
  containerId: string;
  sessionId: string;
  running: boolean;
}

/** All containers carrying the micke.session label (any state). */
export async function listLabeledContainers(): Promise<LabeledContainer[]> {
  const r = await docker(
    [
      "ps", "-a",
      "--filter", "label=micke.session",
      "--format", "{{.ID}}\t{{.Label \"micke.session\"}}\t{{.State}}",
    ],
    15_000,
  );
  if (r.rc !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [containerId, sessionId, state] = l.split("\t");
      return { containerId, sessionId, running: state === "running" };
    })
    .filter((c) => c.containerId && c.sessionId);
}

export async function removeContainer(containerIdOrName: string): Promise<DockerResult> {
  return docker(["rm", "-f", containerIdOrName], 30_000);
}

/** Container logs so far (no -f; callers poll). */
export async function containerLogs(container: string): Promise<string> {
  const r = await docker(["logs", container], 10_000);
  return r.rc === 0 ? r.stdout + r.stderr : "";
}

export async function containerRunning(container: string): Promise<boolean> {
  const r = await docker(["inspect", "-f", "{{.State.Running}}", container], 10_000);
  return r.rc === 0 && r.stdout.trim() === "true";
}
