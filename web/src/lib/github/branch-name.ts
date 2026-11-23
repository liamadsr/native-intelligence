/**
 * The branch name ⇧⌘B copies for an action (docs/plans/github-reviews.md,
 * phase 2): its identifier, lower case, then its title as a slug, at most 60
 * characters, cut on a word: `eng-42-fix-the-login-redirect`. The webhook
 * finds the identifier in it again (pr-automation.ts identifiersInBranch),
 * so a branch made from it links and moves the action. Pure.
 */
export const BRANCH_NAME_MAX = 60

export function branchNameFor(identifier: string, title: string | null | undefined): string {
  const id = identifier.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
  const slug = (title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) return id
  let out = `${id}-${slug}`
  if (out.length > BRANCH_NAME_MAX) {
    out = out.slice(0, BRANCH_NAME_MAX)
    const cut = out.lastIndexOf('-')
    if (cut > id.length) out = out.slice(0, cut)
  }
  return out.replace(/-+$/g, '')
}
