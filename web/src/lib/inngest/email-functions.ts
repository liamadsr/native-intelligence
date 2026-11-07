import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidToken, getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { fetchGmailHistory, fetchGmailProfile } from '@/lib/email/gmail-api'
import { fetchOutlookDelta, getOutlookDeltaLink } from '@/lib/email/outlook-api'
import { indexRecentThreads } from '@/lib/crm/email-sync'
import { setupGmailWatch } from '@/lib/email/gmail-watch'
import { setupOutlookSubscription } from '@/lib/email/outlook-webhook'
import { finishEmailImport, openEmailImport } from '@/lib/work/import-mirror'
import { MAX_ARRIVAL_THREADS, triageArrivals, understandableThreads } from '@/lib/email/triage'
import { understandArrivals } from '@/lib/email/understand-arrivals'
import { arrivalGate, dailyCapCheck, draftRepliesToNewMail, recordArrivalDrafts, unsureReasons } from '@/lib/email/arrival-drafts'
import { refreshHeldThreads } from '@/lib/email/held-refresh'
import { recordDraftPassEvents } from '@/lib/agent-events/email'
import { expireHolds } from '@/lib/email/hold'
import { expireAutomaticDrafts } from '@/lib/email/draft-expiry'

/**
 * The mail pipeline. NO STORED MAIL (2026-10-15): nothing here writes a
 * message, a body or a subject to the database. A push says what changed; the
 * index (email_thread_index) is rewritten from each touched thread's metadata
 * (ids, flags, addresses); drafting reads the bodies it needs live, in
 * memory; a thread drafted a reply to is held (src/lib/email/hold.ts) until
 * the person sends or dismisses the draft. Step return values are kept by
 * Inngest, so every step returns ids and counts only.
 */

// =====================================================================
// Helper: a valid access token (and the mailbox's own address) for an
// account or legacy user+provider
// =====================================================================

async function getMailbox(
  userId: string,
  provider: 'google' | 'microsoft',
  accountId?: string,
): Promise<{ token: string; email: string | null }> {
  if (accountId) {
    const result = await getValidTokenForAccount(accountId)
    if (!result) throw new Error(`No ${provider} email token for account ${accountId}`)
    return { token: result.token, email: result.email ?? null }
  }
  const result = await getValidToken(userId, provider, 'email')
  if (!result) throw new Error(`No ${provider} email token for user ${userId}`)
  return { token: result.token, email: result.email ?? null }
}

async function getToken(
  userId: string,
  provider: 'google' | 'microsoft',
  accountId?: string,
): Promise<string> {
  return (await getMailbox(userId, provider, accountId)).token
}

// =====================================================================
// Function 1: Initial Import — index the last 30 days (metadata only)
// =====================================================================

