/**
 * The work bots on the Assistant's face move off it (bots-v4 decision 7,
 * scripts/backfill-assistant-face.ts): each to its workspace's next free
 * character that is nobody's starting face (any free face only when those are
 * worn), renamed to match when it still carries the face's name and nobody
 * there goes by the new one, oldest first, two never landing on one face;
 * anyone else on `chat` is left alone unless asked for.
 */
import { describe, it, expect } from 'vitest'
import { FREE_BOT_CHARACTER_ORDER, ROLE_TEAMMATE_FACES, SYSTEM_TEAMMATE_FACES } from '../teammate-faces'
import { ASSISTANT_FACE, MOVE_ORDER, planAssistantFaceBackfill, type FaceBackfillTeammate } from '../assistant-face-backfill'

let seq = 0
function mate(over: Partial<FaceBackfillTeammate> & { id: string }): FaceBackfillTeammate {
  seq += 1
  return {
    workspace_id: 'ws-1',
    name: 'Assistant',
    bot_character: 'chat',
    fronts_only: true,
    is_system: false,
    created_at: `2026-10-03T00:00:${String(seq % 60).padStart(2, '0')}Z`,
    ...over,
  }
}

describe('the order a moved bot’s face is picked in', () => {
  it('skips the reserved face and every role’s and system teammate’s starting face', () => {
    expect(ASSISTANT_FACE).toBe('chat')
    for (const face of [...Object.values(ROLE_TEAMMATE_FACES), ...Object.values(SYSTEM_TEAMMATE_FACES)]) expect(MOVE_ORDER).not.toContain(face)
    // Since migration 318 the folded faces (Reconciler, Extraction) are nobody's starting face.
    expect(MOVE_ORDER[0]).toBe('reconciler')
    expect(MOVE_ORDER).toEqual(FREE_BOT_CHARACTER_ORDER.filter((f) => MOVE_ORDER.includes(f)))
  })
})

describe('planAssistantFaceBackfill', () => {
  it('moves a work bot named for the face to the first free face nobody starts on, renamed after it', () => {
    const plan = planAssistantFaceBackfill([
      mate({ id: 'assistant', is_system: true, fronts_only: false }),
      mate({ id: 'captures', is_system: true, fronts_only: false, bot_character: 'triage', name: 'Captures' }),
      mate({ id: 'old-bot' }),
    ])
    // `research` is free, but a Researcher starts on it.
    expect(plan.moves).toEqual([{ id: 'old-bot', workspaceId: 'ws-1', fromName: 'Assistant', toFace: 'reconciler', toName: 'Reconciler', workBot: true }])
    expect(plan.stuck).toEqual([])
    expect(plan.others).toEqual([])
  })

  it('never moves the Assistant itself, nor onto `chat`, and keeps a name someone chose', () => {
    const plan = planAssistantFaceBackfill([
      mate({ id: 'assistant', is_system: true, fronts_only: false }),
      mate({ id: 'pipeline', name: 'Pipeline bot' }),
    ])
    expect(plan.moves).toEqual([{ id: 'pipeline', workspaceId: 'ws-1', fromName: 'Pipeline bot', toFace: 'reconciler', toName: null, workBot: true }])
    expect(plan.moves.every((m) => m.toFace !== 'chat')).toBe(true)
  })

  it('keeps the old name when another teammate there already goes by the new one', () => {
    const plan = planAssistantFaceBackfill([mate({ id: 'old-bot' }), mate({ id: 'person', fronts_only: false, bot_character: 'xabafbba', name: 'reconciler ' })])
    expect(plan.moves).toEqual([{ id: 'old-bot', workspaceId: 'ws-1', fromName: 'Assistant', toFace: 'reconciler', toName: null, workBot: true }])
  })

  it('moves several in one workspace oldest first, each to its own face and name', () => {
    const plan = planAssistantFaceBackfill([
      mate({ id: 'b', created_at: '2026-10-03T00:00:02Z' }),
      mate({ id: 'a', created_at: '2026-10-03T00:00:01Z', name: ' assistant ' }),
      mate({ id: 'sprout-bot', bot_character: 'sprout', name: 'Sprout' }),
    ])
    expect(plan.moves.map((m) => [m.id, m.toFace, m.toName])).toEqual([
      ['a', 'reconciler', 'Reconciler'],
      ['b', 'extraction', 'Extraction'],
    ])
  })

  it('plans each workspace on its own roster', () => {
    const plan = planAssistantFaceBackfill([
      mate({ id: 'w1-bot', workspace_id: 'ws-1' }),
      mate({ id: 'w2-bot', workspace_id: 'ws-2' }),
      mate({ id: 'w2-worn', workspace_id: 'ws-2', bot_character: 'reconciler', name: 'Reconciler' }),
    ])
    expect(plan.moves.map((m) => [m.workspaceId, m.id, m.toFace])).toEqual([
      ['ws-1', 'w1-bot', 'reconciler'],
      ['ws-2', 'w2-bot', 'sprout'],
    ])
  })

  it('takes a starting face only when every other face is worn, and stays put when every face is', () => {
    const others = MOVE_ORDER.map((face, i) => mate({ id: `worn-${i}`, bot_character: face, name: face }))
    const fallback = planAssistantFaceBackfill([...others, mate({ id: 'late' })])
    expect(fallback.moves).toEqual([{ id: 'late', workspaceId: 'ws-1', fromName: 'Assistant', toFace: 'research', toName: 'Research', workBot: true }])

    const full = FREE_BOT_CHARACTER_ORDER.map((face, i) => mate({ id: `full-${i}`, bot_character: face, name: face }))
    const plan = planAssistantFaceBackfill([...full, mate({ id: 'stuck' }), mate({ id: 'person-made', fronts_only: false, name: 'Riley' })])
    expect(plan.moves).toEqual([])
    expect(plan.stuck).toEqual([{ id: 'stuck', workspaceId: 'ws-1', name: 'Assistant' }])
    expect(plan.others).toEqual([{ id: 'person-made', workspaceId: 'ws-1', name: 'Riley' }])
  })

  it('leaves teammates people made on `chat` alone, and moves them by the same rules when asked to', () => {
    const roster = [
      mate({ id: 'riley', fronts_only: false, name: 'Riley', created_at: '2026-09-01T00:00:00Z' }),
      mate({ id: 'old-bot', created_at: '2026-10-03T00:00:00Z' }),
    ]
    expect(planAssistantFaceBackfill(roster)).toEqual({
      moves: [{ id: 'old-bot', workspaceId: 'ws-1', fromName: 'Assistant', toFace: 'reconciler', toName: 'Reconciler', workBot: true }],
      stuck: [],
      others: [{ id: 'riley', workspaceId: 'ws-1', name: 'Riley' }],
    })
    expect(planAssistantFaceBackfill(roster, { includeOthers: true }).moves).toEqual([
      { id: 'riley', workspaceId: 'ws-1', fromName: 'Riley', toFace: 'reconciler', toName: null, workBot: false },
      { id: 'old-bot', workspaceId: 'ws-1', fromName: 'Assistant', toFace: 'sprout', toName: 'Sprout', workBot: true },
    ])
  })

  it('a built bot or no face never counts as being on `chat`', () => {
    const plan = planAssistantFaceBackfill([mate({ id: 'built', bot_character: 'xabafbba' }), mate({ id: 'none', bot_character: null })])
    expect(plan).toEqual({ moves: [], stuck: [], others: [] })
  })
})
