/**
 * The content tools (content C0; docs/plans/content-skill-set.md §2 rows 3-5,
 * §6 C0): the craft checks on a post the agent drafts in the chat. Neither
 * posts anything: Dial8 never publishes for the person (decision 2). The
 * person posts from the link, on the platform's own page.
 *
 *   lint_post     the deterministic check (src/lib/content/post-check.ts): the
 *                 house and post rules, the surface's limits counted its way,
 *                 the public-safe screen over the text and its sources, and
 *                 that it cites what it rests on (or is marked an idea). Its
 *                 post link comes only once the screen passes. No model call.
 *   review_post   content_review: lint_post's check, then a fresh-eyes review
 *                 on another vendor (src/lib/content/review.ts), `ready` or
 *                 `revise` with quoted issues. Attended only: the person's own
 *                 chat, where the writer's model rides the authenticated
 *                 envelope (never the model's input). Without it, or past the
 *                 usage meter, the check comes back with no review and says why.
 *   publish_post  (C2a, P9) post it now through the person's own Typefully, and
 *   schedule_post into their Typefully queue (next free slot). The narrow
 *                 tools in front of Typefully (content/typefully.ts): the model
 *                 never sees Typefully's own tools for this. Each runs ONLY as
 *                 an approved call: the outward gate holds every call of them
 *                 as the person's approval card (outward-gate.ts, "posts always
 *                 card", decision 2), and a post card's Typefully button is the
 *                 person's own click (settle-card.ts). Called any other way, it
 *                 refuses and nothing is posted. The public-safe screen runs
 *                 again right before it posts.
 *
 * Service-role client on the tool proxies: every read is scoped to the
 * session workspace (post-sources.ts).
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkUsageLimits } from '@/lib/ai/auth'
import { isChatGptPlanUsage } from '@/lib/chatgpt/plan-models'
import { CANON_SOURCE_KINDS, normalizeCanonSources } from '@/lib/documents/canon-sources'
import { checkPost, type PostCheck } from '@/lib/content/post-check'
import { POST_SURFACES } from '@/lib/content/post-draft'
import { screenPostSources } from '@/lib/content/post-sources'
import { reviewPost } from '@/lib/content/review'
import { sendToTypefully, type TypefullyWhen } from '@/lib/content/typefully'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import { wrapUntrusted } from '@/lib/email/untrusted'

/** A writer model id as the envelope may carry it (a bare id or a Gateway slug). */
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._:/-]{0,99}$/i

/** The writer's model, when the envelope carried a plausible one. Pure. */
export function validWriterModel(value: unknown): string | null {
  return typeof value === 'string' && MODEL_ID_RE.test(value.trim()) ? value.trim() : null
}

/**
 * The reviewer's issues as the chat model reads them: severity and rule as
 * fields, the quote and the fix inside one untrusted-content marker, so a
 * reviewer output that carries instructions is data, never an order. Pure.
 */
export function fenceIssues(issues: ReadonlyArray<{ severity: string; rule: string; quote: string; fix: string }>): Array<{ severity: string; rule: string; note: string }> {
  return issues.map((i) => ({
    severity: i.severity,
    rule: i.rule,
    note: wrapUntrusted(`quote: ${i.quote}\nfix: ${i.fix}`, 'WORKSPACE') ?? '',
  }))
}

export interface ContentToolContext {
  /** The model that wrote the draft (the chat turn's), from the authenticated envelope. Absent: no review. */
  writerModel?: string | null
  /** An unattended run: its checks leave out the person's recent-call names (they are the person's own reading, P9 review nit). */
  unattended?: boolean
  /** Set only when replaying the person's accepted approval (approvals.ts executeStoredCall): the one way publish_post / schedule_post run. */
  approvedCall?: ApprovedCall
}

/** The two posting tools and how each sends (P9, C2a). */
export const POST_SEND_TOOLS = { publish_post: 'now', schedule_post: 'next_free_slot' } as const satisfies Record<string, TypefullyWhen>
export type PostSendTool = keyof typeof POST_SEND_TOOLS

