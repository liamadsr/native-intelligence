/**
 * POST /api/account/email/threads/triage { thread_ids, change } — one inbox
 * triage change on the caller's own threads (src/lib/email/thread-triage.ts):
 * the chat's Undo under an update_email_thread result runs each of its
 * `undo` calls through here (components/email/email-triage-chip.tsx).
 *
 *   change: { archive?, read?, star?, add_labels?, remove_labels?, mute? },
 *     as update_email_thread takes them.
 *   → 200 { changed, threads: [{ thread_id, status, error? }] }: what changed
 *     (an already-undone thread is 'unchanged', so a retry is safe).
 *   → 400 a bad body, an empty change, or a flag's own name as a label.
 *
 * The person's own click is their yes: no ten-thread confirmation here. Each
 * thread is changed in its own mailbox among the ones this workspace may read.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { changeEmailThreads, RESERVED_LABEL_NAMES, type ThreadChange } from '@/lib/email/thread-triage'

export const dynamic = 'force-dynamic'

const labels = z.array(z.string().trim().min(1).max(100)).max(10)
const BodySchema = z.object({
  thread_ids: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  change: z
    .object({
      archive: z.boolean().optional(),
      read: z.boolean().optional(),
      star: z.boolean().optional(),
      add_labels: labels.optional(),
      remove_labels: labels.optional(),
      mute: z.boolean().optional(),
    })
    .strict(),
})

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  const parsed = BodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body')
  const { thread_ids, change: raw } = parsed.data

  const change: ThreadChange = {
    ...(raw.archive !== undefined ? { archive: raw.archive } : {}),
    ...(raw.read !== undefined ? { read: raw.read } : {}),
    ...(raw.star !== undefined ? { star: raw.star } : {}),
    ...(raw.add_labels?.length ? { addLabels: raw.add_labels } : {}),
    ...(raw.remove_labels?.length ? { removeLabels: raw.remove_labels } : {}),
    ...(raw.mute !== undefined ? { mute: raw.mute } : {}),
  }
  if (Object.keys(change).length === 0) return badRequest('Nothing to change')
  if (change.mute === true && change.archive === false) return badRequest('Muting archives the thread')
  if ([...(change.addLabels ?? []), ...(change.removeLabels ?? [])].some((l) => RESERVED_LABEL_NAMES.has(l.toLowerCase()))) {
    return badRequest('Use archive, read or star, not a label')
  }

  const outcomes = await changeEmailThreads(user.id, workspaceId, thread_ids, change)
  return NextResponse.json({
    changed: outcomes.filter((o) => o.status === 'changed').length,
    threads: outcomes.map((o) => ({ thread_id: o.threadId, status: o.status, ...(o.error ? { error: o.error } : {}) })),
  })
}
