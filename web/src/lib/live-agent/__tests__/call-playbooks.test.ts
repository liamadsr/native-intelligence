import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BUILT_IN_CALL_PLAYBOOKS,
  CALL_PLAYBOOK_HEADING,
  MAX_PLAYBOOK_BODY_CHARS,
  buildCallPlaybookSection,
  clearCallPlaybookCache,
  loadWorkspaceCallPlaybooks,
  matchCallPlaybook,
  mergeCallPlaybooks,
  playbookKey,
  readActivePlaybookName,
  renderCallPlaybookSection,
  saveActivePlaybookName,
  suggestPlaybookForCall,
  type CallPlaybook,
} from '@/lib/live-agent/call-playbooks'

const WS = 'ws-1'
const ME = 'user-1'

/** A chainable stand-in for the two reads and the one write the module makes. */
function fakeSupabase(opts: {
  recipes?: unknown[]
  recipeError?: unknown
  livePlaybook?: unknown
  captureError?: unknown
  updateError?: unknown
  throws?: boolean
}) {
  const calls = { recipeReads: 0, updates: [] as unknown[], recipeFilters: [] as string[] }
  const client = {
    from(table: string) {
      if (opts.throws) throw new Error('boom')
      if (table === 'recipe') {
        calls.recipeReads++
        const q = {
          select: () => q,
          eq: (col: string, val: string) => (calls.recipeFilters.push(`eq ${col} ${val}`), q),
          or: (f: string) => (calls.recipeFilters.push(`or ${f}`), q),
          not: () => q,
          order: (col: string) => (calls.recipeFilters.push(`order ${col}`), q),
          limit: async () => ({ data: opts.recipeError ? null : (opts.recipes ?? []), error: opts.recipeError ?? null }),
        }
        return q
      }
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: opts.captureError ? null : { live_playbook: opts.livePlaybook ?? null },
          error: opts.captureError ?? null,
        }),
        update: (row: unknown) => {
          calls.updates.push(row)
          return { eq: async () => ({ error: opts.updateError ?? null }) }
        },
      }
      return q
    },
  }
  return { sb: client as unknown as SupabaseClient, calls }
}

const recipe = (over: Record<string, unknown> = {}) => ({
  name: 'Board update',
  slug: 'board-update',
  description: 'Quarterly board meeting',
  system_prompt: 'Lead with the numbers.',
  visibility: 'workspace',
  created_by: 'someone',
  is_system: false,
  workspace_id: WS,
  agent_config: { live_playbook: true },
  ...over,
})

beforeEach(() => clearCallPlaybookCache())

describe('the built-in playbooks', () => {
  it('are investor-pitch, sales-call and discovery, each with a body', () => {
    expect(BUILT_IN_CALL_PLAYBOOKS.map((p) => p.name)).toEqual(['investor-pitch', 'sales-call', 'discovery'])
    for (const p of BUILT_IN_CALL_PLAYBOOKS) {
      expect(p.source).toBe('built_in')
      expect(p.description.length).toBeGreaterThan(20)
      expect(p.markdown.length).toBeGreaterThan(200)
    }
  })
})

describe('matchCallPlaybook', () => {
  it('matches the exact key, a spelling without hyphens, then a unique substring', () => {
    expect(matchCallPlaybook(BUILT_IN_CALL_PLAYBOOKS, 'investor-pitch')?.name).toBe('investor-pitch')
    expect(matchCallPlaybook(BUILT_IN_CALL_PLAYBOOKS, 'Investor Pitch')?.name).toBe('investor-pitch')
    expect(matchCallPlaybook(BUILT_IN_CALL_PLAYBOOKS, 'salescall')?.name).toBe('sales-call')
    expect(matchCallPlaybook(BUILT_IN_CALL_PLAYBOOKS, 'investor')?.name).toBe('investor-pitch')
  })

  it('returns null for nothing, an unknown name or an ambiguous one', () => {
    expect(matchCallPlaybook(BUILT_IN_CALL_PLAYBOOKS, '   ')).toBeNull()
    expect(matchCallPlaybook(BUILT_IN_CALL_PLAYBOOKS, 'board meeting')).toBeNull()
    expect(matchCallPlaybook(BUILT_IN_CALL_PLAYBOOKS, 'c')).toBeNull()
  })

  it('normalizes keys the same way the workspace loader does', () => {
    expect(playbookKey('  Sales_Call!! ')).toBe('sales-call')
  })
})

