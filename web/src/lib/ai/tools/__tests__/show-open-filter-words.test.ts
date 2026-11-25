/**
 * "Open actions" means unfinished: status_type none of completed AND canceled,
 * as My Actions filters them. The live check found `show` filtering "status
 * type is not Completed", which lists canceled work as open. The agent hears
 * the rule from show's filter description and from show's own note, which
 * carries what the standing instructions' "Showing things" used to
 * (docs/plans/goal-driven-main-agent.md §4; the actions playbook, migration
 * 319, already says it).
 */
import { describe, it, expect } from 'vitest'
import { showInputSchema } from '../show'
import { toolGuide } from '../../tool-guides'

describe('the open-actions filter, in the agent’s words', () => {
  it('show’s filter field says open = status_type none of completed and canceled', () => {
    const filters = showInputSchema.shape.filters
    const field = (filters.unwrap().element.shape.field as { description?: string }).description ?? ''
    expect(field).toMatch(/status_type is_none_of \["completed", "canceled"\]/)
  })

  it('show’s note, advertised with the tool from the start, says it too', () => {
    expect(toolGuide('show') ?? '').toMatch(/"Open" actions are unfinished ones: status_type none of\s+`completed` and `canceled`/)
  })
})
