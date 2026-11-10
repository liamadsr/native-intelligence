import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { settleAttentionCard } from '@/lib/attention/settle-card'
import { reviseEmailDraft } from '@/lib/email/revise-draft'
import { MAX_DRAFT_BODY, MAX_DRAFT_RECIPIENTS, MAX_DRAFT_SUBJECT } from '@/lib/email/draft-edits'
import { DISCARD_CONFIRM_OVER, DISCARD_DRAFTS_MAX, discardEmailDrafts, isOpenDraftStatus, readOwnDraftRows } from '@/lib/email/discard-drafts'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { DRAFT_DISMISS_REASONS } from '@/lib/evals/flywheel/types'
import { undoExtractionPass } from '@/lib/proposed-changes/undo-extraction-pass'

/**
 * "Tell it what to do next" (bots v3 Phase 5, docs/plans/bots-v3.md): the
 * writes that let a bot act on what its run did, at the person's word, in the
 * conversation about it.
 *
 *   settle_card           accept, dismiss or start one of the person's cards,
 *                         through the attention-items PATCH logic
 *                         (settleAttentionCard), owner-only;
 *   revise_email_draft    rewrite an unsent draft in place, the row and the
 *                         mailbox's draft (reviseEmailDraft); never sends;
 *   discard_email_draft   discard drafts Native Intelligence wrote, one or many, from the
 *                         mailbox and from Native Intelligence, with why (discardEmailDrafts,
 *                         GEN-1165); more than DISCARD_CONFIRM_OVER the person
 *                         didn't name one by one wait for their yes;
 *   undo_extraction_pass  undo what one extraction pass filed, and only that
 *                         pass's entries (undoExtractionPass).
 *
 * ATTENDED ONLY (ATTENDED_ONLY_TOOL_NAMES, tool-registry.ts): no unattended run
 * holds one, and a bot's chat holds one only when its bot is granted it
 * (src/lib/chat/follow-through.ts; no bot is granted discard_email_draft).
 * Each tool re-checks that what it touches is the caller's own, in the
 * session's workspace (discard_email_draft: in any of the caller's
 * workspaces, as list_bot_work lists them), whatever client it runs on (the
 * internal tool routes use a service-role client).
 */
const UUID_MESSAGE = 'must be a uuid'
const uuid = z.string().uuid(UUID_MESSAGE)

/** The settle_card verbs: a person's three clicks on a card. */
export const SETTLE_CARD_ACTIONS = ['accept', 'dismiss', 'start'] as const

/** settle_card's answer when no card is named: the fix, in the tool's own field names. */
const MISSING_CARD_ID =
  "card_id is missing: pass the card's id as card_id (target_entity_id is only the action an update card should change)."

/** Said back when the card was found from an id that came in as target_entity_id. */
const MISPLACED_NOTE = {
  card: "The id you gave as target_entity_id is this card's id, so it was taken as card_id. Next time pass a card's id as card_id.",
  proposal:
    'The id you gave as target_entity_id is the proposal this card carries, so it was taken as proposal_id. Next time pass the card\'s id as card_id (or a proposal id as proposal_id).',
} as const

interface OwnCard {
  id: string
  /** The proposal it carries, when it carries one. */
  proposal_id: string | null
  kind: string | null
}

/**
 * What the model reads when it tries to settle an approval card (A5: a tool
 * call the server holds for the person's yes). Only the person approves it,
 * on the card: the model can never approve its own blocked call.
 */
export const APPROVAL_PERSON_ONLY_NOTE =
  "That card is an approval: only the person can approve or decline it, on the card itself. Don't settle it; tell them it is waiting for them."


/**
 * One of the member's own cards in this workspace, by its id (any status, as
 * card_id always was: settling a settled card answers ALREADY_RESOLVED) or by
 * the proposal its pending card carries. The card, or undefined.
 */
async function findOwnCard(
  supabase: SupabaseClient,
  workspaceId: string,
  memberId: string,
  by: { card_id: string } | { proposal_id: string },
): Promise<OwnCard | undefined> {
  let q = supabase.from('attention_item').select('id, proposal_id, kind').eq('workspace_id', workspaceId).eq('member_id', memberId)
  q = 'card_id' in by ? q.eq('id', by.card_id) : q.eq('proposal_id', by.proposal_id).eq('status', 'pending')
  const { data: rows } = await q.order('created_at', { ascending: false }).limit(1)
  const row = (rows ?? [])[0] as { id?: string; proposal_id?: string | null; kind?: string | null } | undefined
  return row?.id ? { id: row.id, proposal_id: row.proposal_id ?? null, kind: row.kind ?? null } : undefined
}