describe('suggestPlaybookForCall', () => {
  it('picks nothing without a brief, or when the goal alone ties ("Pitch Dial8")', () => {
    expect(suggestPlaybookForCall(null)).toBeNull()
    expect(suggestPlaybookForCall({ goal: 'Pitch Dial8', prep: null })).toBeNull()
  })

  it('picks investor-pitch when the prep shows an investor', () => {
    const prep = { documentId: 'd', title: 'Owen (Gaingels)', top: 'Venture scout for an angel syndicate.' }
    expect(suggestPlaybookForCall({ goal: 'Pitch Dial8', prep })).toBe('investor-pitch')
  })

  it('never picks from one common word that also means something else', () => {
    expect(suggestPlaybookForCall({ goal: 'Weekly sync: deal with hiring backlog and close out Q3 items', prep: null })).toBeNull()
    expect(suggestPlaybookForCall({ goal: 'Raise the hiring bar', prep: null })).toBeNull()
  })

  it('reads the goal on its own when it is clear', () => {
    expect(suggestPlaybookForCall({ goal: 'Close the deal on pricing', prep: null })).toBe('sales-call')
    expect(suggestPlaybookForCall({ goal: 'Discovery call with Acme', prep: null })).toBe('discovery')
    expect(suggestPlaybookForCall({ goal: 'Raise our seed round', prep: null })).toBe('investor-pitch')
  })
  describe('workspace playbooks, by name', () => {
    const ws = (name: string) => ({ name, description: 'd', markdown: 'm', source: 'workspace' as const })
    const renewal = ws('renewal-call')
    const demo = ws('enterprise-demo')

    it('a goal naming the playbook picks it, even over a built-in keyword it shares', () => {
      // "renewal" is also a sales-call word: the person's own name wins.
      expect(suggestPlaybookForCall({ goal: 'Renewal with Acme', prep: null }, [renewal])).toBe('renewal-call')
      expect(suggestPlaybookForCall({ goal: 'Enterprise demo for Acme', prep: null }, [demo])).toBe('enterprise-demo')
      expect(suggestPlaybookForCall({ goal: 'Q4 renewals review', prep: null }, [renewal])).toBe('renewal-call')
    })

    it('needs every distinctive word of the name', () => {
      expect(suggestPlaybookForCall({ goal: 'Enterprise roadmap sync', prep: null }, [demo])).toBeNull()
    })

    it('generic words in a name never pick it', () => {
      expect(suggestPlaybookForCall({ goal: 'Weekly call with the team', prep: null }, [ws('call-playbook')])).toBeNull()
    })

    it('the prep alone is not enough', () => {
      const prep = { documentId: 'd', title: 'Acme renewal', top: 'Contract ends in March.' }
      expect(suggestPlaybookForCall({ goal: null, prep }, [renewal])).toBeNull()
    })

    it('a workspace playbook replacing a built-in is picked by the built-in words', () => {
      expect(suggestPlaybookForCall({ goal: 'Raise our seed round', prep: null }, [ws('investor-pitch')])).toBe('investor-pitch')
    })

    it('ignores built-in entries in the list', () => {
      expect(suggestPlaybookForCall({ goal: 'Renewal with Acme', prep: null }, [{ ...renewal, source: 'built_in' }])).not.toBe('renewal-call')
    })
  })
})

describe('renderCallPlaybookSection', () => {
  it('renders nothing when there are no playbooks', () => {
    expect(renderCallPlaybookSection({ playbooks: [], active: null })).toBeNull()
  })

  it('with none active: the cards and the load_skill instruction', () => {
    const out = renderCallPlaybookSection({ playbooks: BUILT_IN_CALL_PLAYBOOKS, active: null })
    expect(out?.startsWith(CALL_PLAYBOOK_HEADING)).toBe(true)
    expect(out).toContain('load_skill')
    for (const p of BUILT_IN_CALL_PLAYBOOKS) expect(out).toContain(`- ${p.name}: ${p.description}`)
    // One Block 2 segment: no blank line inside it.
    expect(out).not.toContain('\n\n')
  })

  it('with one active: its body inline, and the others as cards to switch to', () => {
    const active = BUILT_IN_CALL_PLAYBOOKS[0]
    const out = renderCallPlaybookSection({ playbooks: BUILT_IN_CALL_PLAYBOOKS, active, activeSource: 'goal' })
    expect(out).toContain(active.markdown)
    expect(out).not.toContain(`- ${active.name}: ${active.description}`)
    expect(out).toContain(`- sales-call: `)
    expect(out).toContain(`- discovery: `)
  })
})