export const emailInitialImport = inngest.createFunction(
  {
    id: 'email-initial-import',
    retries: 3,
    concurrency: [{ limit: 5 }],
    triggers: [{ event: 'email/initial-import' }],
  },
  async ({ event, step }) => {
    const { userId, workspaceId, provider, accountId } = event.data as {
      userId: string
      workspaceId: string
      provider: 'google' | 'microsoft'
      accountId?: string
    }
    const supabase = getServiceClient()

    // Step 1: Update sync state to "importing_recent"
    const startedAt = await step.run('update-sync-state-start', async () => {
      const at = new Date().toISOString()
      const syncData = {
        user_id: userId,
        workspace_id: workspaceId,
        provider,
        account_id: accountId || null,
        initial_import_status: 'importing_recent',
        initial_import_started_at: at,
      }

      // Check if a sync state row already exists
      const matchFilter = accountId
        ? { account_id: accountId }
        : { user_id: userId, provider }
      const { data: existing } = await supabase
        .from('email_sync_state')
        .select('id')
        .match(matchFilter)
        .maybeSingle()

      if (existing) {
        const { error } = await supabase
          .from('email_sync_state')
          .update(syncData)
          .eq('id', existing.id)
        if (error) throw new Error(`Failed to update sync state: ${error.message}`)
      } else {
        const { error } = await supabase
          .from('email_sync_state')
          .insert(syncData)
        if (error) throw new Error(`Failed to insert sync state: ${error.message}`)
      }
      return at
    })

    // The run's Activity row (src/lib/work/import-mirror.ts): opened here,
    // settled once the recent mail is indexed and the webhook is set up.
    const ledger = { workspaceId, userId, provider, accountId: accountId ?? null }
    await step.run('ledger-open', () => openEmailImport(supabase, ledger, startedAt))

    // Step 2: Snapshot the incremental checkpoint BEFORE indexing, so the
    // first incremental sync picks up mail that arrives during the import.
    // Gmail snapshots historyId; Outlook the inbox delta link.
    const checkpoint = await step.run('snapshot-sync-checkpoint', async () => {
      const accessToken = await getToken(userId, provider, accountId)
      if (provider === 'google') {
        const profile = await fetchGmailProfile(accessToken)
        return { gmailHistoryId: profile.historyId, msDeltaLink: null as string | null }
      }
      const deltaLink = await getOutlookDeltaLink(accessToken)
      return { gmailHistoryId: null, msDeltaLink: deltaLink ?? null }
    })

    // Step 3: Index the last 30 days of threads from their metadata (ids,
    // flags, addresses). No message is fetched in full and none is stored:
    // older and fuller reads go to the provider live.
    const recentResult = await step.run('index-recent-threads', async () => {
      const mailbox = await getMailbox(userId, provider, accountId)
      const { synced } = await indexRecentThreads({
        accessToken: mailbox.token,
        userEmail: mailbox.email,
        userId,
        workspaceId,
        provider,
        accountId,
      })
      return { count: synced }
    })

    // Step 4: Save the BEFORE-snapshot checkpoint and mark the import complete.
    await step.run('save-sync-checkpoint', async () => {
      const syncFilter = accountId
        ? { account_id: accountId }
        : { user_id: userId, provider }
      const now = new Date().toISOString()
      const done = {
        last_sync_at: now,
        total_messages_synced: recentResult.count,
        initial_import_status: 'complete',
        initial_import_completed_at: now,
      }

      if (provider === 'google') {
        await supabase
          .from('email_sync_state')
          .update({ gmail_history_id: checkpoint.gmailHistoryId, ...done })
          .match(syncFilter)
      } else {
        // The BEFORE-index delta link (mirrors Gmail's historyId ordering);
        // a fresh one only if the snapshot failed.
        const deltaLink = checkpoint.msDeltaLink ?? (await getOutlookDeltaLink(await getToken(userId, provider, accountId))) ?? null
        await supabase
          .from('email_sync_state')
          .update({ ms_delta_link: deltaLink, ...done })
          .match(syncFilter)
      }
    })

    // Step 5: Set up real-time webhook
    await step.run('setup-webhook', async () => {
      try {
        const accessToken = await getToken(userId, provider, accountId)
        if (provider === 'google') {
          await setupGmailWatch(accessToken, userId, accountId)
        } else {
          await setupOutlookSubscription(accessToken, userId, accountId)
        }
      } catch (err) {
        // Non-critical — webhook setup failure shouldn't block import
        console.error('Webhook setup failed:', err)
      }
    })

    // Step 6: Settle the run's Activity row
    await step.run('ledger-finish', () => finishEmailImport(supabase, ledger, recentResult.count))

    return { imported: recentResult.count }
  },
)

// =====================================================================
// Function 2: Incremental Sync — Triggered by webhook or manual sync
// =====================================================================

