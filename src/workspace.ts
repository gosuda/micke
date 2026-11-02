// workspace — the /workspace permission contract between host and guest.
//
// gvx/rungv bind-mounts a host directory at /workspace with NO uid remapping:
// the guest writes as its own uid (1000 in the image) while the host directory
// is owned by whoever created it (501 on macOS, or the daemon's user). A
// directory left at the default 0755 is therefore readable but not writable in
// the guest, which silently broke the "write artifacts to /workspace" promise.
//
// The decision lives here as a pure function over stat data so it can be tested
// on a macOS host, where chown(1000) is impossible.

export interface StatLike {
  uid: number;
  gid: number;
  /** Full st_mode; only the low 9 permission bits are used. */
  mode: number;
}

/**
 * Can a guest with (guestUid, guestGid) create entries in this directory?
 *
 * Callers pass a directory's stat. Creating a file needs BOTH write and search
 * (x) on the matching permission class; a 0744 directory owned by the guest is
 * writable but not traversable, so it does not count. Supplementary groups are
 * unknowable from stat alone, so only the primary gid is considered — the
 * image creates exactly one group (1000) for the agent user.
 */
export function guestCanWrite(st: StatLike, guestUid: number, guestGid: number): boolean {
  const mode = st.mode & 0o777;
  if (st.uid === guestUid) return (mode & 0o300) === 0o300;
  if (st.gid === guestGid) return (mode & 0o030) === 0o030;
  return (mode & 0o003) === 0o003;
}

/**
 * Guest identity for permission checks. MICKE_GUEST_UID/MICKE_GUEST_GID exist
 * because an image built with different build args would otherwise fail in a
 * confusing way; the shipped image uses 1000:1000.
 */
export function guestIds(env: NodeJS.ProcessEnv = process.env): { uid: number; gid: number } {
  const parse = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
    }
    return n;
  };
  return { uid: parse("MICKE_GUEST_UID", 1000), gid: parse("MICKE_GUEST_GID", 1000) };
}