export function isPostSendTool(name: string): name is PostSendTool {
  return Object.hasOwn(POST_SEND_TOOLS, name.replace(/^dial8_/, ''))
}

const sendInput = z.object({
  surface: z.enum(POST_SURFACES).optional().default('x').describe('The platform: x (default), linkedin, threads or bluesky, as their Typefully has it connected'),
  text: z.string().max(6_000).optional().describe('The post exactly as it goes out. For a thread, use `parts` instead'),
  parts: z.array(z.string().max(3_000)).min(2).max(25).optional().describe('A thread: its posts in order'),
  account_id: z.union([z.string(), z.number()]).optional().describe('Set only by a post card; ignored from the chat (your only account posts)'),
  account: z.string().optional().describe('Set only by a post card; ignored from the chat'),
})

const postInput = z.object({
  surface: z.enum(POST_SURFACES).optional().default('x').describe('Where it will be posted: x (default), linkedin, threads or bluesky'),
  text: z.string().max(6_000).optional().describe('The post. For a thread, use `parts` instead'),
  parts: z.array(z.string().max(3_000)).min(2).max(25).optional().describe('A thread: its posts in order (X, Threads and Bluesky)'),
  sources: z
    .array(
      z.object({
        kind: z.enum(CANON_SOURCE_KINDS).describe('action (shipped work), project, document, capture (a call), claim or chat (by id where it has one); a web page may be named but never counts as the citation; never email'),
        id: z.string().optional().describe('The row id (action, project, document, capture, claim)'),
        url: z.string().optional().describe('A public web page'),
        note: z.string().optional().describe('Which part: "ENG-42 shipped", "Tue product call, Liam on onboarding"'),
      }),
    )
    .max(10)
    .optional()
    .describe('What the post rests on: every fact in it comes from one of these'),
  idea: z.boolean().optional().describe('True for an idea not grounded in their recent work (a slow week): say so to the person'),
})

type PostInput = z.infer<typeof postInput>

function partsOf(input: PostInput): string[] {
  return input.parts?.length ? input.parts : input.text ? [input.text] : []
}

