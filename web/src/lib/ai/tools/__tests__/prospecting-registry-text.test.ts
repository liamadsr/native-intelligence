/**
 * The registry's prospecting text is what the model reads when it searches for
 * tools, so it has to state the rule the tools enforce: every tool that takes
 * `confirmed_with_user` refuses, running nothing, until it is true. It once
 * said each tool wanted "a restated price quote" and "SPENDS MONEY", two rules
 * the code dropped (and the chat never talks about money). This holds the
 * category and every tool line to the schemas.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TOOL_CATEGORIES } from '../../tool-registry'
import { createProspectingTools } from '../prospecting'

const category = TOOL_CATEGORIES.find((c) => c.id === 'prospecting')!
const tools = createProspectingTools('u', {} as unknown as SupabaseClient, 'w')

/** The prospecting tools whose input takes the go-ahead flag. */
const gated = Object.entries(tools)
  .filter(([, t]) => 'confirmed_with_user' in ((t.inputSchema as unknown as { shape?: object }).shape ?? {}))
  .map(([name]) => name)
  .sort()

/** Words the registry text must not use: it never talks about money. */
const MONEY = /\$\d|\b(budget|budgets|spend|spends|spent|money|cost|costs|price|prices|free|cap|caps|quote|quoted)\b/i

describe('the prospecting registry text', () => {
  it('lists every prospecting tool, and the gated ones are the searches, research, publish and dismiss', () => {
    expect(category.tools.map((t) => t.name).sort()).toEqual(Object.keys(tools).sort())
    expect(gated).toEqual([
      'dismiss_prospect_entries',
      'find_prospect_people',
      'find_prospects',
      'publish_prospect_list',
      'research_my_company',
      'research_prospect_companies',
      'run_prospect_discovery',
    ])
  })

  it('names confirmed_with_user on the category and on every gated tool', () => {
    expect(category.description).toContain('confirmed_with_user: true')
    expect(category.description).toMatch(/refuses and nothing runs/)
    // The category names every kind of gated call, dismiss included.
    expect(category.description).toContain("Searches, research, publish and dismiss need the person's yes first")
    for (const name of gated) {
      expect(category.tools.find((t) => t.name === name)!.description, name).toContain('confirmed_with_user')
    }
  })

  it('never talks about money', () => {
    expect(category.description).not.toMatch(MONEY)
    for (const t of category.tools) expect(t.description, t.name).not.toMatch(MONEY)
  })
})
