/**
 * /api/internal/agent-run/git/*  — the git push gate for cloud coding runs.
 *
 * INTERNAL-ONLY, called by git inside a coding run's sandbox (its push URL):
 *   GET  /api/internal/agent-run/git/info/refs?service=git-receive-pack
 *   POST /api/internal/agent-run/git/git-receive-pack
 * Auth is the run's push token (HTTP Basic password or Bearer), which the
 * sandbox's firewall injects on Vercel. Everything else, and why this exists,
 * is in src/lib/agent-run/git-push-proxy.ts.
 */
import { handleGitPush } from '@/lib/agent-run/git-push-proxy'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

type Ctx = { params: Promise<{ path?: string[] }> }

export async function GET(request: Request, ctx: Ctx) {
  const { path } = await ctx.params
  return handleGitPush(request, path ?? [])
}

export async function POST(request: Request, ctx: Ctx) {
  const { path } = await ctx.params
  return handleGitPush(request, path ?? [])
}