describe('a workspace-written playbook', () => {
  it('is fenced and told it never overrides the persona rules', () => {
    const mine: CallPlaybook = { name: 'board-update', description: 'Board', markdown: 'Lead with the numbers.', source: 'workspace' }
    const out = renderCallPlaybookSection({ playbooks: [...BUILT_IN_CALL_PLAYBOOKS, mine], active: mine, activeSource: 'loaded' })
    expect(out).toContain('<workspace_playbook>\nLead with the numbers.\n</workspace_playbook>')
    expect(out).toContain('never overrides your rules')
    // A built-in is ours and not fenced.
    const builtIn = renderCallPlaybookSection({ playbooks: BUILT_IN_CALL_PLAYBOOKS, active: BUILT_IN_CALL_PLAYBOOKS[0] })
    expect(builtIn).not.toContain('<workspace_playbook>')
  })
})

describe('mergeCallPlaybooks', () => {
  it('keeps the built-ins and lets a workspace playbook of the same name replace one', () => {
    const mine: CallPlaybook = { name: 'sales-call', description: 'Ours', markdown: 'Our way.', source: 'workspace' }
    const extra: CallPlaybook = { name: 'board-update', description: 'Board', markdown: 'B.', source: 'workspace' }
    const merged = mergeCallPlaybooks([mine, extra])
    expect(merged.map((p) => p.name).sort()).toEqual(['board-update', 'discovery', 'investor-pitch', 'sales-call'])
    expect(merged.find((p) => p.name === 'sales-call')).toBe(mine)
  })
})

