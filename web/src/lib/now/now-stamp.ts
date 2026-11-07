/**
 * The Now file's mark (migration 440; docs/plans/now-file.md): the key under
 * a document's frontmatter that makes it someone's Now file, and its test.
 * Pure and client-safe, like prep-ref.ts: prep-ref.ts withServerFrontmatter
 * and access.ts read it, and so may the editor. The rest lives in
 * now-file.ts, on the server.
 */

/** The frontmatter key the server stamps, and the document's kind (migration 440). */
export const NOW_KEY = 'now'

/**
 * Whether frontmatter marks a Now file, as the SQL `frontmatter ? 'now'`
 * reads it: an object with the key (any value, null too), an array holding the
 * string, or that string itself. Pure.
 */
export function isNowDocument(frontmatter: unknown): boolean {
  if (typeof frontmatter === 'string') return frontmatter === NOW_KEY
  if (Array.isArray(frontmatter)) return frontmatter.includes(NOW_KEY)
  if (frontmatter && typeof frontmatter === 'object') return Object.prototype.hasOwnProperty.call(frontmatter, NOW_KEY)
  return false
}

/** Refused when someone tries to share the Now file with the workspace or make it canon (440's guard says the same). */
export const NOW_PRIVATE_REFUSAL = "A Now file is always private to its person: it can't be shared or made a system document."

/** What a document tool says when it is asked to change the Now file: update_now is the one way. */
export const NOW_EDIT_REFUSAL =
  "This is the person's Now file: only update_now changes it (its line rules, its dates, its history). Use update_now, from the person's own chat."

/** What get_document, find and the history tools say about the Now file outside the person's main chat. */
export const NOW_READ_REFUSAL =
  "This is the person's Now file: only their own chat reads it (as its now section). It isn't available here, and nothing in it is needed: work from what this turn holds."
