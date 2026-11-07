/**
 * content_review (content C0): P1's draft_review on a post surface. The
 * reviewer reads only the post, under the house rubric plus the post rubric,
 * on another vendor; a thread is read whole with its parts numbered.
 */
import { describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ reviewDraft: vi.fn(async () => ({ verdict: 'ready', issues: [], model: 'claude-haiku-4-5-20251001' })) }))
vi.mock('@/lib/writing/review', () => ({ reviewDraft: hoisted.reviewDraft }))

import { reviewPost, reviewText } from '../review'
import { draftReviewInstructions } from '@/lib/eve/utility/prompts'
import { HOUSE_WRITING_RULES_FULL, POST_RULES_FULL } from '@/lib/writing/rules'

describe('content_review', () => {
  it('the reviewer of a post reads the house rubric and the post rubric; an email reviewer only the house one', () => {
    for (const surface of ['x', 'linkedin', 'threads', 'bluesky']) {
      const prompt = draftReviewInstructions(surface)
      expect(prompt, surface).toContain(POST_RULES_FULL)
      expect(prompt, surface).toMatch(/verdict "ready"/)
      // The house rubric, with the bare-URL link rule for plain text.
      expect(prompt, surface).toContain('ai_tell:')
    }
    expect(draftReviewInstructions('email')).not.toContain(POST_RULES_FULL)
    expect(HOUSE_WRITING_RULES_FULL).not.toContain('public_safe:')
  })

  it('a thread is read whole, numbered; a single post as it is', () => {
    expect(reviewText(['One idea.'])).toBe('One idea.')
    expect(reviewText(['First.', ' ', 'Second.'])).toBe('[1/2]\nFirst.\n\n[2/2]\nSecond.')
  })

  it('runs draft_review on the post surface with the writer’s model, marked as the content pass', async () => {
    await reviewPost({ surface: 'x', parts: ['A post.'], writerModel: 'deepseek/deepseek-v4-flash', userId: 'u1', workspaceId: 'ws-1' })
    expect(hoisted.reviewDraft).toHaveBeenCalledWith({ surface: 'x', text: 'A post.', writerModel: 'deepseek/deepseek-v4-flash', userId: 'u1', workspaceId: 'ws-1', pass: 'content_review' })
  })
})