export const emailIncrementalSync = inngest.createFunction(
  {
    id: 'email-incremental-sync',
    retries: 3,
    debounce: { key: 'has(event.data.accountId) ? event.data.accountId : event.data.userId', period: '10s' },
    concurrency: [{ limit: 5 }],
    triggers: [{ event: 'email/incremental-sync' }],
  },
  async ({ event, step }) => {
    const { userId, workspaceId, provider, accountId } = event.data as {
      userId: string
      workspaceId: string
      provider: 'google' | 'microsoft'
      accountId?: string
    }
    const supabase = getServiceClient()
    const syncFilter = accountId
      ? { account_id: accountId }
      : { user_id: userId, provider }

    // Which threads changed since the checkpoint: ids only, nothing fetched in full.
    const result = await step.run('read-changes', async () => {
      const accessToken = await getToken(userId, provider, accountId)

      const { data: syncState } = await supabase
        .from('email_sync_state')
        .select('*')
        .match(syncFilter)
        .single()

      if (!syncState) {
        throw new Error('No sync state found — run initial import first')
      }

      const affectedThreadIds = new Set<string>()

      if (provider === 'google') {
        if (!syncState.gmail_history_id) {
          throw new Error('No Gmail historyId')
        }

        let history: { history: Array<Record<string, unknown>>; historyId: string }
        try {
          history = await fetchGmailHistory(accessToken, syncState.gmail_history_id)
        } catch (err) {
          if (err instanceof Error && err.message === 'HISTORY_EXPIRED') {
            // historyId too old: take a fresh checkpoint and re-index the last
            // 30 days (below), rather than replay what was missed.
            const profile = await fetchGmailProfile(accessToken)
            await supabase
              .from('email_sync_state')
              .update({
                gmail_history_id: profile.historyId,
                last_sync_at: new Date().toISOString(),
                last_sync_error: null,
              })
              .match(syncFilter)
            return { changed: 0, affectedThreadIds: [] as string[], fullRebuild: true }
          }
          throw err
        }

        // Every thread a message was added to, relabelled in, or deleted from.
        for (const record of history.history || []) {
          for (const key of ['messagesAdded', 'labelsAdded', 'labelsRemoved', 'messagesDeleted']) {
            for (const item of (record[key] as Array<{ message?: { threadId?: string } }> | undefined) ?? []) {
              if (item.message?.threadId) affectedThreadIds.add(item.message.threadId)
            }
          }
        }

        await supabase
          .from('email_sync_state')
          .update({
            gmail_history_id: history.historyId,
            last_sync_at: new Date().toISOString(),
            last_sync_messages_added: affectedThreadIds.size,
            last_sync_messages_modified: 0,
            last_sync_error: null,
          })
          .match(syncFilter)
      } else if (provider === 'microsoft') {
        if (!syncState.ms_delta_link) {
          throw new Error('No Microsoft delta link')
        }

        const delta = await fetchOutlookDelta(accessToken, syncState.ms_delta_link)
        // A conversation is Outlook's thread: index the ones this delta touched.
        // (A removed message names no conversation: its thread is read again
        // the next time it is touched, or by the Sync button.)
        for (const msg of delta.messages) {
          if (msg.conversationId) affectedThreadIds.add(msg.conversationId)
        }

        await supabase
          .from('email_sync_state')
          .update({
            ms_delta_link: delta.nextDeltaLink,
            last_sync_at: new Date().toISOString(),
            last_sync_messages_added: affectedThreadIds.size,
            last_sync_error: null,
          })
          .match(syncFilter)
      }

      return { changed: affectedThreadIds.size, affectedThreadIds: [...affectedThreadIds], fullRebuild: false }
    })

    // Index the touched threads from their metadata (the one writer of their
    // rows) and triage the ones with a new newest message
    // (src/lib/email/triage.ts): draftable ones go to drafting, held ones to
    // the hold refresh. A full rebuild re-indexes the last 30 days instead.
    // The checkpoint already moved past every one of these threads, so all of
    // them are indexed: MAX_ARRIVAL_THREADS a step (each its own invocation),
    // as many steps as a flood needs. Cost follows the mail that arrived,
    // never the mailbox's size.
    let triaged = { draftable: [] as string[], understandable: [] as string[], held: [] as string[], mailboxEmail: null as string | null }
    if (result.fullRebuild) {
      await step.run('index-recent-threads', async () => {
        const mailbox = await getMailbox(userId, provider, accountId)
        await indexRecentThreads({ accessToken: mailbox.token, userEmail: mailbox.email, userId, workspaceId, provider, accountId })
      })
    } else if (result.affectedThreadIds.length) {
      for (let start = 0, chunk = 0; start < result.affectedThreadIds.length; start += MAX_ARRIVAL_THREADS, chunk += 1) {
        const threadIds = result.affectedThreadIds.slice(start, start + MAX_ARRIVAL_THREADS)
        const part = await step.run(chunk === 0 ? 'index-and-triage' : `index-and-triage-${chunk}`, async () => {
          const mailbox = await getMailbox(userId, provider, accountId)
          const out = await triageArrivals(supabase, {
            userId,
            provider,
            accountId: accountId ?? null,
            workspaceId,
            threadIds,
            accessToken: mailbox.token,
            mailboxEmail: mailbox.email,
          })
          return { draftable: out.draftable, understandable: out.understandable ?? [], held: out.held, mailboxEmail: mailbox.email }
        })
        triaged = {
          draftable: [...new Set([...triaged.draftable, ...part.draftable])],
          understandable: [...new Set([...triaged.understandable, ...(part.understandable ?? [])])],
          held: [...new Set([...triaged.held, ...part.held])],
          mailboxEmail: part.mailboxEmail ?? triaged.mailboxEmail,
        }
      }
    }

    if (triaged.draftable.length || triaged.held.length) {
      await step.sendEvent('draft-replies', {
        name: 'email/draft-replies',
        data: {
          userId,
          workspaceId,
          threadIds: triaged.draftable,
          heldThreadIds: triaged.held,
          provider,
          accountId: accountId ?? null,
          mailboxEmail: triaged.mailboxEmail,
        },
      })
    }

    // Everything else new (a notice, a receipt, an invitation, an alert) is
    // understood and told to the agent (docs/plans/email-through-the-agent.md E2).
    if (triaged.understandable.length) {
      await step.sendEvent('understand-arrivals', {
        name: 'email/understand-arrivals',
        data: {
          userId,
          workspaceId,
          threadIds: triaged.understandable,
          provider,
          accountId: accountId ?? null,
          mailboxEmail: triaged.mailboxEmail,
        },
      })
    }

    return { changed: result.changed, drafting: triaged.draftable.length, understanding: triaged.understandable.length, held: triaged.held.length }
  },
)

