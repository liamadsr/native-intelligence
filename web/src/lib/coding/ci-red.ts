/**
 * A pull request link Native Intelligence itself may print (P10 F7's "CI is still red"
 * message in the home thread, ci-fix.ts): only a github.com pull request
 * URL; anything else reads as none. Pure, client-safe.
 */
const PR_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/

export function githubPrUrl(value: unknown): string | null {
  const url = typeof value === 'string' ? value.trim() : ''
  return PR_URL_RE.test(url) ? url : null
}
