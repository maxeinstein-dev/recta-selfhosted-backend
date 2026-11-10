/**
 * The commit the running server was built from, for the health check: lets a deploy be confirmed from outside.
 * Render sets RENDER_GIT_COMMIT on every deploy; GIT_COMMIT covers other hosts. Anything that is not a plain hex
 * hash (unset, empty, a branch name) is reported as null rather than echoed back.
 */
export function buildCommit(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.RENDER_GIT_COMMIT ?? env.GIT_COMMIT ?? '').trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(raw) ? raw.slice(0, 7) : null;
}
