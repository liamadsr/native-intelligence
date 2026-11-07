import { describe, it, expect } from 'vitest'
import { agentRunTarget } from '@/components/work/work-item-detail-panel'
import { cardForTarget } from '@/lib/chat-cards/open-card'

/**
 * "Open run" on a work item backed by an agent run opens the ACTION's record
 * card on its Cloud-run section (section:'cloud') — the canonical run surface
 * (P5: every way in opens a card). agentRunTarget is the pure routing
 * decision; these tests lock it.
 */

function run(over: Partial<Parameters<typeof agentRunTarget>[0]> = {}) {
  return {
    id: 'run-1',
    action_id: 'action-7',
    action_identifier: 'GEN-42',
    title: 'Draft the follow-up',
    ...over,
  }
}

describe('agentRunTarget — work item → action Cloud-run view', () => {
  it('opens the action’s record card on its Cloud-run section', () => {
    const t = agentRunTarget(run())
    expect(t).toEqual({ kind: 'card', target: { type: 'action', id: 'action-7', title: 'GEN-42', section: 'cloud' } })
    if (t.kind !== 'card') throw new Error('expected card')
    expect(cardForTarget(t.target)?.spec).toMatchObject({ kind: 'record', record: { type: 'action', id: 'action-7', section: 'cloud' } })
  })

  it('prefers the action identifier as the title, falling back to the run title', () => {
    const withId = agentRunTarget(run({ action_identifier: 'ENG-9', title: 'x' }))
    if (withId.kind !== 'card') throw new Error('expected card')
    expect(withId.target).toMatchObject({ title: 'ENG-9' })

    const noId = agentRunTarget(run({ action_identifier: null, title: 'Draft the follow-up' }))
    if (noId.kind !== 'card') throw new Error('expected card')
    expect(noId.target).toMatchObject({ title: 'Draft the follow-up' })
  })

  it('falls back to the standalone run page ONLY when there is no action', () => {
    const t = agentRunTarget(run({ action_id: null }))
    expect(t).toEqual({ kind: 'url', url: '/account/agent-runs/run-1' })
  })
})
