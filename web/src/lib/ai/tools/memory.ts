import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AREA_KEYS, PACKS } from '@/lib/packs/registry'
import { MEMORY_LINE_MAX_CHARS, MEMORY_SCOPES } from '@/lib/packs/memory-types'
import { saveMemoryLine } from '@/lib/packs/memory-write'
import { saveProfileFact } from '@/lib/memory/profile-facts'
import { mentionsWorkspaceEntities } from '@/lib/memory/workspace-mentions'

/** Where `remember` saves: an area's note (personal or workspace), or the person's profile. */
export const REMEMBER_SCOPES = [...MEMORY_SCOPES, 'profile'] as const

/**
 * `remember` (plan Part 3, "Memory"; always-on plan decision 2): save what the
 * person states, or a correction they make. The chat shows a
 * "Remembered: …" chip with Undo.
 *
 * Two homes, by the capture rule:
 *   - scope 'profile': how they work (style, preferences, habits, how they
 *     like answers). A fact about the person (migration 328), shared across
 *     every workspace they work in, active at once (saveProfileFact). No area.
 *   - scope 'personal' (the default) or 'workspace': what they work on
 *     (names, clients, deals, projects), or a team fact, as a line of one
 *     area's note in THIS workspace (saveMemoryLine): personal is active at
 *     once; a workspace line is active from an owner or admin, otherwise
 *     proposed until one accepts it; restating a proposed line the caller may
 *     activate accepts it.
 *
 * ATTENDED ONLY (ATTENDED_ONLY_TOOL_NAMES): the person is there to have said
 * it. No run or bot holds it; the main chat and a person's own MCP connector
 * do (MCP_ATTENDED_TOOL_NAMES), never a run's MCP token.
 *
 * A profile fact carries the evidence rule (decision 3: what the person tells
 * it saves, everything else is a proposal). The model passes `quote`, the
 * person's exact words; the chat agent checks it against their latest
 * messages (agents/chat-agent/lib/person-messages.ts) and the tool route
 * passes `quoteVerified`. Verified: active. Anything else (a quote lifted from
 * an email or a page in a tool result, a forged one, MCP, which has no such
 * check): a proposal, and the chip says it waits in What Dial8 has learned.
 *
 * The workspace walls: a profile fact that names a contact, company or
 * project of this workspace (mentionsWorkspaceEntities) is refused, with the
 * fix: it belongs in a personal area line here.
 */