// =====================================================================
// Function 2b: Understand arriving mail for the agent (E2)
// =====================================================================

/**
 * Every new thread drafting doesn't take, read live and put to Jev's
 * email.understand, lands in the agent's inbox as one `email.arrived` event
 * (src/lib/email/understand-arrivals.ts). One pass at a time per person;
 * gates and caps as drafting's.
 */
export const emailUnderstandArrivals = inngest.createFunction(
  {
    id: 'email-understand-arrivals',
    retries: 1,
    concurrency: [{ key: 'event.data.userId', limit: 1 }],
    triggers: [{ event: 'email/understand-arrivals' }],
  },
  async ({ event, step }) => {
    const { userId, workspaceId, threadIds, provider, accountId, mailboxEmail } = event.data as {
      userId: string
      workspaceId: string
      threadIds: string[]
      provider: 'google' | 'microsoft'
      accountId?: string | null
      mailboxEmail?: string | null
    }
    return step.run('understand', () =>
      understandArrivals(getServiceClient(), {
        userId,
        workspaceId,
        accountId: accountId ?? null,
        provider,
        threadIds: threadIds ?? [],
        mailboxEmail: mailboxEmail ?? null,
      }),
    )
  },
)

// =====================================================================
// Function 3: Process Webhook Notification
// =====================================================================

export const emailProcessWebhook = inngest.createFunction(
  {
    id: 'email-process-webhook',
    retries: 2,
    triggers: [{ event: 'email/webhook-received' }],
  },
  async ({ event, step }) => {
    const { userId, workspaceId, provider, accountId } = event.data as {
      userId: string
      workspaceId: string
      provider: 'google' | 'microsoft'
      accountId?: string
    }

    // Webhook just tells us something changed — trigger incremental sync
    await step.sendEvent('trigger-sync', {
      name: 'email/incremental-sync',
      data: { userId, workspaceId, provider, accountId },
    })
  },
)

// =====================================================================
// Function 4: Draft replies to new mail (on arrival), and refresh holds
// =====================================================================

