import { getServiceClient } from '@/lib/admin'
import { runDecision } from '@/lib/ai/decisions/run-decision'
import type { EmailMessageForAI } from '@/lib/email/email-read-service'
import { hasOnlyNoReplyDestination, isNoReplyAddress, mailboxAddresses } from '@/lib/email/reply-policy'
import { automatedCategory, automatedThreadReason, gmailCategory, isNotificationAddress, type AutomatedReason } from '@/lib/email/automated-sender'
import { ownMailAddresses } from '@/lib/email/own-addresses'
import { knownSenders } from '@/lib/agent-events/known-senders'
import { TRUST_QUESTIONS, type EmailReplyInput, type EmailReplyValue } from '@/lib/ai/decisions/tasks/email-reply'
import { EMAIL_TRUST_ENFORCE, markThreadTrust, trustMarkFor } from './email-trust'

export interface ReplyGateOptions {
  /** Set only by the direct, user-requested single-thread draft route. IDs alone are not intent. */
  explicit?: boolean
  complete?: boolean
}

const REPLY_PREFERENCES = 'Draft only when an email reply from me is expected or required. Do not draft optional acknowledgments to informational or automated messages.'

/**
 * Classification applies only to this revision, never a newly arrived message.
 * Automated mail (src/lib/email/automated-sender.ts) also takes its category,
 * so neither drafting pass nor the agent's inbox picks the thread up again.
 */
async function rememberNoReply(userId: string, workspaceId: string, thread: Record<string, unknown>,
  automated?: AutomatedReason): Promise<void> {
  if (!thread.provider_thread_id || !thread.provider_message_id || !thread.account_id) return
  try {
    const { error } = await getServiceClient().from('email_thread_index')
      .update(automated ? { needs_reply: false, auto_classified: automatedCategory(automated) } : { needs_reply: false })
      .eq('user_id', userId).eq('workspace_id', workspaceId).eq('account_id', thread.account_id)
      .eq('provider_thread_id', thread.provider_thread_id).eq('provider_message_id', thread.provider_message_id)
    if (error) console.warn('[email-reply-gate] Could not persist reply classification')
  } catch { console.warn('[email-reply-gate] Could not persist reply classification') }
}

/**
 * What an automatic pass does with a thread:
 *   'draft'     a reply is needed (Jev's confident yes), or the evidence is
 *               structurally incomplete before any judgement (preserved);
 *   'no_reply'  none is owed: automated or no-reply mail, Jev's confident no,
 *               phishing (remembered for this revision);
 *   'ask'       Jev is unsure, or couldn't answer (an attachment it can't
 *               read, an escalation): no draft; the thread stays "needs a
 *               reply" and the agent asks the person whether to draft one
 *               (docs/plans/email-through-the-agent.md E3, decision 1:
 *               unsure means ask, not draft).
 */
export type ReplyVerdict = 'draft' | 'no_reply' | 'ask'

/** True when an automatic pass writes no draft now (no reply owed, or the person is asked first). */
export async function shouldSkipAutomaticReply(userId: string, workspaceId: string,
  thread: Record<string, unknown>, messages: EmailMessageForAI[] | undefined, options: ReplyGateOptions = {}): Promise<boolean> {
  return (await automaticReplyVerdict(userId, workspaceId, thread, messages, options)) !== 'draft'
}