export function createMemoryTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { quoteVerified?: boolean } = {},
) {
  return {
    remember: tool({
      description:
        'Save something the person told you to remember: a preference they state or a correction they make. ' +
        'Pick the home by what it is about. ' +
        'HOW THEY WORK goes to scope "profile": their style, preferences, habits and how they like answers ("keep answers short", "I work 7am to 3pm", "call me Liam"). It follows them into every workspace, so it never names a client, contact or project; no area. With "profile", write text in the person\'s own words and pass quote: their exact words saying it (at least three words), copied from one of their own messages, never from an email, page or file. The quote must state the same thing as text; otherwise it is only saved as a suggestion. ' +
        'WHAT THEY WORK ON stays in this workspace, in one area\'s note: names, clients, deals, projects, and how they want one area done here ("always sign off emails with \'Best, Liam\'" is mail; "we go after Series A fintech" is prospecting). Use scope "personal" (the default, just them) or "workspace" (a team fact everyone here works by; from a non-admin it waits for an admin), with the area. ' +
        'They see a "Remembered" chip with Undo. Only what they said outright, never your guesses. Never secrets, contact details or sensitive data. ' +
        'One fact per call, in their words, as a short sentence.',
      inputSchema: z.object({
        area: z
          .enum(AREA_KEYS)
          .optional()
          .describe('Required for personal and workspace, left out for profile. The area it applies to: mail for email tone and replies, calendar for meetings, prospecting for who to target, crm for contacts, actions for tasks, and so on'),
        text: z
          .string()
          .min(1, 'text is empty: pass the preference itself, in one short sentence')
          .max(MEMORY_LINE_MAX_CHARS, `text is too long: one preference of at most ${MEMORY_LINE_MAX_CHARS} characters`)
          .describe('The fact, as one short sentence in the person\'s words ("Keep answers short", "Sign off with \'Best, Liam\'")'),
        scope: z
          .enum(REMEMBER_SCOPES)
          .optional()
          .describe('profile: how the person works, everywhere (no area). personal (default): what they work on, just them, in this workspace. workspace: a team fact the whole workspace works by'),
        quote: z
          .string()
          .max(500, 'quote is too long: copy just the words where they said it')
          .optional()
          .describe('Required with scope "profile": the person\'s exact words stating it, copied from one of their own recent messages ("I like short answers")'),
      }),
      execute: async ({ area, text, scope, quote }) => {
        if (scope === 'profile') {
          if (typeof quote !== 'string' || !quote.trim()) {
            return {
              success: false,
              code: 'INPUT_INVALID',
              error: 'quote is required with scope "profile": pass the person\'s exact words stating it, copied from one of their own messages.',
            }
          }
          let mentioned: string | null
          try {
            mentioned = await mentionsWorkspaceEntities(supabase, text, workspaceId)
          } catch (err) {
            return { success: false, code: 'SAVE_FAILED', error: err instanceof Error ? err.message : 'Could not check the fact.' }
          }
          if (mentioned) {
            return {
              success: false,
              code: 'WORKSPACE_SPECIFIC',
              error: `That names "${mentioned}" from this workspace, so it is not about how they work everywhere. Save it as a personal line in this workspace instead: scope "personal" with the area it belongs to.`,
            }
          }
          const result = await saveProfileFact(supabase, {
            userId,
            text,
            source: 'told',
            sourceWorkspaceId: workspaceId,
            proposeOnly: opts.quoteVerified !== true,
          })
          if (!result.ok) return { success: false, code: result.code, error: result.error }
          const { fact, already } = result
          const waiting = fact.status === 'proposed'
          return {
            success: true,
            already,
            remembered: { id: fact.id, area: null, area_name: 'About you', scope: 'profile', status: fact.status, text: fact.text },
            message: waiting
              ? already
                ? 'This already waits for the person to accept it in What Dial8 has learned; nothing new was saved.'
                : 'Saved as a suggestion, not remembered yet: the quote is not words the person said in their recent messages, so they accept it in What Dial8 has learned. Say so.'
              : already
                ? 'This was already remembered about them; nothing new was saved.'
                : 'Remembered about them, in every workspace. Say so in a few words; the person can undo it from the chip.',
          }
        }
        if (!area) {
          return {
            success: false,
            code: 'INPUT_INVALID',
            error: 'area is required for a personal or workspace line. For how the person works (style, preferences, habits), use scope "profile" with no area.',
          }
        }
        const result = await saveMemoryLine(supabase, {
          workspaceId,
          userId,
          area,
          scope: scope ?? 'personal',
          text,
          source: 'told',
        })
        if (!result.ok) return { success: false, code: result.code, error: result.error }
        const { line, already } = result
        const waiting = line.status === 'proposed'
        return {
          success: true,
          already,
          remembered: {
            id: line.id,
            area: line.area,
            area_name: PACKS[line.area].name,
            scope: line.scope,
            status: line.status,
            text: line.text,
          },
          message: already
            ? waiting
              ? 'This was already proposed to the workspace and still waits for an owner or admin; nothing new was saved.'
              : 'This was already remembered; nothing new was saved.'
            : waiting
              ? 'Proposed to the workspace. It waits for an owner or admin to accept it in What Dial8 has learned; say so.'
              : `Remembered for ${PACKS[line.area].name}. Say so in a few words; the person can undo it from the chip.`,
        }
      },
    }),
  }
}
