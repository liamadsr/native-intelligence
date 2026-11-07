/**
 * "Open actions" means unfinished: status_type none of completed AND canceled,
 * as My Actions filters them. The live check found `show` filtering "status
 * type is not Completed", which lists canceled work as open. The agent hears
 * the rule from show's filter description and its "Showing things" guidance
 * (the actions playbook, migration 319, already says it).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { showInputSchema } from '../show'

describe('the open-actions filter, in the agent’s words', () => {
  it('show’s filter field says open = status_type none of completed and canceled', () => {
    const filters = showInputSchema.shape.filters
    const field = (filters.unwrap().element.shape.field as { description?: string }).description ?? ''
    expect(field).toMatch(/status_type is_none_of \["completed", "canceled"\]/)
  })

  it('the chat agent’s Showing things guidance says it too', () => {
    const md = readFileSync(join(process.cwd(), 'agents/chat-agent/instructions.md'), 'utf8')
    const showing = md.slice(md.indexOf('Showing things:'))
    expect(showing).toMatch(/none of\s+`completed` and `canceled`/)
  })
})
