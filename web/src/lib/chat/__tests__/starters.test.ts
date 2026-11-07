/**
 * The first-run starters: a small set, sales first, two plain prompts an area,
 * and only the areas that are on in the workspace.
 */
import { describe, expect, it } from 'vitest'
import { getEdition, withEffectiveSurface } from '@/lib/editions/manifest'
import { STARTER_AREAS, startersFor } from '../starters'
import { personalToolsFor } from '@/lib/chat-cards/page-menu'

describe('first-run starters', () => {
  it('leads with sales, then the everyday areas', () => {
    expect(STARTER_AREAS.map((a) => a.id)).toEqual(['prospecting', 'crm', 'sequences', 'calendar', 'mail', 'actions', 'captures', 'knowledge'])
  })

  it('keeps to two short, whole requests an area', () => {
    for (const area of STARTER_AREAS) {
      expect(area.prompts, area.id).toHaveLength(2)
      for (const prompt of area.prompts) {
        expect(prompt.length, prompt).toBeLessThanOrEqual(50)
        // A whole request: nothing to fill in.
        expect(prompt, prompt).not.toMatch(/[<[{]|\.\.\./)
      }
    }
  })

  it('offers every area in a full workspace', () => {
    expect(startersFor(getEdition('full')).map((a) => a.id)).toEqual(STARTER_AREAS.map((a) => a.id))
  })

  it('offers only the areas whose feature is on', () => {
    const notes = withEffectiveSurface(getEdition('full'), { prospecting: 'off', sequences: 'off', crm: 'off', email: 'off' })
    expect(startersFor(notes).map((a) => a.id)).toEqual(['calendar', 'actions', 'captures', 'knowledge'])
  })

  it('shows calendar and mail starters only where the chat may read them', () => {
    const ids = (chat: Parameters<typeof personalToolsFor>[0]) => startersFor(getEdition('full'), personalToolsFor(chat)).map((a) => a.id)
    expect(ids({ bot: false, agent: null })).toEqual(expect.arrayContaining(['calendar', 'mail']))
    expect(ids({ bot: false, agent: { disabled_tools: ['list_emails'] } })).not.toContain('mail')
    expect(ids({ bot: false, agent: { disabled_tools: ['list_emails'] } })).toContain('calendar')
    expect(ids({ bot: true, agent: null })).not.toEqual(expect.arrayContaining(['calendar']))
  })
})

describe('a service business’s starters (its edition’s words)', () => {
  const service = getEdition('service')

  it('asks about today’s jobs and customers, not prospects, in its own order', () => {
    const areas = startersFor(service)
    expect(areas.map((a) => a.id)).toEqual(['actions', 'calendar', 'crm', 'captures', 'mail'])
    expect(areas[0].prompts).toEqual(['What jobs do I have today?', 'What’s still open this week?'])
    expect(areas.flatMap((a) => a.prompts).join(' ')).not.toMatch(/prospect|sequence|ideal customer/i)
  })

  it('keeps to the same short, whole requests', () => {
    for (const area of startersFor(service)) {
      expect(area.prompts, area.id).toHaveLength(2)
      for (const prompt of area.prompts) {
        expect(prompt.length, prompt).toBeLessThanOrEqual(50)
        expect(prompt, prompt).not.toMatch(/[<[{]|\.\.\./)
      }
    }
  })

  it('keeps each area’s own gates: a feature off, and calendar and mail only where the chat may read them', () => {
    expect(startersFor(withEffectiveSurface(service, { crm: 'off' })).map((a) => a.id)).not.toContain('crm')
    const ids = startersFor(service, personalToolsFor({ bot: true, agent: null })).map((a) => a.id)
    expect(ids).not.toContain('calendar')
    expect(ids).not.toContain('mail')
  })
})
