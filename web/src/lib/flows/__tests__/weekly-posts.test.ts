/**
 * The weekly post pass's output (P9, content C1): a slow week's posts are
 * ideas whatever the run says, the cadence budget caps the posts and the
 * cards waiting, a post naming someone from the person's calls is refused,
 * and the moments a delivered post drew on are marked used.
 */
import { describe, it, expect } from 'vitest'
import { parseConnectorOutput, connectorInstruction, validateDeliverConnector, type ValidPostDraft } from '../output-connectors'
import { deliverConnectorItems } from '../deliver-connector'
import { postCardCopy, postDraftFromPayload } from '@/lib/content/post-draft'

const posts = (...p: Array<Record<string, unknown>>) => ({ posts: p })

describe('parsing a weekly pass', () => {
  it('a slow week: every post is an idea, even one the run did not mark', () => {
    const out = parseConnectorOutput('post_drafts', posts({ text: 'What is the one meeting you would cancel forever?' }, { text: 'Small teams ship faster when they write things down.', idea: true }), {
      postPass: { slowWeek: true, maxPosts: 3, refuseNamed: true },
    })
    expect(out.ok && out.items.map((i) => i.idea)).toEqual([true, true])
  })

  it('a week with material keeps the run’s own marks, and the moments each post used', () => {
    const out = parseConnectorOutput('post_drafts', posts({ text: 'We shipped calendar sync this week.', uses: ['m1', ' M2 ', 'bogus'] }, { text: 'An idea about focus time.', idea: true }), {
      postPass: { slowWeek: false, maxPosts: 3 },
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.items[0]).toMatchObject({ uses: ['m1', 'm2'] })
    expect(out.items[0].idea).toBeUndefined()
    expect(out.items[1].idea).toBe(true)
  })

  it('the cadence caps the posts a run delivers (1 to 5)', () => {
    const many = posts(...['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((t) => ({ text: `${t} thing we learned.` })))
    const two = parseConnectorOutput('post_drafts', many, { postPass: { maxPosts: 2 } })
    expect(two.ok && two.items.length).toBe(2)
    expect(two.ok && two.refused).toContain('more than 2 posts')
    const five = parseConnectorOutput('post_drafts', many, { postPass: { maxPosts: 9 } })
    expect(five.ok && five.items.length).toBe(5)
    // Without a pass, the old default holds.
    const plain = parseConnectorOutput('post_drafts', many)
    expect(plain.ok && plain.items.length).toBe(3)
  })

  it('never a private customer’s name: a post naming someone from the person’s calls is refused, not carded', () => {
    const out = parseConnectorOutput('post_drafts', posts({ text: 'Great call with Northwind today about onboarding.' }, { text: 'Onboarding is a product problem, not a docs problem.' }), {
      blockedPhrases: ['northwind'],
      postPass: { refuseNamed: true },
    })
    expect(out.ok && out.items.map((i) => i.text)).toEqual(['Onboarding is a product problem, not a docs problem.'])
    expect(out.ok && out.refused).toEqual(['a post that names someone from outside the workspace'])
    // A one-word CRM company, as written.
    const word = parseConnectorOutput('post_drafts', posts({ text: 'Hooli switched to us this week.' }), { postPass: { refuseNamed: true, blockedWords: ['Hooli'] } })
    expect(word.ok && word.items).toEqual([])
  })

  it('the weekly instruction never asks for an empty list', () => {
    expect(connectorInstruction('post_drafts', { surface: 'x', weekly: true })).toContain('Never an empty week')
    expect(connectorInstruction('post_drafts', { surface: 'x', weekly: true })).not.toContain('Nothing worth posting means an empty list')
    expect(connectorInstruction('post_drafts', { surface: 'x' })).toContain('Nothing worth posting means an empty list')
  })

  it('slots are stored on the loop: whole numbers 1 to 5', () => {
    expect(validateDeliverConnector({ to: 'post_drafts', slots: 2 })).toEqual({ to: 'post_drafts', surface: 'x', slots: 2 })
    expect(validateDeliverConnector({ to: 'post_drafts', slots: 6 })).toBeInstanceOf(Error)
    expect(validateDeliverConnector({ to: 'post_drafts', slots: 1.5 })).toBeInstanceOf(Error)
    expect(validateDeliverConnector({ to: 'post_drafts' })).toEqual({ to: 'post_drafts', surface: 'x' })
  })
})

/** insert_post_draft_card as migration 397 defines it; lens_finding updates recorded. */
function fakeClient(openPosts = 0) {
  const cards: Array<Record<string, unknown>> = []
  const updates: Array<{ table: string; patch: Record<string, unknown>; ids: unknown[] }> = []
  let open = openPosts
  let caps: number[] = []
  const client = {
    rpc: async (_name: string, args: { p_card: Record<string, unknown>; p_cap: number }) => {
      caps.push(args.p_cap)
      if (open >= args.p_cap) return { data: 'full', error: null }
      cards.push(args.p_card)
      open++
      return { data: 'inserted', error: null }
    },
    from: (table: string) => {
      const q: Record<string, unknown> = {}
      let patch: Record<string, unknown> = {}
      let ids: unknown[] = []
      Object.assign(q, {
        update: (p: Record<string, unknown>) => ((patch = p), q),
        eq: () => q,
        in: (_k: string, v: unknown[]) => {
          ids = v
          updates.push({ table, patch, ids })
          return Promise.resolve({ error: null })
        },
      })
      return q
    },
  }
  return { client: client as never, cards, updates, caps: () => caps }
}

const ctx = { workspaceId: 'ws-1', runAsUserId: 'u-1', memberId: 'm-1', runKey: 'fire-1', flowId: 'flow-1', captureId: null, captureTitle: null, skillName: 'Weekly posts', readOutside: false }
const item = (text: string, extra: Partial<ValidPostDraft> = {}): ValidPostDraft => ({ text, chars: text.length, limit: 280, based_on: null, notes: [], ...extra })

describe('delivering a weekly pass', () => {
  it('a slow week’s ideas: titled as ideas, marked on the card, and the summary says ideas', async () => {
    const { client, cards } = fakeClient()
    const out = await deliverConnectorItems('post_drafts', [item('What would you stop doing if you had half the team?', { idea: true })], { ...ctx, supabase: client, surface: 'x', postCap: 3 })
    expect(out.summary).toBe('1 X idea for you')
    expect(cards[0].title).toBe('Idea for X: “What would you stop doing if you had half the team?”')
    expect(cards[0].why).toBe('An idea for a slow week, not this week’s work')
    const draft = postDraftFromPayload(cards[0].payload)
    expect(draft?.idea).toBe(true)
    const copy = postCardCopy(cards[0].payload)
    expect(copy?.sentence.startsWith('an idea on X:')).toBe(true)
    expect(copy?.details[0]).toContain('An idea, not this week’s work')
  })

  it('caps the cards waiting at the loop’s slots, and marks the moments a delivered post used', async () => {
    const { client, cards, updates, caps } = fakeClient(1)
    const out = await deliverConnectorItems(
      'post_drafts',
      [item('We shipped calendar sync.', { uses: ['m1'] }), item('Time zones are hard.', { uses: ['m2'] })],
      { ...ctx, supabase: client, surface: 'x', postCap: 2, momentIds: { m1: 'f-1', m2: 'f-2' }, cadenceNote: 'Fewer this week.' },
    )
    expect(caps()).toEqual([2, 2])
    expect(cards).toHaveLength(1)
    expect(out.refused).toEqual(['2 posts are already waiting'])
    // Only the delivered post's moment is spent; the refused one's stays open.
    expect(updates).toEqual([{ table: 'lens_finding', patch: expect.objectContaining({ status: 'used' }), ids: ['f-1'] }])
    expect(out.summary).toBe('1 X post for you. Fewer this week.')
  })

  it('a post card that is not an idea reads as before', () => {
    const copy = postCardCopy({ post_draft: { text: 'We shipped calendar sync.', surface: 'x', chars: 25, limit: 280 } })
    expect(copy?.sentence).toBe('on X: “We shipped calendar sync.”')
    expect(postDraftFromPayload({ post_draft: { text: 'x' } })?.idea).toBe(false)
  })
})
