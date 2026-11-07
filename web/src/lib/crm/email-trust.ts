/**
 * email.trust (always-on-agent §6b, A5 slice 1): Jev's phishing and injection
 * questions on the reply gate's call (email-reply-v4), and where an enforced
 * verdict lands.
 *
 * ENFORCED since 2026-10-16 (Liam: let Jev decide where it is proven). The
 * labelled evals: 43 synthetic cases, 37 right, 6 uncertain (which change
 * nothing), none wrong, no genuine mail flagged; 12 of 13 phishing and
 * injection cases caught. In PROD shadow, 29 real threads, none flagged (the
 * highest phishing answer 0.47, injection 0.28). A verdict only acts at
 * TRUST_FLAG_MIN (0.9); EMAIL_TRUST_ENFORCE false returns it to shadow
 * (answers recorded with `shadow_questions` naming them, nothing applied):
 *   - phishing:  no draft, and the thread is marked 'suspicious' (Mail shows
 *                a "Suspicious" chip);
 *   - injection: the thread is marked 'injection'; drafting continues only
 *                through the no-tools utility generator (already the only
 *                drafting path, crm/email-drafts.ts generateSingleDraft);
 *   - uncertain or safe: today's path.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EmailTrust } from '@/lib/ai/decisions/tasks/email-reply'
import { recordAgentEvents } from '@/lib/agent-events/record'
import { agentEventKey } from '@/lib/agent-events/types'

/** email.trust applies its verdicts. False: shadow (record the answers, apply nothing). */
export const EMAIL_TRUST_ENFORCE = true

/** What email_thread_index.trust holds (migration 334). */
export type ThreadTrustMark = 'suspicious' | 'injection'

/** The mark an enforced verdict writes, or null for one that writes nothing. */
export function trustMarkFor(trust: EmailTrust): ThreadTrustMark | null {
  return trust === 'phishing' ? 'suspicious' : trust === 'injection' ? 'injection' : null
}

/**
 * Mark one thread on EVERY workspace copy of it (a thread index keeps one
 * copy per linked workspace, migration 301): keyed on the owner, the account
 * and the provider thread, never the workspace. `messageId` is the revision
 * the verdict is about, so a newer message can be checked again. Called only
 * when enforcing. Never throws; false when the write failed.
 *
 * A 'suspicious' mark also lands one `email.suspicious` row in the owner's
 * agent inbox per workspace copy (A6; quiet: "while you were away" and the
 * digest say it), keyed on the account, thread and message, with the
 * sender's address and contact from the index row, never a subject or body.
 */
export async function markThreadTrust(
  supabase: SupabaseClient,
  mark: {
    userId: string
    accountId: string
    providerThreadId: string
    trust: ThreadTrustMark
    messageId: string | null
    inferenceId: string | null
  },
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('email_thread_index')
      .update({ trust: mark.trust, trust_message_id: mark.messageId, trust_inference_id: mark.inferenceId })
      .eq('user_id', mark.userId)
      .eq('account_id', mark.accountId)
      .eq('provider_thread_id', mark.providerThreadId)
      .select('workspace_id, from_email, linked_contact_id')
    if (error) {
      console.warn('[email-trust] could not mark the thread')
      return false
    }
    if (mark.trust === 'suspicious' && Array.isArray(data) && data.length) {
      const rows = data as Array<{ workspace_id?: unknown; from_email?: unknown; linked_contact_id?: unknown }>
      await recordAgentEvents(
        rows.flatMap((r) =>
          typeof r.workspace_id === 'string'
            ? [
                {
                  workspaceId: r.workspace_id,
                  userId: mark.userId,
                  kind: 'email.suspicious' as const,
                  priority: 1,
                  refType: 'email_thread',
                  refId: mark.providerThreadId,
                  // An address and a pointer, never the subject (no stored mail).
                  facts: {
                    ...(typeof r.from_email === 'string' && r.from_email ? { from: r.from_email } : {}),
                    ...(typeof r.linked_contact_id === 'string' && r.linked_contact_id ? { contactId: r.linked_contact_id } : {}),
                  },
                  dedupeKey: agentEventKey.emailSuspicious(mark.accountId, mark.providerThreadId, mark.messageId),
                },
              ]
            : [],
        ),
        supabase,
      )
    }
    return true
  } catch {
    console.warn('[email-trust] could not mark the thread')
    return false
  }
}
