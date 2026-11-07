/**
 * content_review: the fresh-eyes review of one post (content C0;
 * content-skill-set.md §2 row 4, eve-templates-lessons.md §3b P1). It is P1's
 * `draft_review` on a post surface: the reviewer gets only the surface and the
 * draft, never the chat, the sources or the writer's prompt, and its rubric is
 * the house rubric plus the post rubric (writingRulesFor on a post surface:
 * hook, one idea, concrete, bait, hedging, public-safety). It runs on another
 * vendor than the writer (decision 13: pickReviewerModel; the spec route
 * refuses a token that breaks it) and answers `ready` or `revise`, each issue
 * quoting the words it is about.
 *
 * A thread is reviewed as one text, its parts separated by a blank line and
 * numbered, so the reviewer can judge the first part standing alone.
 *
 * Throws when the review can't run (no other vendor, a failed session); the
 * caller reports no review and keeps the draft.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { reviewDraft, type DraftReview } from '@/lib/writing/review'
import type { PostSurface } from './post-draft'

export interface ReviewPostArgs {
  surface: PostSurface
  parts: readonly string[]
  /** The model that wrote it (the chat turn's), from the authenticated envelope: never from the model. */
  writerModel: string
  userId: string
  workspaceId: string
  supabase?: SupabaseClient
  /** The person runs on their own ChatGPT plan: the review runs on it (reviewDraft's chatgptPlan). */
  chatgptPlan?: boolean
}

/** The text the reviewer reads: a single post as it is, a thread's parts numbered. Pure. */
export function reviewText(parts: readonly string[]): string {
  const kept = parts.map((p) => p.trim()).filter(Boolean)
  return kept.length > 1 ? kept.map((p, i) => `[${i + 1}/${kept.length}]\n${p}`).join('\n\n') : (kept[0] ?? '')
}

/** Review one post (or thread). See the module doc. */
export async function reviewPost(args: ReviewPostArgs): Promise<DraftReview> {
  return reviewDraft({
    surface: args.surface,
    text: reviewText(args.parts),
    writerModel: args.writerModel,
    userId: args.userId,
    workspaceId: args.workspaceId,
    pass: 'content_review',
    ...(args.supabase ? { supabase: args.supabase } : {}),
    ...(args.chatgptPlan ? { chatgptPlan: true } : {}),
  })
}
