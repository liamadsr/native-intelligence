import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'
import { runAutoArchive } from '@/lib/email/auto-archive'
import { readAgentPausedState, type AgentPausedState } from '@/lib/work/agent-paused'
import { workspaceIsDormant } from './flow-functions'

/**
 * The morning tidy on Inngest (src/lib/email/auto-archive.ts, migration 446).
 * The digest cron (./agent-events.ts agentEventDigest) sends one
 * `email/auto-archive.requested` per person whose 8 o'clock it is, beside
 * their digest; this waits AUTO_ARCHIVE_AFTER_DIGEST so the tidy's message
 * lands after the digest in the home thread, then archives once. The Inngest
 * event id (one per workspace, person and local date) and the batch row's day
 * key each make a retry archive nothing twice.
 *
 * Gates, read after the wait: the Autonomy switch (FAILS CLOSED: a switch
 * that can't be read is off, as the digest's does, since the tidy acts in the
 * person's mailbox on its own) and a dormant workspace. No home thread is the
 * pass's own skip (nowhere to put the Undo).
 */

export const EMAIL_AUTO_ARCHIVE_EVENT = 'email/auto-archive.requested' as const
/** How long after the digest's request the tidy runs. */
export const AUTO_ARCHIVE_AFTER_DIGEST = '5m'

export interface EmailAutoArchiveRequestedData {
  workspaceId: string
  userId: string
  /** The person's local date (the digest's key). */
  date: string
}

/** The request the digest cron sends for one person. Pure. */
export function autoArchiveRequest(c: EmailAutoArchiveRequestedData): { id: string; name: typeof EMAIL_AUTO_ARCHIVE_EVENT; data: EmailAutoArchiveRequestedData } {
  return {
    id: `email-auto-archive:${c.workspaceId}:${c.userId}:${c.date}`,
    name: EMAIL_AUTO_ARCHIVE_EVENT,
    data: { workspaceId: c.workspaceId, userId: c.userId, date: c.date },
  }
}

export const emailAutoArchive = inngest.createFunction(
  {
    id: 'email-auto-archive',
    retries: 2,
    // One pass per person at a time (one mailbox), and a few at once overall (provider rate limits).
    // The overall limit stays <= the Inngest plan's 5, or the whole app sync is refused.
    concurrency: [{ key: 'event.data.userId', limit: 1 }, { limit: 5 }],
    triggers: [{ event: EMAIL_AUTO_ARCHIVE_EVENT }],
  },
  async ({ event, step }) => {
    const data = event.data as Partial<EmailAutoArchiveRequestedData>
    if (!data?.workspaceId || !data.userId || !data.date || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(data.date)) {
      return { status: 'skipped', reason: 'bad_event' }
    }
    const scope = { workspaceId: data.workspaceId, userId: data.userId, date: data.date }

    await step.sleep('after-digest', AUTO_ARCHIVE_AFTER_DIGEST)

    const gate = await step.run('gate', async () => {
      const supabase = getServiceClient()
      const state = await readAgentPausedState(supabase, scope.workspaceId).catch((): AgentPausedState => 'unknown')
      if (state !== 'active') return 'paused' as const
      if (await workspaceIsDormant(supabase, scope.workspaceId).catch(() => false)) return 'dormant' as const
      return 'open' as const
    })
    if (gate !== 'open') return { status: 'skipped', reason: gate }

    const result = await step.run('archive', () => runAutoArchive(getServiceClient(), scope))
    console.info(
      `[auto-archive] workspace=${scope.workspaceId} user=${scope.userId} date=${scope.date} status=${result.status}` +
        (result.status === 'archived' ? ` archived=${result.archived} failed=${result.failed}` : ''),
    )
    return result
  },
)