export function createContentTools(userId: string, supabase: SupabaseClient, workspaceId: string, ctx: ContentToolContext = {}) {
  async function check(input: PostInput): Promise<PostCheck> {
    const sources = normalizeCanonSources(input.sources ?? [])
    const screen = await screenPostSources(supabase, workspaceId, sources, ctx.unattended ? {} : { userId })
    return checkPost({
      surface: input.surface,
      parts: partsOf(input),
      // Only sources found in this workspace count toward "it cites something".
      sourceCount: screen.verifiedCount,
      idea: input.idea,
      blockedPhrases: screen.blockedPhrases,
      blockedWords: screen.blockedWords,
      sourceProblems: screen.problems,
      ownPricingSource: screen.ownPricingSource,
    })
  }

  return {
    lint_post: tool({
      description:
        'Check a post you drafted before you show it: the house writing rules and the platform\'s own (length counted its way, links, hashtags, bait), the public-safe screen over the text and what it rests on, and that it cites its sources. ' +
        'No model call: run it on every version. Returns what to fix, and once the screen passes, `post_link`: the platform\'s compose page with the text filled in. ' +
        'Nothing is posted: the person posts it there themselves.',
      inputSchema: postInput,
      execute: async (input) => {
        if (!partsOf(input).length) return { success: false as const, error: 'Pass the post as `text`, or a thread as `parts`.' }
        return { success: true as const, ...(await check(input)) }
      },
    }),

    review_post: tool({
      description:
        'The fresh-eyes review of a finished post (content_review): lint_post\'s check, then a reviewer on another model vendor reads only the post and judges hook, one idea, concreteness, bait, hedging and public-safety. ' +
        'Returns `verdict` ready or revise with quoted issues and fixes. Run it once on the version you mean to show, fix what it finds (keep every fact and source), and check again with lint_post. ' +
        'Nothing is posted.',
      inputSchema: postInput,
      execute: async (input) => {
        const parts = partsOf(input)
        if (!parts.length) return { success: false as const, error: 'Pass the post as `text`, or a thread as `parts`.' }
        const checked = await check(input)
        const base = { success: true as const, ...checked }
        const writerModel = validWriterModel(ctx.writerModel)
        if (!writerModel) return { ...base, review: null, review_skipped: 'Not reviewed: only the chat can ask for a review. The deterministic check above still holds.' }
        // Opted in to the ChatGPT free tier: a person on their own plan gets
        // the review too, on the plan's other model (reviewDraft's chatgptPlan).
        let chatgptPlan = false
        try {
          const usage = await checkUsageLimits(userId, undefined, { chatgptPlan: true })
          if (usage?.allowed !== true) return { ...base, review: null, review_skipped: 'Not reviewed: the AI usage limit is reached. The deterministic check above still holds.' }
          chatgptPlan = isChatGptPlanUsage(usage)
        } catch {
          return { ...base, review: null, review_skipped: 'Not reviewed: the usage meter could not be read. The deterministic check above still holds.' }
        }
        try {
          const review = await reviewPost({ surface: input.surface, parts, writerModel, userId, workspaceId, supabase, chatgptPlan })
          // The reviewer's notes quote a draft written from workspace text: fenced as data for the chat model (review nit).
          return { ...base, review: { verdict: review.verdict, issues: fenceIssues(review.issues) } }
        } catch (err) {
          console.warn(`[content] review_post: no review: ${err instanceof Error ? err.message : String(err)}`)
          return { ...base, review: null, review_skipped: 'Not reviewed: the reviewer could not run. The deterministic check above still holds.' }
        }
      },
    }),

    publish_post: sendTool('publish_post'),
    schedule_post: sendTool('schedule_post'),
  }

  /**
   * publish_post / schedule_post (see the header). A call that isn't the
   * person's approved one never reaches Typefully: in the chat the outward
   * gate has already turned it into their approval card; anywhere else it is
   * refused here.
   */
  function sendTool(name: PostSendTool) {
    const when = POST_SEND_TOOLS[name]
    return tool({
      description:
        name === 'publish_post'
          ? 'Post it now on their own account through their Typefully (only once Typefully is connected: check list_connections). Never runs in the turn: it always becomes the person\'s approval card, saying exactly what goes out, and posts once when they accept. Only when they ask for it to go out through Typefully.'
          : 'Put it in their Typefully queue for their next free slot (only once Typefully is connected: check list_connections). Never runs in the turn: it always becomes the person\'s approval card, and goes into the queue once when they accept. Only when they ask for it to be scheduled.',
      inputSchema: sendInput,
      execute: async (input) => {
        if (ctx.approvedCall?.tool !== name) {
          return {
            success: false as const,
            code: 'APPROVAL_REQUIRED',
            error: `Nothing was posted. ${name} only runs from the person's own approval (their card, or a post card's Typefully button).`,
          }
        }
        const parts = input.parts?.length ? input.parts : input.text ? [input.text] : []
        if (!parts.length) return { success: false as const, error: 'Nothing to post: the held call has no text.' }
        // The public-safe screen once more, right before it goes out: never a
        // name from the person's calls (recent-call-names.ts), a price, a deal.
        const screen = await screenPostSources(supabase, workspaceId, [], { userId })
        const checked = checkPost({ surface: input.surface, parts, sourceCount: 1, blockedPhrases: screen.blockedPhrases, blockedWords: screen.blockedWords, sourceProblems: screen.problems })
        if (!checked.public_safe.ok) {
          return { success: false as const, code: 'NOT_PUBLIC_SAFE', error: `Nothing was posted: ${checked.public_safe.problems[0]?.reason ?? 'it is not public-safe'} ("${checked.public_safe.problems[0]?.quote ?? ''}").` }
        }
        // The account a post card resolved and showed is honoured; one a model
        // named in the chat never is (the chat's card doesn't show it): there
        // the person's only account posts, and several is NEEDS_ACCOUNT.
        const accountId = ctx.approvedCall?.postCard === true ? (input.account_id ?? null) : null
        return sendToTypefully(supabase, { userId, surface: input.surface, parts, when, accountId })
      },
    })
  }
}
