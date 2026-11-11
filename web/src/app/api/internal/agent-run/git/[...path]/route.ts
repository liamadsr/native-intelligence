/**
 * /api/internal/agent-run/git/*  — the git gate for cloud coding runs: the
 * only way a run's sandbox reads its repo from GitHub or pushes to it.
 *
 * INTERNAL-ONLY, called by git and git-lfs inside a coding run's sandbox (the
 * gate URL is the clone's remote, its push URL and its `lfs.url` base):
 *   GET  /api/internal/agent-run/git/info/refs?service=git-upload-pack   (read)
 *   POST /api/internal/agent-run/git/git-upload-pack                      (read)
 *   POST /api/internal/agent-run/git/info/lfs/objects/batch               (read; LFS upload batches too)
 *   POST /api/internal/agent-run/git/info/lfs/locks/verify                (read)
 *   GET  /api/internal/agent-run/git/info/refs?service=git-receive-pack  (push)
 *   POST /api/internal/agent-run/git/git-receive-pack                     (push)
 * Auth is the run's git gate token (HTTP Basic password or Bearer), which the
 * hosted sandbox's firewall injects, or git's own config holds on any other
 * sandbox provider. The GitHub token is added server-side: it is not handed to
 * the coding agent, a network policy or the sandbox, and the read gate refuses
 * an LFS answer that contains it. Everything else, and why this exists, is in
 * src/lib/agent-run/git-read-proxy.ts (reads, and the dispatch) and
 * src/lib/agent-run/git-push-proxy.ts (pushes).
 */
import { handleGitGate } from '@/lib/agent-run/git-read-proxy'

export const dynamic = 'force-dynamic'

/**
 * A clone's pack streams from GitHub through this route for as long as GitHub
 * takes to send it, so the route must not be cut at a short, fixed time.
 * `maxDuration` is honoured only on Vercel. Next's own server, which serves
 * production on our server, enforces no duration at all: there the edge
 * proxy's 15-minute timeouts cut only a connection that goes fully silent for
 * that long, not a slow trickle. What bounds reads there is the read gate:
 * at most a few in flight per run (READS_PER_RUN), each request body capped,
 * and the client's abort, which ends the GitHub request too
 * (git-read-proxy.ts). On Vercel 300 s is what the app's longest routes
 * already ask for: room for a clone of a large repo (the sandbox clones
 * `--depth 50`) where 120 s could cut it.
 */
export const maxDuration = 300

type Ctx = { params: Promise<{ path?: string[] }> }

export async function GET(request: Request, ctx: Ctx) {
  const { path } = await ctx.params
  return handleGitGate(request, path ?? [])
}

export async function POST(request: Request, ctx: Ctx) {
  const { path } = await ctx.params
  return handleGitGate(request, path ?? [])
}