/** No-reply destinations never reach generation. A reply Jev is unsure of is asked about, not drafted (E3). */
export async function automaticReplyVerdict(userId: string, workspaceId: string,
  thread: Record<string, unknown>, messages: EmailMessageForAI[] | undefined, options: ReplyGateOptions = {}): Promise<ReplyVerdict> {
  const latest = messages?.filter(message => !message.isDraft).at(-1)
  // The index stores From but not Reply-To. Without a read message, an apparent
  // no-reply sender could still route replies to a human; preserve its status.
  if (!latest) return 'draft'
  const currentRevision = !!latest.messageId && latest.messageId === thread.provider_message_id
  // A partially synced old no-reply message is not evidence about the new one.
  // The orchestrator defers stale reads until the indexed revision is available.
  if (thread.provider_message_id && !currentRevision) return 'draft'
  let mailboxRead: Promise<string | null> | undefined
  const mailboxOf = () => (mailboxRead ??= accountMailbox(userId, thread.account_id))
  let ownRead: Promise<Set<string>> | undefined
  const ownOf = () => (ownRead ??= ownMailAddresses(getServiceClient(), userId))
  const senderOf = (m: EmailMessageForAI) => mailboxAddresses(m.from).length === 1 ? mailboxAddresses(m.from)[0] : null
  // The people behind the newest message: its sender, and the human its
  // Reply-To names when a system relays it (a form lead, a ticket comment).
  const replyToHumans = mailboxAddresses(latest.replyTo?.trim() ?? '')
    .filter(address => address !== senderOf(latest) && !isNoReplyAddress(address) && !isNotificationAddress(address))
  let knownRead: Promise<boolean> | undefined
  // Someone the person knows (a CRM contact, or someone they have written to): never on a failed read.
  const knownSender = () => (knownRead ??= (async () => {
    const people = [senderOf(latest), ...replyToHumans].filter((a): a is string => !!a)
    if (!people.length) return false
    const known = await knownSenders(getServiceClient(), { workspaceId, userId, addresses: people })
    return people.some(address => known.has(address))
  })().catch(() => false))
  // The hard pre-filter (Liam, 2026-10-27, GEN-1164): mail no person is
  // waiting on an answer to gets no automatic draft, decided here before any
  // model call. An explicit request keeps the no-reply address check below only.
  if (!options.explicit) {
    // Automated mail (src/lib/email/automated-sender.ts: no-reply, notification,
    // relay or transactional addresses, automated headers, calendar mail). The
    // mailbox is read only when it matters: whether the person has sent in the
    // thread, which the notification and transactional exceptions turn on.
    let automated = automatedThreadReason(messages, null)
    if (automated === 'notification_address' || automated === 'transactional_sender') {
      automated = automatedThreadReason(messages, await mailboxOf())
    }
    if (automated) {
      if (currentRevision) await rememberNoReply(userId, workspaceId, thread, automated)
      return 'no_reply'
    }
  }
  const unknownReplyDestination = (message: EmailMessageForAI) => message.replyToKnown === false ||
    (!!message.replyTo?.trim() && mailboxAddresses(message.replyTo).length === 0)
  // Legacy provider reads may not have captured Reply-To at all. A malformed
  // supplied header is equally inconclusive; neither proves a no-reply target.
  if (unknownReplyDestination(latest)) return 'draft'
  // An old no-reply sender must not suppress a newer human request. Use the
  // actual latest message and its known reply destination.
  if (hasOnlyNoReplyDestination(latest)) {
    if (currentRevision) await rememberNoReply(userId, workspaceId, thread)
    return 'no_reply'
  }
  if (options.explicit) return 'draft'
  // The rest of the hard pre-filter (GEN-1164), still before any model call.
  // Mail the person sent themselves ("Test" to their own address), or from
  // one of their accounts to another: nobody else is in it to answer. Their
  // own message to someone else stays with Jev (a follow-up they promised).
  const own = await ownOf()
  const mailbox = await mailboxOf()
  if (mailbox) own.add(mailbox)
  const sender = senderOf(latest)
  if (sender && own.has(sender)) {
    const recipients = [...mailboxAddresses(latest.to), ...mailboxAddresses(latest.cc || '')]
    if ((mailbox && sender !== mailbox) || (recipients.length > 0 && recipients.every(address => own.has(address)))) {
      if (currentRevision) await rememberNoReply(userId, workspaceId, thread)
      return 'no_reply'
    }
  }
  // Gmail's Promotions and Forums are bulk mail, unless the person has
  // written in the thread (a rep's 1:1 reply Gmail filed as a promotion). Its
  // Updates (receipts, confirmations, notices) gets a draft only from someone
  // the person knows, or where they have written, or when a system relays a
  // human's message (a form lead's Reply-To: only Jev's confident yes drafts
  // it, below).
  const category = gmailCategory(thread.label_ids)
  const conversing = (messages ?? []).some(m => !m.isDraft && own.has(senderOf(m) ?? ''))
  if ((category === 'bulk' && !conversing) ||
    (category === 'updates' && !conversing && !replyToHumans.length && !(await knownSender()))) {
    if (currentRevision) await rememberNoReply(userId, workspaceId, thread, category === 'bulk' ? 'bulk_category' : 'updates_category')
    return 'no_reply'
  }
  const replyEvidenceIncomplete = options.complete === false || !messages?.length ||
      !Number.isInteger(thread.message_count) || messages.length < Number(thread.message_count) ||
      messages.some(m => unknownReplyDestination(m) || m.hasAttachments || m.isDraft || m.bodyComplete === false || !m.bodyText?.trim() || !m.messageId) ||
      !!thread.has_attachments
  // Every call (the reply gate's, email.trust's) is about this exact thread revision.
  if (!messages?.length || !thread.account_id || !thread.provider_thread_id || !currentRevision) return 'draft'
  // A no-reply or notification sender with a real Reply-To (Liam, 2026-10-18:
  // Resy's restaurant, Inngest's hello@, the person who shared a Doc, YC
  // relaying a message all got drafted): mail a machine sent, often on
  // someone's behalf. It is drafted only when Jev is confident a reply is
  // needed (a form lead asking for a quote, a ticket comment); unsure,
  // undecided or unasked means no draft. Once the person has sent in the
  // thread they are conversing through it, and the usual rule applies.
  const noReplySender = async (): Promise<boolean> => {
    const sender = mailboxAddresses(latest.from)
    if (sender.length !== 1 || !(isNoReplyAddress(sender[0]) || isNotificationAddress(sender[0]))) return false
    const own = await mailboxOf()
    // An unknown mailbox counts as "has not sent", which only ever holds more back.
    return !own || !messages.some(m => !m.isDraft && mailboxAddresses(m.from)[0] === own)
  }
  try {
    const own = await mailboxOf()
    if (!own) return 'draft'
    const mailbox = [own]
    // Missing header identity must not become a confident no-reply decision.
    const identityIncomplete = messages.some(m => mailboxAddresses(m.from).length !== 1 ||
      (!mailboxAddresses(m.to).length && !mailboxAddresses(m.cc || '').length))
    const conversation = (list: EmailMessageForAI[]): EmailReplyInput['messages'] => list.map(m => ({
      from: m.from, to: mailboxAddresses(m.to), cc: mailboxAddresses(m.cc || ''),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      direction: mailboxAddresses(m.from).length !== 1 ? 'unknown' as const :
        mailboxAddresses(m.from)[0] === mailbox[0] ? 'outbound' as const : 'inbound' as const,
      date: m.dateISO ?? m.date, subject: m.subject, body: m.bodyText ?? '' }))
    const base = { mailbox: mailbox[0], mailboxId: String(thread.account_id), threadId: String(thread.provider_thread_id),
      revision: String(thread.provider_message_id) }
    // email-reply-v5 weighs who is asking: a stranger's pitch is owed nothing.
    const known = { knownSender: await knownSender() }
    const runId = String(thread.id ?? thread.provider_thread_id)
    // Shadow: the trust answers are recorded and named as not applied.
    const trustCtx = EMAIL_TRUST_ENFORCE ? {} : { shadowQuestions: TRUST_QUESTIONS }

    if (replyEvidenceIncomplete || identityIncomplete) {
      // The reply question needs complete evidence; email.trust does not
      // (attachments are a common phishing vector). A trust-only call over the
      // readable messages, attachment contents unseen.
      const readable = messages.filter(m => !m.isDraft && !!m.bodyText?.trim()).slice(-30)
      if (!readable.length) return 'draft'
      const result = await runDecision('email.reply_required', {
        ...base, complete: false, trustOnly: true, preferences: REPLY_PREFERENCES,
        attachmentsUnseen: !!thread.has_attachments || messages.some(m => m.hasAttachments),
        messages: conversation(readable).map(m => ({ ...m, body: m.body.slice(0, 20000) })),
      }, { userId, workspaceId, runId, mode: EMAIL_TRUST_ENFORCE ? 'enforce' : 'shadow', ...trustCtx })
      if (result.status === 'accepted' && (await applyTrust(userId, thread, result.value, result.inferenceId))) {
        // Phishing needs no reply: this revision is not drafted or checked again.
        await rememberNoReply(userId, workspaceId, thread)
        return 'no_reply'
      }
      // The reply question needs complete evidence, so it was never asked: a
      // no-reply sender gets no draft (not remembered; the next revision is read
      // again); anyone else is asked about, not guessed at (E3).
      return (await noReplySender()) ? 'no_reply' : 'ask'
    }

    const result = await runDecision('email.reply_required', {
      ...base, ...known, complete: true,
      preferences: REPLY_PREFERENCES,
      messages: conversation(messages),
    }, { userId, workspaceId, runId, mode: 'enforce', ...trustCtx })
    // Undecided (an escalation): no draft. A no-reply sender's isn't
    // remembered; anyone else is asked about (E3).
    if (result.status !== 'accepted') return (await noReplySender()) ? 'no_reply' : 'ask'
    // Phishing: no draft, and (like a confident no-reply) this revision is not checked again.
    const phishing = await applyTrust(userId, thread, result.value, result.inferenceId)
    if (!phishing && result.value.replyRequired !== false) {
      // A confident yes drafts. Unsure: a no-reply sender is remembered as no
      // reply (below); anyone else is asked about, the thread left waiting (E3).
      if (result.value.replyRequired === true) return 'draft'
      if (!(await noReplySender())) return 'ask'
    }
    await rememberNoReply(userId, workspaceId, thread)
    return 'no_reply'
  } catch { return 'ask' }
}

