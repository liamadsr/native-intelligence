/**
 * The agent's own actions (docs/plans/earned-autonomy.md §5, phase 3): a
 * granted kind's held call is still raised as the person's card, marked as
 * running on its own; it runs at the end of its undo window through the SAME
 * accept path a click takes (safety/approvals.ts approveToolCall: membership,
 * the kill switch, the input hash, the ceiling, all re-checked), and the
 * person's Dismiss in the window is the Undo.
 *
 * Liam, 11-27, decision 1: the person's yes to "handle this kind yourself"
 * counts as their final yes, with the 5-minute undo window before each send
 * (amending 10-26: "nothing reaches another person without the person's final
 * yes"). So the runner approves AS the person, on that standing yes, and only
 * after graduationFor says yes again at run time. Decision 4: one undo drops
 * the kind back to ask, with a 14-day cooldown.
 *
 *   schedule   one autonomy_action row per approval (unique), then the
 *              Inngest event that wakes the runner at run_at. If either
 *              fails, the card simply waits for the person (ask).
 *   run        at run_at: the row must still be scheduled and its approval
 *              still pending; graduationFor again; then claim the row
 *              (scheduled → running) and approve. Any no sends it back to the
 *              card (cancelled, with the reason, and a line in the home thread).
 *   undo       the person's Dismiss of the card while the row is scheduled:
 *              the row is undone, the outcome is `undone`, and the kind goes
 *              back to ask.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { approveToolCall } from '@/lib/safety/approvals'
import { appendHomeMessage } from '@/lib/chat/home-message-writer'
import { graduationFor, UNDO_WINDOW_MINUTES, type Graduation, type GraduationDeps, type GraduationRefusal } from './graduate'

export const AUTONOMY_ACTION_EVENT = 'autonomy/action.scheduled'

/** What a granted kind's card says (the person sees it at once; Dismiss is the undo). */
export function autonomousCardWhy(why: string): string {
  return `You said I can handle these myself, so this goes on its own in ${UNDO_WINDOW_MINUTES} minutes. Dismiss it to stop it. ${why}`.trim()
}

/** What the model reads for a call that will run on its own. */
export function autonomousHeldMessage(tool: string): string {
  return `Nothing ran yet: ${tool} is a kind of work the person said you can handle yourself, so it runs on its own in ${UNDO_WINDOW_MINUTES} minutes unless they stop it from its card. Do not call it again; say in one line that it goes out shortly.`
}

export async function scheduleAutonomousAction(
  db: SupabaseClient,
  args: { graduation: Extract<Graduation, { run: true }>; approvalId: string; workspaceId: string; userId: string; title: string },
  deps: { send?: (event: { name: string; data: Record<string, unknown> }) => Promise<unknown> } = {},
): Promise<boolean> {
  try {
    // The card the person stops it from (its Undo), read off the approval just raised.
    const { data: approval } = await db.from('tool_approval').select('card_id').eq('id', args.approvalId).maybeSingle()
    const cardId = (approval as { card_id?: string | null } | null)?.card_id ?? null
    const { data, error } = await db
      .from('autonomy_action')
      .insert({
        card_id: cardId,
        workspace_id: args.workspaceId,
        user_id: args.userId,
        approval_id: args.approvalId,
        kind_key: args.graduation.kind.key.slice(0, 400),
        tool: args.graduation.kind.tool.slice(0, 200),
        level: args.graduation.level,
        status: 'scheduled',
        title: args.title.slice(0, 500),
        recipients: args.graduation.kind.recipients.slice(0, 20),
        run_at: args.graduation.runAt,
      })
      .select('id')
      .maybeSingle()
    // The same pending call again (createToolApproval reuses it): already scheduled.
    if (error && (error as { code?: string }).code === '23505') return true
    const id = (data as { id?: string } | null)?.id
    if (error || !id) return false
    await (deps.send ?? ((e) => inngest.send(e)))({ name: AUTONOMY_ACTION_EVENT, data: { action_id: id, run_at: args.graduation.runAt } })
    return true
  } catch (err) {
    console.warn('[earned-autonomy] schedule failed', err instanceof Error ? err.message : String(err))
    return false
  }
}

const REFUSAL_WORDS: Record<GraduationRefusal, string> = {
  off: 'handing work over is switched off',
  caller: 'this one came from somewhere that always asks',
  guest: "it was a guest's call",
  mac_job: 'it was a job on your Mac',
  hard_limit: 'this kind always asks',
  paused: 'agent work is switched off for this workspace',
  not_granted: 'you took this kind back',
  demoted: 'you undid one of these, so this kind asks again',
  kind_cap: "I've done as many of these on my own as I may today",
  person_cap: "I've done as much on my own as I may today",
  new_recipient: "it reaches someone you haven't been in touch with",
  read_failed: "I couldn't check that it's still yours to hand over",
}

