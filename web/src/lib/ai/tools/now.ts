import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  NOW_LINE_MAX_CHARS,
  NOW_MAX_CHARS,
  NOW_MAX_EDITS,
  NOW_MAX_LINES,
  NOW_SECTIONS,
  NOW_TRACK_KINDS,
  updateNowNote,
  type NowWriter,
} from '@/lib/now/now-file'

/**
 * Where the person's Now file (docs/plans/now-file.md) may be read and written
 * from, set only by a tool route from what it verified, never by a model.
 * Absent (every surface but the person's own main chat): update_now refuses,
 * and get_document, find and the history tools leave the note out.
 */
export interface NowToolContext {
  /**
   * Who writes the note here, recorded on its revision (edit_meta.writer;
   * migration 440 folds an agent's writes only within one writer): 'chat'
   * in the person's own main chat in the app, 'check_in' for Slice 2's
   * check-in. Absent: update_now refuses.
   */
  writer?: NowWriter
  /**
   * get_document, find and the history tools show the note: the person's own
   * main chat only (caller class `person`, not a server, relayed or channel
   * turn, not a quick helper's call). Everywhere else they refuse or drop it.
   */
  readable?: boolean
}

/** What update_now says on a surface that may not write the note. */
const NOT_HERE =
  "The Now file is written only in the person's own chat in the app. Nothing was written; leave it for that chat."

/**
 * `update_now` (docs/plans/now-file.md "The tool"): the main agent's edits to
 * the person's Now file, one call, several edits, through
 * src/lib/now/now-file.ts (the line rules, the date stamp, the caps, the
 * compare-and-swap write, the tracks).
 *
 * ATTENDED ONLY (ATTENDED_ONLY_TOOL_NAMES): every home turn, text, Slack turn,
 * helper, guest, run and the MCP connector is refused it by the set alone; the
 * writer here is the second fence (no NowToolContext, no write).
 *
 * Returns only the new revision and the lines it changed: the next turn's
 * `now` section carries the whole note.
 */
export function createNowTools(userId: string, supabase: SupabaseClient, workspaceId: string, context?: NowToolContext) {
  return {
    update_now: tool({
      description:
        "Update the person's Now file: your own running notes on what is going on for them right now, under six headings (Focus, In flight, Waiting on you, Waiting on others, Coming up, Keep in mind). The now section shows it with numbered lines and its revision. " +
        'Update it when the picture changes, not every turn; a question changes nothing. ' +
        "Point at things (ENG-42, the Acme call, Sarah), never copy their status, their contents or an email's words. " +
        `No links, no email addresses, nothing durable about the person (that is remember), no secrets. At most ${NOW_LINE_MAX_CHARS} characters a line and ${NOW_MAX_LINES} lines in all. ` +
        'Put every change in one call: add (a line under a heading; the date is added for you), replace (a line by number), remove (a line by number), move (a line to another heading, re-dated), or instead of edits, rewrite (the whole note, for a tidy). ' +
        'Name base_revision from the now section: if the note changed since, nothing is written and you get the note as it is now. ' +
        'Returns the new revision and the lines you changed. Don\'t announce it; the chat row shows it.',
      inputSchema: z.object({
        base_revision: z
          .number()
          .int()
          .optional()
          .describe('The revision in the now section. Needed with replace, remove, move or rewrite once the note has lines'),
        edits: z
          .array(
            z.object({
              op: z.enum(['add', 'replace', 'remove', 'move']).describe('add a line, replace a line, remove a line, or move a line to another heading'),
              section: z.enum(NOW_SECTIONS).optional().describe('add and move: the heading the line goes under'),
              line: z.number().int().optional().describe('replace, remove and move: the line number from the now section'),
              text: z.string().optional().describe('add and replace: the line itself, one short sentence, without a date'),
              track: z
                .object({
                  kind: z.enum(NOW_TRACK_KINDS).describe('work (a helper or run), action, pr, or ask (to another agent)'),
                  id: z.string().describe("The item's id: its uuid, identifier (ENG-42) or PR (owner/repo#12)"),
                })
                .optional()
                .describe('add only: the item the line follows, so a later check-in can see when it changes'),
            }),
          )
          .max(NOW_MAX_EDITS)
          .optional()
          .describe('The changes, all against the lines and revision you read'),
        rewrite: z
          .string()
          .max(NOW_MAX_CHARS * 2)
          .optional()
          .describe('Instead of edits: the whole note as it should read, headings and lines. Lines you keep keep their dates'),
        summary: z.string().min(1).describe('One line for the history: what changed and why (at most 200 characters)'),
      }),
      execute: async ({ base_revision, edits, rewrite, summary }) => {
        if (!context?.writer) return { success: false, code: 'NOW_NOT_HERE', error: NOT_HERE }
        return updateNowNote(supabase, {
          workspaceId,
          userId,
          baseRevision: base_revision ?? null,
          ...(edits ? { edits } : {}),
          ...(rewrite !== undefined ? { rewrite } : {}),
          summary,
          writer: context.writer,
        })
      },
    }),
  }
}
