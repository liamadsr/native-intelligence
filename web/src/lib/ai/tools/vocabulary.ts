import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  VOCABULARY_TERM_MAX_CHARS,
  addVocabularyTerm,
  automaticVocabulary,
  deleteVocabularyTerm,
  listVocabulary,
  updateVocabularyTerm,
  type VocabularyTerm,
} from '@/lib/vocabulary/store'

/**
 * Custom vocabulary from the chat and over MCP (docs/plans/custom-vocabulary.md
 * §10, migration 430): the words transcription should get right ("add
 * Supabase to my vocabulary", "it keeps writing Superbase"). Words are fixed
 * by sound in meeting transcripts, dictation and voice mode. The same store as
 * Settings → Vocabulary. Most of the vocabulary arrives on its own (names Dial8
 * knows, words the team writes); these tools are for what the person asks.
 *
 * Fences (review, 2026-10-24): an unattended run (work-run, skill-run) never
 * changes the vocabulary, since it rewrites every future transcript; and under
 * omitPrivate (a run whose output the workspace can read) only the workspace's
 * words are listed, and no contact or company names.
 */

const view = (t: VocabularyTerm) => ({
  id: t.id,
  term: t.term,
  scope: t.scope,
  status: t.status,
  source: t.source,
  sounds_like: t.soundsLike,
})

const ATTENDED_ONLY = 'The vocabulary is changed by the person, from the chat or Settings → Vocabulary'

export function createVocabularyTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { omitPrivate?: boolean; unattended?: boolean } = {},
) {
  const ctx = { workspaceId, userId }
  return {
    list_vocabulary: tool({
      description:
        "List the custom vocabulary: words transcription should get right (product names, people, acronyms), the workspace's and the user's own. include_harvested adds the words Dial8 picked up on its own from what the team writes; include_automatic adds the names it uses (teammates, projects, contacts and their companies).",
      inputSchema: z.object({
        status: z.enum(['active', 'dismissed', 'all']).optional().default('active').describe('active (in use, default), dismissed (turned off), or all'),
        include_harvested: z.boolean().optional().default(false).describe('Also list the words harvested from documents, tasks and chats'),
        include_automatic: z.boolean().optional().default(false).describe('Also list the names added automatically'),
      }),
      execute: async ({ status, include_harvested, include_automatic }) => {
        try {
          const terms = (
            await listVocabulary(supabase, { ...ctx, status: status === 'all' ? undefined : status, workspaceOnly: opts.omitPrivate === true })
          ).filter((t) => t.source !== 'auto' && (include_harvested || t.source !== 'workspace'))
          let automatic: Awaited<ReturnType<typeof automaticVocabulary>> | undefined
          if (include_automatic) {
            automatic = await automaticVocabulary(supabase, ctx).catch(() => [])
            if (opts.omitPrivate) automatic = automatic.filter((a) => a.kind === 'teammate' || a.kind === 'project')
          }
          return {
            success: true,
            words: terms.slice(0, 500).map(view),
            count: terms.length,
            ...(automatic ? { automatic: automatic.slice(0, 300), automatic_count: automatic.length } : {}),
          }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Could not read the vocabulary' }
        }
      },
    }),

    add_vocabulary_word: tool({
      description:
        "Add a word to the custom vocabulary so transcription spells it right, when the user asks (\"add Supabase to my vocabulary\", \"it keeps writing Superbase, it's Supabase\"). The term exactly as it should be written; sounds_like for spellings the engine produces that don't look like it (\"Superbase\", \"Guyan\" for Nguyen) — never ordinary words. Workspace scope by default (shared with the team); personal when the user says it is just for them. Adding a word that is already there merges it.",
      inputSchema: z.object({
        term: z.string().describe(`The word as it should be written (at most ${VOCABULARY_TERM_MAX_CHARS} characters), e.g. "Supabase", "Dial8", "RLS"`),
        sounds_like: z.array(z.string()).optional().describe('How transcription mishears or misspells it, e.g. ["Superbase"]'),
        scope: z.enum(['workspace', 'personal']).optional().default('workspace').describe('workspace (every member, default) or personal (just the user)'),
      }),
      execute: async ({ term, sounds_like, scope }) => {
        if (opts.unattended) return { success: false, error: ATTENDED_ONLY }
        const r = await addVocabularyTerm(supabase, { ...ctx, scope, term, soundsLike: sounds_like ?? [], source: 'agent' })
        if (!r.ok) return { success: false, error: r.message }
        return {
          success: true,
          created: r.created,
          word: view(r.term),
          message: r.created ? `Added ${r.term.term}. Transcripts and dictation will spell it that way.` : `${r.term.term} was already in the vocabulary; updated it.`,
        }
      },
    }),

    update_vocabulary_word: tool({
      description:
        "Change a vocabulary word by its id (from list_vocabulary), when the user asks: fix its spelling or sounds_like, move it between workspace and personal, or turn it off (status 'dismissed') or back on ('active').",
      inputSchema: z.object({
        id: z.string().describe("The word's id from list_vocabulary"),
        term: z.string().optional().describe('New spelling'),
        sounds_like: z.array(z.string()).optional().describe('Replaces the sounds-like list'),
        status: z.enum(['active', 'dismissed']).optional().describe('active: in use; dismissed: turned off'),
        scope: z.enum(['workspace', 'personal']).optional(),
      }),
      execute: async ({ id, term, sounds_like, status, scope }) => {
        if (opts.unattended) return { success: false, error: ATTENDED_ONLY }
        const r = await updateVocabularyTerm(supabase, { ...ctx, id, term, soundsLike: sounds_like, status, scope })
        if (!r.ok) return { success: false, error: r.message }
        return { success: true, word: view(r.term) }
      },
    }),

    delete_vocabulary_word: tool({
      description: 'Remove a word from the custom vocabulary by its id (from list_vocabulary), when the user asks.',
      inputSchema: z.object({ id: z.string().describe("The word's id from list_vocabulary") }),
      execute: async ({ id }) => {
        if (opts.unattended) return { success: false, error: ATTENDED_ONLY }
        const r = await deleteVocabularyTerm(supabase, { ...ctx, id })
        if (!r.ok) return { success: false, error: r.message }
        if (!r.deleted) return { success: false, error: 'That word is not in this workspace’s vocabulary' }
        return { success: true, deleted: true }
      },
    }),
  }
}
