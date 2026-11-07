/**
 * This folder in the main checkout. A worktree has no env files or `.vercel` link of
 * its own, so dev scripts read the main checkout's. In the one-repo layout that's
 * `web/` inside it. Run from the folder the script expects (the repo root).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()

export function mainCheckout(): string {
  return join(git('rev-parse', '--path-format=absolute', '--git-common-dir'), '..', git('rev-parse', '--show-prefix'))
}

/**
 * The Vercel team for `vercel sandbox`: SCOPE, or the one the main checkout is linked to.
 * `vercel link` writes it to .vercel/project.json, `vercel link --repo` to .vercel/repo.json.
 */
export function vercelTeam(project: string): string | undefined {
  if (process.env.SCOPE) return process.env.SCOPE
  const read = (file: string) => {
    try { return JSON.parse(readFileSync(join(mainCheckout(), '.vercel', file), 'utf8')) } catch { return {} }
  }
  const linked: { name?: string; orgId?: string }[] = read('repo.json').projects ?? []
  return read('project.json').orgId ?? (linked.find((p) => p.name === project) ?? linked[0])?.orgId
}
