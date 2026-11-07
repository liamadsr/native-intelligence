import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MAX_SUGGESTIONS_PER_CALL } from '@/lib/suggestions/lifecycle'
import { stageSuggestions } from '@/lib/suggestions/stage'
import { isDocumentVisible } from './_shared'
import {
  SUGGEST_CHANGE_TYPES,
  SUGGEST_ENTITY_TYPES,
  SUGGEST_PRIORITIES,
  type SuggestionHome,
  type SuggestionOrigin,
} from '@/lib/suggestions/types'

/**
 * suggest_changes: stage changes for the person to accept, dismiss or modify
 * with one click, right where the agent wrote about them
 * (docs/plans/suggestions-everywhere.md). The server side is
 * src/lib/suggestions/stage.ts.
 *
 * Where a suggestion is shown (its home) comes from where the tool runs, never
 * from the model: the chat conversation, or the run's document (a run's
 * suggestions are re-homed onto it at delivery). `document_id` stages into a
 * document the agent just wrote instead.
 */
export interface SuggestionToolContext {
  origin: SuggestionOrigin
  /** Main chat or a bot's chat: the conversation is the home. */
  conversationId?: string | null
  /** A skill or work run: its work-ledger row, resolved lazily for work runs. */
  trackedJobId?: string | null | (() => Promise<string | null>)
}

export const SUGGEST_CHANGES_PLACEMENT =
  'Put each marker on its own line right after the paragraph or bullet it belongs to, so its card renders there. ' +
  'Do not repeat the change in prose beyond what explains it; the card shows it.'

const uuid = z.string().uuid('must be a uuid')

export function createSuggestionTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  context?: SuggestionToolContext,
) {
  return {
    suggest_changes: tool({
      description:
        'Stage changes for the person to accept, dismiss or modify with one click, instead of describing them in prose. ' +
        'Use when you recommend a change to workspace items the person did not ask you to make outright: close or move an action, ' +
        'reassign it, reschedule it, reprioritize it, move it to another project, create a task, update a project or milestone, ' +
        'or draft an email to a contact. When the person asked for the change directly ("close GEN-12"), make it with the normal tool instead. ' +
        'Name existing items by identifier (GEN-42) or id. Batch everything for one answer into one call (at most ' +
        `${MAX_SUGGESTIONS_PER_CALL}). Each result carries a marker: ${SUGGEST_CHANGES_PLACEMENT} ` +
        'A refused suggestion says why (unknown target, a status the team does not have, already done, dismissed recently): fix it or drop it.',
      inputSchema: z.object({
        document_id: uuid
          .optional()
          .describe('Stage into this document (one you just created or are editing) instead of this conversation or run'),
        changes: z
          .array(
            z.object({
              change: z.enum(SUGGEST_CHANGE_TYPES).describe('create | update | assign | delete | send_email'),
              entity: z.enum(SUGGEST_ENTITY_TYPES).describe('action | project | milestone | contact (contact: send_email only)'),
              target: z
                .string()
                .optional()
                .describe('The existing item: an identifier like GEN-42, an id, or a name. Required unless change is create'),
              summary: z
                .string()
                .min(1)
                .max(200)
                .describe('The card\'s one line, an imperative: "Move GEN-297 to Todo, due Oct 9"'),
              set: z
                .object({
                  status: z.string().optional().describe('Workflow state name for an action (Todo, Done, Canceled…), or a project/milestone status'),
                  assignee: z.string().optional().describe('A member or contact name, or "me"'),
                  due_date: z.string().optional().describe('YYYY-MM-DD'),
                  priority: z.enum(SUGGEST_PRIORITIES).optional(),
                  project: z.string().optional().describe('Project name or id: where a new action goes, or where an action moves'),
                  title: z.string().optional().describe('New title (a create defaults to the summary)'),
                  description: z.string().optional(),
                  email_subject: z.string().optional().describe('send_email only'),
                })
                .optional()
                .describe('The values to change'),
              why: z.string().min(1).max(600).describe('One or two sentences: why, shown in the card\'s context'),
              confidence: z.number().min(0).max(1).optional(),
              expires_in_days: z
                .number()
                .int()
                .min(1)
                .max(90)
                .optional()
                .describe('How long the suggestion stays open if nobody acts (default 30). A daily brief passes 7'),
            }),
          )
          .min(1)
          .max(MAX_SUGGESTIONS_PER_CALL),
      }),
      execute: async ({ document_id, changes }) => {
        let home: SuggestionHome | null = null
        let trackedJobId: string | null = null

        if (document_id) {
          // The document must be in a workspace the person belongs to, and be
          // one they can see (someone else's private one is not, 369).
          const { data: doc } = await supabase
            .from('document')
            .select('id, workspace_id, visibility, created_by')
            .eq('id', document_id)
            .maybeSingle()
          const d = doc as { id: string; workspace_id: string; visibility?: string | null; created_by?: string | null } | null
          const { data: member } = d
            ? await supabase.from('member').select('id').eq('user_id', userId).eq('workspace_id', d.workspace_id).maybeSingle()
            : { data: null }
          const memberId = (member as { id?: string } | null)?.id ?? null
          if (!d || !memberId || !isDocumentVisible(d, memberId)) return { success: false, error: 'No such document in your workspaces.' }
          home = { kind: 'document', id: d.id }
        } else if (context?.conversationId) {
          // The conversation must exist and be the person's own.
          const { data: conv } = await supabase
            .from('chat_conversations')
            .select('id')
            .eq('id', context.conversationId)
            .eq('user_id', userId)
            .maybeSingle()
          if (conv) home = { kind: 'conversation', id: context.conversationId }
        }

        if (context?.trackedJobId) {
          trackedJobId =
            typeof context.trackedJobId === 'function' ? await context.trackedJobId() : context.trackedJobId
        }
        if (!home && !trackedJobId) {
          return {
            success: false,
            error: 'There is nowhere to show suggestions here. Pass document_id (a document you created or are editing).',
          }
        }

        const suggestions = await stageSuggestions(
          {
            supabase,
            userId,
            workspaceId,
            origin: context?.origin ?? 'mcp',
            home,
            trackedJobId,
          },
          changes,
        )
        const staged = suggestions.filter((s) => s.result !== 'refused').length
        return {
          success: staged > 0,
          staged,
          refused: suggestions.length - staged,
          suggestions,
          placement: SUGGEST_CHANGES_PLACEMENT,
          ...(home ? {} : { note: 'These will appear in the document this run delivers.' }),
        }
      },
    }),
  }
}
