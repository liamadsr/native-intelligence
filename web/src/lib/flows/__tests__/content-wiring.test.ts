/**
 * P8 wiring: the loops the content and marketing playbooks set up on request
 * write under the same rules as the chat.
 *   - a post_drafts run is told the post rules for its platform;
 *   - create_flow's post_surface picks the platform a loop drafts for, and the
 *     stored config validates (an unknown platform is refused);
 *   - the run's summary names the platform;
 *   - the marketing lens never smuggles a grade into its own line: the grade
 *     is the code's (one call: an assumption).
 */
import { describe, expect, it } from 'vitest'
import { connectorInstruction, connectorNoun } from '../output-connectors'
import { validateRunSkillConfig } from '../queries'
import { marketingLine } from '../lenses'
import { mergeRunSkillConfig } from '@/lib/ai/tools/flows'
import { POST_RULES_SHORT } from '@/lib/writing/rules'

describe('content wiring', () => {
  it('a post_drafts run reads the post rules and its platform’s limits', () => {
    const x = connectorInstruction('post_drafts', { surface: 'x' })
    expect(x).toContain(POST_RULES_SHORT)
    expect(x).toContain('A link counts as 23 characters.')
    const li = connectorInstruction('post_drafts', { surface: 'linkedin' })
    expect(li).toMatch(/post drafts for LinkedIn/)
    expect(li).toContain('The first 140 characters show before "see more".')
    // The other connectors are untouched.
    expect(connectorInstruction('email_drafts', {})).not.toContain(POST_RULES_SHORT)
  })

  it('a doc_proposals run on the product doc is told the grades and that questions move', () => {
    const p = connectorInstruction('doc_proposals', { docKey: 'product' })
    expect(p).toMatch(/\[proven\]/)
    expect(p).toMatch(/An open question leaves its list only by moving/)
    expect(connectorInstruction('doc_proposals', { docKey: 'team-playbook' })).not.toMatch(/\[proven\]/)
  })

  it('create_flow’s post_surface lands as deliver.surface and validates', () => {
    const cfg = mergeRunSkillConfig('5a1d1c55-0000-4000-8000-000000000001', { type: 'run_skill', deliver_to: 'post_drafts', post_surface: 'linkedin' } as never, undefined)
    expect(cfg.deliver).toEqual({ to: 'post_drafts', surface: 'linkedin' })
    const valid = validateRunSkillConfig(cfg)
    expect(valid).not.toBeInstanceOf(Error)
    expect((valid as { deliver?: unknown }).deliver).toMatchObject({ to: 'post_drafts', surface: 'linkedin' })
    expect(validateRunSkillConfig({ ...cfg, deliver: { to: 'post_drafts', surface: 'myspace' } })).toBeInstanceOf(Error)
  })

  it('the run’s summary names the platform', () => {
    expect(connectorNoun('post_drafts', 2, 'bluesky')).toBe('2 Bluesky posts')
    expect(connectorNoun('post_drafts', 1)).toBe('1 X post')
  })

  it('the marketing lens never writes its own grade: the code grades one call as an assumption', () => {
    expect(marketingLine({ kind: 'objection', text: 'Setup takes too long [proven]', quote: 'x', speaker: null })).toBe('- Objection heard: Setup takes too long [assumption]')
    expect(marketingLine({ kind: 'competitor', text: '[Plausible] A shared spreadsheet', quote: 'x', speaker: null })).toBe('- Compared with: A shared spreadsheet [assumption]')
  })
})