export function createFollowThroughTools(userId: string, supabase: SupabaseClient, workspaceId: string) {
  return {
    settle_card: tool({
      description:
        "Settle ONE card: put the card's id in card_id (or, instead, the proposal id it carries in proposal_id). Never put the card's id in target_entity_id. " +
        "It settles one of the person's own pending cards (a proposal a run carded for them) exactly as their click would: " +
        "accept it (it becomes real: an action, a decision, an update), dismiss it, or start it (a work card). " +
        'Use ONLY when the person asks you to in this conversation ("accept it after all", "dismiss that one"); never on your own judgement. ' +
        'Say what you settled. ' +
        'target_entity_id is only for one case: accepting an update card answered UPDATE_TARGET_UNRESOLVED; then find the action the person means (list_actions) and accept again with the same card_id plus that action\'s id as target_entity_id.',
      inputSchema: z
        .object({
          card_id: uuid
            .optional()
            .describe("The card's id: the card_id get_bot_item gave, or the \"card …\" id in the run you are talking about. Give this (or proposal_id)"),
          proposal_id: uuid.optional().describe("Instead of card_id: the proposal id the card carries (the person's pending card for it)"),
          action: z.enum(SETTLE_CARD_ACTIONS).describe('accept, dismiss, or start (start only for a work card)'),
          corrections: z
            .object({
              project_id: uuid.nullable().optional(),
              priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).optional(),
              due_date: z.string().nullable().optional(),
              assignee_member_id: uuid.nullable().optional(),
            })
            .optional()
            .describe('On accept only: what the person asked to change first (project, priority, due date, assignee)'),
          target_entity_id: uuid
            .optional()
            .describe(
              "NOT the card's id (that goes in card_id). Only when accepting an update card answered UPDATE_TARGET_UNRESOLVED: the id of the ACTION the update should change",
            ),
        }),
      execute: async ({ card_id, proposal_id, action, corrections, target_entity_id }) => {
        if (card_id && proposal_id) return { success: false, code: 'INPUT_INVALID', error: 'Give only one of card_id or proposal_id, not both.' }
        if (!card_id && !proposal_id && !target_entity_id) return { success: false, code: 'INPUT_INVALID', error: MISSING_CARD_ID }
        // The caller's own member row here: the card must be theirs, in this workspace.
        const { data: member } = await supabase
          .from('member')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('user_id', userId)
          .maybeSingle<{ id: string }>()
        if (!member?.id) return { success: false, error: 'You are not a member of this workspace.' }
        const ownCard = (by: { card_id: string } | { proposal_id: string }) => findOwnCard(supabase, workspaceId, member.id, by)

        // A weak model can put the card's id in the similarly typed
        // target_entity_id and resend it unchanged (PROD, 2026-10-08: 31 calls
        // in one turn). With no card named, an id there that is one of the
        // caller's own cards, or the proposal one of their pending cards
        // carries, IS the card (same member and workspace fences as card_id):
        // settle that card, and drop the id as a target. Anything else gets an
        // error that names the fix.
        let card: OwnCard | undefined
        let target = target_entity_id
        let misplaced: keyof typeof MISPLACED_NOTE | null = null
        if (!card_id && !proposal_id) {
          card = await ownCard({ card_id: target_entity_id! })
          misplaced = 'card'
          if (!card) {
            card = await ownCard({ proposal_id: target_entity_id! })
            misplaced = 'proposal'
          }
          if (!card) {
            return {
              success: false,
              code: 'INPUT_INVALID',
              error: `${MISSING_CARD_ID} ${target_entity_id} is not one of the person's cards, so it cannot stand in for one.`,
            }
          }
          target = undefined
        } else {
          card = await ownCard(card_id ? { card_id } : { proposal_id: proposal_id! })
          if (!card) return { success: false, code: 'NOT_FOUND', error: 'No card of yours with that id in this workspace.' }
          // The card's own id, or the proposal it carries, repeated as its
          // target is the same slip: neither is ever an action to update.
          if (target && (target === card.id || target === card.proposal_id)) target = undefined
        }
        const cardId = card.id
        if (card.kind === 'approval') {
          return { success: false, card_id: cardId, code: 'APPROVAL_PERSON_ONLY', error: APPROVAL_PERSON_ONLY_NOTE }
        }
        if (target && action !== 'accept') {
          return { success: false, code: 'INPUT_INVALID', error: 'target_entity_id goes with accept only.' }
        }

        // Exactly the click's path (PATCH /api/account/attention-items), fenced on
        // the caller's own member row.
        const res = await settleAttentionCard(
          supabase,
          userId,
          {
            id: cardId,
            action,
            ...(action === 'accept' && corrections ? { corrections } : {}),
            // settleAttentionCard checks the target is in this workspace (TARGET_NOT_IN_WORKSPACE).
            ...(action === 'accept' && target ? { target_entity_id: target } : {}),
          },
          { ownerMemberId: member.id },
        )
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
        const note = misplaced ? { note: MISPLACED_NOTE[misplaced] } : {}
        if (!res.ok) {
          return { success: false, card_id: cardId, code: body.code ?? res.status, error: body.error ?? 'The card could not be settled.', ...note }
        }
        return { success: true, card_id: cardId, ...body, ...note }
      },
    }),

    revise_email_draft: tool({
      description:
        "Rewrite one of the person's own unsent email drafts in place when they ask for a change (\"make it more formal\", \"shorter\", \"add Sam on cc\"): " +
        'the draft in Native Intelligence and the draft in their mailbox both change. It never sends; sending stays their click. ' +
        'Give the WHOLE new body (plain text), not a diff. Recipients and subject keep what the draft has unless you pass them. ' +
        'Name the draft by its draft id: a Native Intelligence draft row id, or the mailbox draft id.',
      inputSchema: z.object({
        draft_id: z.string().min(1).max(512).describe('The draft: an email_draft row id, or the mailbox draft (message) id'),
        body: z.string().min(1).max(MAX_DRAFT_BODY).describe('The complete new body, plain text'),
        subject: z.string().max(MAX_DRAFT_SUBJECT).optional().describe('A new subject; omit to keep the draft’s'),
        to: z.array(z.string()).max(MAX_DRAFT_RECIPIENTS).optional().describe('New To addresses; omit to keep the draft’s'),
        cc: z.array(z.string()).max(MAX_DRAFT_RECIPIENTS).optional().describe('New Cc addresses; omit to keep the draft’s'),
      }),
      execute: async ({ draft_id, body, subject, to, cc }) =>
        reviseEmailDraft(supabase, userId, workspaceId, {
          draftId: draft_id,
          body,
          ...(subject !== undefined ? { subject } : {}),
          ...(to !== undefined ? { to } : {}),
          ...(cc !== undefined ? { cc } : {}),
        }),
    }),

    discard_email_draft: tool({
      description:
        'Discard email drafts Native Intelligence wrote for the person (never sends): each is deleted from their mailbox and leaves Native Intelligence\'s pending list, and the reason is kept so drafting learns from it. ' +
        'Use ONLY when the person asks ("delete that draft", "clean up my junk drafts"). ' +
        'Name drafts by any id you were given: an email draft id (get_email_drafts), a Mail draft item id from list_bot_work (draft:…), or the mailbox draft id. ' +
        "Only Native Intelligence's own drafts can be discarded; a draft the person wrote themselves is never touched. " +
        `More than ${DISCARD_CONFIRM_OVER} drafts they didn't name one by one: call without confirmed first; it answers CONFIRM_FIRST with the drafts it would discard. ` +
        'List them for the person, wait for their yes in the chat, then call again with the same ids and confirmed: true. ' +
        'Say back what the reply says (`message`), including any it could not discard.',
      inputSchema: z.object({
        draft_ids: z
          .array(z.string().min(1).max(512))
          .min(1)
          .max(DISCARD_DRAFTS_MAX)
          .describe('The drafts: email draft ids, list_bot_work draft item ids (draft:…), or mailbox draft ids'),
        reason: z
          .enum(DRAFT_DISMISS_REASONS)
          .describe(
            "Why, for all of them (one call per reason): no_reply_needed (nothing needed a reply: a receipt, a notice, marketing, a calendar reply, a test), outdated (the moment passed, or it was handled elsewhere), duplicate (another draft answers the thread), bad_draft (a reply is owed but this draft is wrong), other",
          ),
        note: z.string().max(300).optional().describe("The person's own words about why, when they gave some"),
        confirmed: z
          .boolean()
          .optional()
          .describe(`true only when the person said yes in this conversation to discarding exactly these, or named each one themselves. Needed for more than ${DISCARD_CONFIRM_OVER}`),
      }),
      execute: async ({ draft_ids, reason, note, confirmed }) => {
        if (draft_ids.length > DISCARD_CONFIRM_OVER && confirmed !== true) {
          // Nothing is discarded: the drafts it would discard, for the person's yes.
          try {
            const found = await readOwnDraftRows(supabase, userId, draft_ids)
            const open = found.filter((f) => f.row && isOpenDraftStatus(f.row.status))
            return {
              success: false,
              code: 'CONFIRM_FIRST',
              error: `Nothing was discarded yet. List these ${open.length} drafts for the person and ask; once they say yes, call again with the same draft_ids and confirmed: true.`,
              drafts: open.map(({ row }) => ({
                draft_id: row!.id,
                subject: wrapUntrusted(row!.subject ?? ''),
                to: Array.isArray(row!.to_emails) ? (row!.to_emails[0] ?? null) : null,
                created_at: row!.created_at,
              })),
              ...(found.length > open.length ? { not_discardable: found.filter((f) => !open.includes(f)).map((f) => f.id) } : {}),
            }
          } catch {
            return { success: false, code: 'FAILED', error: 'The drafts could not be read just now; nothing was discarded.' }
          }
        }
        return discardEmailDrafts(supabase, userId, { draftIds: draft_ids, reason, note: note ?? null, by: 'agent' })
      },
    }),

    undo_extraction_pass: tool({
      description:
        'Undo what ONE extraction pass filed from a capture, when the person asks ("undo what you filed from that call"): ' +
        'each thing that pass created is removed and its proposal goes back to pending for review. Only that pass’s entries are touched; ' +
        'anything the person has edited, moved or commented on since, or that changed something that already existed, is left as it is (each skipped entry says why). Name the pass by its extraction pass id.',
      inputSchema: z.object({
        pass_id: uuid.describe('The extraction pass id (the "extraction pass …" id of the run you are talking about)'),
      }),
      execute: async ({ pass_id }) => undoExtractionPass(supabase, userId, workspaceId, pass_id),
    }),
  }
}