describe('loadWorkspaceCallPlaybooks', () => {
  it('keeps only marked skills the caller can see, with a body', async () => {
    const { sb } = fakeSupabase({
      recipes: [
        recipe(),
        recipe({ slug: 'unmarked', agent_config: {} }),
        recipe({ slug: 'someone-elses', visibility: 'personal', created_by: 'other' }),
        recipe({ slug: 'my-own', visibility: 'personal', created_by: ME }),
        recipe({ slug: 'empty', system_prompt: '  ' }),
        recipe({ slug: 'other-ws', workspace_id: 'ws-2' }),
        recipe({ slug: 'system-one', is_system: true, workspace_id: null }),
      ],
    })
    const got = await loadWorkspaceCallPlaybooks(sb, { workspaceId: WS, userId: ME })
    expect(got.map((p) => p.name)).toEqual(['board-update', 'my-own', 'system-one'])
    expect(got.every((p) => p.source === 'workspace')).toBe(true)
  })

  it('filters, fences and orders in the query', async () => {
    const { sb, calls } = fakeSupabase({ recipes: [] })
    await loadWorkspaceCallPlaybooks(sb, { workspaceId: WS, userId: ME })
    expect(calls.recipeFilters).toEqual(
      expect.arrayContaining([
        'eq category skill',
        'eq agent_config->>live_playbook true',
        expect.stringContaining(`created_by.eq.${ME}`),
        'order is_system',
        'order sort_order',
      ]),
    )
  })

  it('keeps the first of two playbooks with the same name, and caps a long body', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of a very long playbook.`).join('\n')
    const { sb } = fakeSupabase({
      recipes: [recipe({ slug: 'discovery', system_prompt: 'First.' }), recipe({ slug: 'discovery', system_prompt: 'Second.' }), recipe({ slug: 'long', system_prompt: long })],
    })
    const got = await loadWorkspaceCallPlaybooks(sb, { workspaceId: WS, userId: ME })
    expect(got.map((p) => p.name)).toEqual(['discovery', 'long'])
    expect(got[0].markdown).toBe('First.')
    expect(got[1].markdown.length).toBeLessThanOrEqual(MAX_PLAYBOOK_BODY_CHARS + 60)
    expect(got[1].markdown).toContain('cut for length')
  })

  it('does not cache a failed read', async () => {
    const failing = fakeSupabase({ recipeError: { message: 'x' } })
    expect(await loadWorkspaceCallPlaybooks(failing.sb, { workspaceId: WS, userId: ME }, 0)).toEqual([])
    const ok = fakeSupabase({ recipes: [recipe()] })
    expect((await loadWorkspaceCallPlaybooks(ok.sb, { workspaceId: WS, userId: ME }, 1_000)).map((p) => p.name)).toEqual(['board-update'])
  })

  it('caches per workspace and person, then reads again once stale', async () => {
    const { sb, calls } = fakeSupabase({ recipes: [recipe()] })
    await loadWorkspaceCallPlaybooks(sb, { workspaceId: WS, userId: ME }, 0)
    await loadWorkspaceCallPlaybooks(sb, { workspaceId: WS, userId: ME }, 1_000)
    expect(calls.recipeReads).toBe(1)
    await loadWorkspaceCallPlaybooks(sb, { workspaceId: WS, userId: ME }, 60_000)
    expect(calls.recipeReads).toBe(2)
  })

  it('fails open to none on an error or a throw', async () => {
    expect(await loadWorkspaceCallPlaybooks(fakeSupabase({ recipeError: { message: 'x' } }).sb, { workspaceId: WS, userId: ME })).toEqual([])
    clearCallPlaybookCache()
    expect(await loadWorkspaceCallPlaybooks(fakeSupabase({ throws: true }).sb, { workspaceId: WS, userId: ME })).toEqual([])
  })
})

describe('the loaded playbook on the capture', () => {
  it('reads the name, and reads none on a missing column, a blank or a throw', async () => {
    expect(await readActivePlaybookName(fakeSupabase({ livePlaybook: ' sales-call ' }).sb, 'c')).toBe('sales-call')
    expect(await readActivePlaybookName(fakeSupabase({ livePlaybook: '' }).sb, 'c')).toBeNull()
    expect(await readActivePlaybookName(fakeSupabase({ captureError: { code: '42703' } }).sb, 'c')).toBeNull()
    expect(await readActivePlaybookName(fakeSupabase({ throws: true }).sb, 'c')).toBeNull()
  })

  it('saves the name, and reports a failed write instead of throwing', async () => {
    const ok = fakeSupabase({})
    expect(await saveActivePlaybookName(ok.sb, 'c', 'investor-pitch')).toBe(true)
    expect(ok.calls.updates).toEqual([{ live_playbook: 'investor-pitch' }])
    expect(await saveActivePlaybookName(fakeSupabase({ updateError: { message: 'x' } }).sb, 'c', 'x')).toBe(false)
    expect(await saveActivePlaybookName(fakeSupabase({ throws: true }).sb, 'c', 'x')).toBe(false)
  })
})

describe('buildCallPlaybookSection', () => {
  const args = { workspaceId: WS, userId: ME, captureId: 'c' }
  const investorPrep = { documentId: 'd', title: 'Owen (Gaingels)', top: 'Venture scout.' }

  it('a loaded playbook wins over the goal', async () => {
    const { sb } = fakeSupabase({ livePlaybook: 'discovery' })
    const out = await buildCallPlaybookSection(sb, { ...args, brief: { goal: 'Pitch Dial8', prep: investorPrep } })
    expect(out).toContain(BUILT_IN_CALL_PLAYBOOKS[2].markdown)
  })

  it('without one, the goal and prep pick it', async () => {
    const { sb } = fakeSupabase({})
    const out = await buildCallPlaybookSection(sb, { ...args, brief: { goal: 'Pitch Dial8', prep: investorPrep } })
    expect(out).toContain(BUILT_IN_CALL_PLAYBOOKS[0].markdown)
  })

  it('with nothing to go on, the cards (the same text the no-goal turn renders)', async () => {
    const { sb } = fakeSupabase({})
    const out = await buildCallPlaybookSection(sb, { ...args, brief: null })
    expect(out).toBe(renderCallPlaybookSection({ playbooks: BUILT_IN_CALL_PLAYBOOKS, active: null }))
  })
})