export const emailDraftReplies = inngest.createFunction(
  {
    id: 'email-draft-replies',
    retries: 1,
    // One pass per person at a time, so two pushes about one thread can't
    // both draft it (generateEmailDrafts skips a thread with an open draft,
    // and re-checks just before its insert in case the safety net drafted it).
    concurrency: [{ key: 'event.data.userId', limit: 1 }],
    triggers: [{ event: 'email/draft-replies' }],
  },
  async ({ event, step }) => {
    const { userId, workspaceId, threadIds, heldThreadIds, provider, accountId, mailboxEmail } = event.data as {
      userId: string
      workspaceId: string
      threadIds: string[]
      heldThreadIds?: string[]
      provider?: 'google' | 'microsoft'
      accountId?: string | null
      mailboxEmail?: string | null
    }
    const supabase = getServiceClient()

    // A new message on a held thread: re-draft an untouched draft, mark an
    // edited one stale, release a hold whose thread is gone or answered
    // (src/lib/email/held-refresh.ts). Re-drafts pass the same gates.
    const refreshed = heldThreadIds?.length && provider
      ? await step.run('refresh-holds', async () => {
          const gate = await arrivalGate(supabase, userId, workspaceId)
          return refreshHeldThreads(supabase, {
            userId,
            workspaceId,
            accountId: accountId ?? null,
            provider,
            providerThreadIds: heldThreadIds,
            mailboxEmail: mailboxEmail ?? null,
            mayDraft: gate.blocked === null,
            allowAnother: dailyCapCheck(supabase, userId, workspaceId),
          })
        })
      : null

    // The gates (kill switch, failing closed; dormancy; usage) and the shared
    // daily cap live in draftRepliesToNewMail (src/lib/email/arrival-drafts.ts).
    const result = await step.run('draft-replies', () =>
      draftRepliesToNewMail(supabase, userId, workspaceId, threadIds ?? []),
    )
    const drafts = [...result.drafts, ...(refreshed?.redrafted ?? [])]

    if (drafts.length) {
      await step.run('record-activity', () =>
        recordArrivalDrafts(supabase, { userId, workspaceId, runKey: `email-arrival-drafts:${event.id}`, drafts }),
      )
    }

    // The agent's inbox (A6): each draft, and each of these threads still
    // waiting on a reply with no draft (why: the gate that refused, 'cap', or
    // 'not_drafted'), in the cron's shape. Deduped per draft and per thread
    // revision, so a retry or the safety net reporting the same thread lands
    // no second row. Never throws.
    const events = await step.run('record-agent-events', () =>
      recordDraftPassEvents(supabase, {
        userId,
        workspaceId,
        drafts,
        providerThreadIds: threadIds ?? [],
        ...(result.blocked ? { reason: result.blocked } : {}),
        // E3: a thread the gate was unsure of waits as 'unsure': the agent asks the person first.
        ...(unsureReasons(result.asked) ? { reasons: unsureReasons(result.asked) } : {}),
      }),
    )

    // Turned away by the reply gate (GEN-1164): understood and told to the
    // agent as triage's other arrivals are (E2), so mail that needs an action
    // rather than a reply still reaches it. Not a newsletter, a draft or the
    // person's own message, as triage hands over.
    const turnedAway = result.turnedAway?.length && provider
      ? await step.run('turned-away', () => understandableThreads(supabase, { userId, workspaceId, threadIds: result.turnedAway ?? [], mailboxEmail: mailboxEmail ?? null }))
      : []
    if (turnedAway.length && provider) {
      await step.sendEvent('understand-turned-away', {
        name: 'email/understand-arrivals',
        data: { userId, workspaceId, threadIds: turnedAway, provider, accountId: accountId ?? null, mailboxEmail: mailboxEmail ?? null },
      })
    }

    return {
      drafted: drafts.length,
      blocked: result.blocked,
      events,
      ...(turnedAway.length ? { understanding: turnedAway.length } : {}),
      ...(refreshed ? { staled: refreshed.staled, released: refreshed.released } : {}),
    }
  },
)

// =====================================================================
// Function 5: Hold expiry (the holding pattern, src/lib/email/hold.ts)
// =====================================================================

/**
 * Hourly: deletes holds left untouched 14 days (their drafts with them; the
 * provider draft stays in the mailbox, it is the person's), holds stuck
 * 'sending' for over an hour, and settled ('sent', 'dismissed') draft rows
 * left behind. The person's own pending drafts (no hold) are never swept.
 * Flat cost: a few deletes, whatever the mailbox size. Then untouched
 * automatic drafts a week old, or about a day that has passed, are dismissed
 * (src/lib/email/draft-expiry.ts, GEN-1164): at most 50 a run.
 */
export const emailHoldExpiry = inngest.createFunction(
  {
    id: 'email-hold-expiry',
    retries: 1,
    triggers: [{ cron: '23 * * * *' }],
  },
  async ({ step }) => {
    const holds = await step.run('expire-holds', () => expireHolds(getServiceClient()))
    const drafts = await step.run('expire-automatic-drafts', () => expireAutomaticDrafts(getServiceClient()))
    return { holds, drafts }
  },
)