export type RunOutcome = 'ran' | 'failed' | 'cancelled' | 'not_due' | 'gone'

interface ActionRow {
  id: string
  workspace_id: string
  user_id: string
  approval_id: string
  card_id: string | null
  kind_key: string
  status: string
  run_at: string
  title: string | null
}

async function cancel(db: SupabaseClient, row: ActionRow, reason: string, tell: boolean): Promise<RunOutcome> {
  await db.from('autonomy_action').update({ status: 'cancelled', reason: reason.slice(0, 500), settled_at: new Date().toISOString() }).eq('id', row.id).eq('status', 'scheduled')
  if (tell) {
    await appendHomeMessage(db, {
      userId: row.user_id,
      workspaceId: row.workspace_id,
      messageId: `autonomy-cancelled-${row.id}`,
      parts: [{ type: 'text', text: `I didn't do "${row.title ?? 'that'}" on my own after all: ${reason}. Its card is waiting for your yes.` }],
      metadata: { kind: 'autonomy_cancelled' },
    }).catch(() => {})
  }
  return 'cancelled'
}

/** Run one scheduled action at the end of its window. Service client. Never throws. */
export async function runAutonomousAction(
  db: SupabaseClient,
  actionId: string,
  deps: GraduationDeps & { approve?: typeof approveToolCall; now?: Date } = {},
): Promise<RunOutcome> {
  try {
    const now = deps.now ?? new Date()
    const { data } = await db
      .from('autonomy_action')
      .select('id, workspace_id, user_id, approval_id, card_id, kind_key, status, run_at, title')
      .eq('id', actionId)
      .maybeSingle()
    const row = data as ActionRow | null
    if (!row || row.status !== 'scheduled') return 'gone'
    if (Date.parse(row.run_at) > now.getTime()) return 'not_due'

    const { data: approvalData } = await db
      .from('tool_approval')
      .select('id, workspace_id, user_id, tool, input, context, status, card_id')
      .eq('id', row.approval_id)
      .eq('user_id', row.user_id)
      .eq('workspace_id', row.workspace_id)
      .maybeSingle()
    const approval = approvalData as { id: string; tool: string; input: unknown; context: Record<string, unknown> | null; status: string; card_id: string | null } | null
    // Answered, expired or switched off meanwhile: nothing to run, nothing to say.
    if (!approval || approval.status !== 'pending') return cancel(db, row, `its card was already ${approval?.status ?? 'gone'}`, false)

    // Everything again, now: the window is when a revoke, an undo or the kill switch lands.
    const again = await graduationFor(
      db,
      { workspaceId: row.workspace_id, userId: row.user_id, tool: approval.tool, input: approval.input, context: approval.context, caller: 'person', decision: 'ask', localAgent: approval.context?.localAgent, recheckActionId: row.id, now },
      deps,
    )
    if (!again.run) return cancel(db, row, REFUSAL_WORDS[again.reason], true)

    const { data: claimed } = await db.from('autonomy_action').update({ status: 'running' }).eq('id', row.id).eq('status', 'scheduled').select('id')
    if (!claimed?.length) return 'gone'

    // The person's standing yes for this kind (decision 1), as the person.
    const outcome = await (deps.approve ?? approveToolCall)(
      db,
      { callerClass: 'person', userId: row.user_id },
      { workspace_id: row.workspace_id, payload: { approval_id: row.approval_id } },
      { autonomousActionId: row.id },
    )
    const ranAt = new Date().toISOString()
    const cardId = approval.card_id ?? row.card_id
    if (cardId) {
      await db
        .from('attention_item')
        .update({ status: outcome.ok ? 'accepted' : 'dismissed', resolved_at: ranAt })
        .eq('id', cardId)
        .eq('status', 'pending')
        .eq('workspace_id', row.workspace_id)
    }
    const ran = outcome.ok && outcome.success
    await db
      .from('autonomy_action')
      .update({ status: ran ? 'ran' : 'failed', ran_at: outcome.ok ? ranAt : null, settled_at: ranAt, card_id: cardId, reason: outcome.ok ? null : outcome.error.slice(0, 500) })
      .eq('id', row.id)
    if (ran) {
      const kind = again.kind
      await db
        .from('autonomy_outcome')
        .upsert(
          { workspace_id: row.workspace_id, user_id: row.user_id, kind_key: row.kind_key, tool: kind.tool, channel: kind.channel, audience: kind.audience, source: 'autonomy_action', source_id: row.id, outcome: 'ran', edit_ratio: null },
          { onConflict: 'source,source_id,outcome', ignoreDuplicates: true },
        )
    }
    return ran ? 'ran' : 'failed'
  } catch (err) {
    console.warn('[earned-autonomy] run failed', err instanceof Error ? err.message : String(err))
    return 'failed'
  }
}
