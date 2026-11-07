/**
 * A tool input's validation failure as the model (and the person, in the
 * tool's error chip) reads it: one `field: message` per issue, joined by "; ".
 *
 * The internal tool routes (chat, work-run, skill-run, live-agent) send it as
 * INPUT_INVALID's `details`. They used to send String(zodError), zod's issue
 * list as pretty-printed JSON, which for a uuid field carries zod's whole
 * pattern regex: a dozen lines to say "bot_id: must be a uuid" (PROD,
 * 2026-10-08). The field and the message are all a model needs to fix its call.
 *
 * Anything that is not a zod error (no `issues` list) falls back to its string.
 */
export function toolInputIssues(error: unknown): string {
  const issues = (error as { issues?: unknown } | null)?.issues
  if (!Array.isArray(issues) || issues.length === 0) return String(error)
  return issues
    .map((issue: { path?: unknown; message?: unknown }) => {
      const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.map(String).join('.') : 'input'
      return `${path}: ${typeof issue.message === 'string' ? issue.message : 'invalid'}`
    })
    .join('; ')
}