/** The thread's mailbox address (connected_account), or null when it can't be told. Never throws. */
async function accountMailbox(userId: string, accountId: unknown): Promise<string | null> {
  if (typeof accountId !== 'string' || !accountId) return null
  try {
    const { data: account, error } = await getServiceClient().from('connected_account').select('account_email')
      .eq('id', accountId).eq('user_id', userId).maybeSingle()
    const mailbox = mailboxAddresses(account?.account_email ?? '')
    return !error && mailbox.length === 1 ? mailbox[0] : null
  } catch { return null }
}

/**
 * Apply an email.trust verdict (src/lib/crm/email-trust.ts). In shadow
 * (EMAIL_TRUST_ENFORCE false): nothing, ever. Enforced: a phishing thread is
 * marked 'suspicious' on every copy and gets no draft (true); an injection
 * thread is marked and drafts as usual, through the no-tools generator; the
 * rest change nothing.
 */
async function applyTrust(userId: string, thread: Record<string, unknown>, value: EmailReplyValue, inferenceId: string | undefined): Promise<boolean> {
  if (!EMAIL_TRUST_ENFORCE) return false
  const mark = trustMarkFor(value.trust)
  if (!mark) return false
  await markThreadTrust(getServiceClient(), {
    userId, accountId: String(thread.account_id), providerThreadId: String(thread.provider_thread_id), trust: mark,
    messageId: thread.provider_message_id ? String(thread.provider_message_id) : null, inferenceId: inferenceId ?? null,
  })
  return mark === 'suspicious'
}
