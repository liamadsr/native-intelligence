/**
 * The P9 cases, server side, in one place (the chat-side halves are eve
 * evals in evals/chat-agent/evals/: content/typefully-post-cards,
 * flows/weekly-posts-recipe, flows/newsletter-never-sends). Deterministic: no
 * model call.
 *
 *   1. A post always cards: publish_post / schedule_post are always the
 *      person's approval card; called without one they post nothing; an
 *      unattended caller is refused.
 *   2. A slow week gives ideas, not posts: the run is told to bring ideas, and
 *      every post it returns is carded as an idea.
 *   3. The newsletter recipe never calls a send tool: its one step writes a
 *      document, and no sending tool is in its skill's reach.
 *   4. The public-safe lint catches a private customer's name: a guest of the
 *      person's private call, in no CRM, withholds the post link and is
 *      refused from the weekly pass.
 */
import { describe, it, expect } from 'vitest'
import { outwardHoldOf } from '@/lib/safety/outward-gate'
import { decideAction } from '@/lib/safety/caller'
import { createContentTools } from '@/lib/ai/tools/content'
import { renderPostWeekBlock } from '../post-week'
import { parseConnectorOutput } from '@/lib/flows/output-connectors'
import { postCardCopy, postCardTitle } from '../post-draft'
import { recipeFlow } from '@/lib/flows/recipes'
import { computeSkillCeiling } from '@/lib/flows/run-skill'
import { checkPost } from '../post-check'
import { recentCallNames, forgetRecentCallNames } from '../recent-call-names'
import { lensFakeDb } from '@/lib/flows/__tests__/lens-fake-db'

describe('1. a post always cards', () => {
  it('every publish_post / schedule_post is held as the approval card, for the person', async () => {
    for (const tool of ['publish_post', 'schedule_post', 'dial8_publish_post']) {
      const hold = await outwardHoldOf({ workspaceId: 'ws', toolName: tool, input: { surface: 'x', text: 'We shipped it.' } })
      expect(hold?.reason, tool).toBe('public_post')
    }
    expect(decideAction('person', 'outward', 'publish_post')).toBe('ask')
  })

  it('an unattended run never gets one: refused, nobody is there to answer', () => {
    for (const caller of ['agent_unattended', 'other_person', 'unknown'] as const) expect(decideAction(caller, 'outward', 'publish_post'), caller).not.toBe('ask')
  })

  it('called without the person’s approval, it posts nothing', async () => {
    const tools = createContentTools('u-1', {} as never, 'ws-1')
    const out = await (tools.publish_post.execute as unknown as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)({ surface: 'x', text: 'Hi' }, { toolCallId: 'c', messages: [] })
    expect(out).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
  })
})

describe('2. a slow week gives ideas, not posts', () => {
  const slow = { surface: 'x' as const, moments: [], shipped: [], docs: [], brief: null, slots: 3, cadenceNote: null, slow: true, blockedPhrases: [], blockedWords: [] }

  it('the run is told to bring ideas, marked as ideas, never an empty week', () => {
    const block = renderPostWeekBlock(slow)
    expect(block).toMatch(/Never an empty week: bring 3 ideas instead, each marked `idea: true`/)
  })

  it('every post a slow week returns is an idea, and its card says so', () => {
    const out = parseConnectorOutput('post_drafts', { posts: [{ text: 'What is one meeting you would cancel forever?' }] }, { postPass: { slowWeek: true } })
    expect(out.ok && out.items[0].idea).toBe(true)
    expect(postCardTitle('What is one meeting you would cancel forever?', 'x', true)).toMatch(/^Idea for X:/)
    expect(postCardCopy({ post_draft: { text: 'x y z', idea: true } })?.details[0]).toContain('An idea, not this week’s work')
  })
})

describe('3. the newsletter recipe never calls a send tool', () => {
  it('one step, a document; the newsletter skill reaches no sending tool in any mode', () => {
    const r = recipeFlow('weekly_newsletter')
    if (r instanceof Error) throw r
    expect(r.actions.map((a) => [a.type, a.type === 'run_skill' ? a.deliver_to : undefined])).toEqual([['run_skill', 'document']])
    const cfg = { material: 'week_of_work', output_contract: 'prose' as const, enabled_tools: ['documents', 'actions', 'projects'] }
    for (const mode of ['report', 'act'] as const) {
      const ceiling = computeSkillCeiling(cfg, mode, false)!
      for (const tool of ['send_email', 'create_email_draft', 'create_campaign', 'enroll_contacts_in_sequence', 'publish_post', 'schedule_post']) expect(ceiling.has(tool), `${mode} ${tool}`).toBe(false)
    }
  })
})

describe('4. the public-safe lint catches a private customer’s name', () => {
  it('a guest of the person’s private call withholds the post link, and the weekly pass refuses the post', async () => {
    forgetRecentCallNames()
    const now = new Date('2026-10-20T09:00:00Z')
    const { client } = lensFakeDb({
      member: [{ id: 'm-1', workspace_id: 'ws-1', user_id: 'u-1' }],
      captures: [{ id: 'c-1', workspace_id: 'ws-1', user_id: 'u-1', visibility: 'private', is_eval: false, created_at: '2026-10-18T09:00:00Z' }],
      capture_participant: [{ capture_id: 'c-1', member_id: null, external_name: 'Priya Raman', contact_id: null, company: 'Hooli Robotics', is_self: false }],
    })
    const names = await recentCallNames(client, { workspaceId: 'ws-1', userId: 'u-1', now })
    const lint = checkPost({ surface: 'x', parts: ['Priya Raman told us onboarding finally clicked.'], sourceCount: 1, blockedPhrases: names })
    expect(lint.public_safe.ok).toBe(false)
    expect(lint.post_link).toBeNull()
    const pass = parseConnectorOutput('post_drafts', { posts: [{ text: 'Hooli Robotics moved their whole team over this week.' }] }, { blockedPhrases: names, postPass: { refuseNamed: true } })
    expect(pass.ok && pass.items).toEqual([])
  })
})
