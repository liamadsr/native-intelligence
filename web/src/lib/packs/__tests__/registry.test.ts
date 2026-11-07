import { describe, it, expect } from 'vitest'
import { TOOL_CATEGORIES, CHAT_NATIVE_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { FEATURE_KEYS } from '@/lib/editions/manifest'
import {
  AREA_KEYS,
  NO_AREA_TOOL_GROUPS,
  NO_AREA_TOOL_NAMES,
  PACKS,
  areaForCard,
  areaForTool,
  areasForToolGroups,
  areasForToolNames,
  parseSkillArea,
  playbookSlug,
  toolNamesForArea,
} from '../registry'

describe('pack registry', () => {
  it('has the 16 page areas plus content and marketing (P8), each keyed by itself and gated by a real feature', () => {
    expect(AREA_KEYS).toHaveLength(18)
    expect(AREA_KEYS.slice(16)).toEqual(['content', 'marketing'])
    // No page of their own: gated with core, so every workspace can ask for them.
    expect(PACKS.content.feature).toBe('core')
    expect(PACKS.marketing.feature).toBe('core')
    for (const key of AREA_KEYS) {
      expect(PACKS[key].key).toBe(key)
      expect(FEATURE_KEYS).toContain(PACKS[key].feature)
      expect(PACKS[key].name.length).toBeGreaterThan(0)
    }
  })

  it('places every tool group exactly once: in one pack, or deliberately in none', () => {
    const owners = new Map<string, string[]>()
    for (const key of AREA_KEYS) for (const g of PACKS[key].toolGroups) owners.set(g, [...(owners.get(g) ?? []), key])
    for (const category of TOOL_CATEGORIES) {
      const inPacks = owners.get(category.id) ?? []
      const inNone = NO_AREA_TOOL_GROUPS.includes(category.id)
      expect(inPacks.length + (inNone ? 1 : 0), `tool group ${category.id}`).toBe(1)
    }
    // No pack names a group the registry doesn't have.
    const real = new Set(TOOL_CATEGORIES.map((c) => c.id))
    for (const g of owners.keys()) expect(real.has(g), g).toBe(true)
  })

  it('keeps the bot relay and background-work tools out of Actions', () => {
    for (const name of NO_AREA_TOOL_NAMES) expect(areaForTool(name), name).toBeNull()
    for (const name of CHAT_NATIVE_TOOL_NAMES) expect(areaForTool(name), name).toBeNull()
    expect(toolNamesForArea('actions')).not.toContain('list_bot_work')
    expect(toolNamesForArea('actions')).toContain('create_action')
  })

  it('maps tools to their area, cross-cutting ones to none', () => {
    expect(areaForTool('list_emails')).toBe('mail')
    expect(areaForTool('revise_email_draft')).toBe('mail')
    expect(areaForTool('get_calendar_events')).toBe('calendar')
    expect(areaForTool('get_meeting_prep')).toBe('calendar')
    expect(areaForTool('list_captures')).toBe('captures')
    expect(areaForTool('confirm_decision')).toBe('captures')
    expect(areaForTool('start_cycle')).toBe('projects')
    expect(areaForTool('find')).toBeNull()
    expect(areaForTool('get_dashboard_summary')).toBeNull()
    expect(areaForTool('search_tools')).toBeNull()
    expect(areaForTool('no_such_tool')).toBeNull()
  })

  it('lists distinct areas in first-seen order', () => {
    expect(areasForToolNames(['list_emails', 'read_email', 'get_calendar_events', 'find'])).toEqual(['mail', 'calendar'])
    expect(areasForToolGroups(['emails', 'contacts', 'search'])).toEqual(['mail', 'crm'])
  })

  it('finds a card’s area by kind and entity type', () => {
    expect(areaForCard({ kind: 'calendar' })).toBe('calendar')
    expect(areaForCard({ kind: 'mail' })).toBe('mail')
    expect(areaForCard({ kind: 'list', entity_type: 'action' })).toBe('actions')
    expect(areaForCard({ kind: 'board', entity_type: 'action' })).toBe('actions')
    expect(areaForCard({ kind: 'list', entity_type: 'email_thread' })).toBe('mail')
    expect(areaForCard({ kind: 'record', record_type: 'contact' })).toBe('crm')
    expect(areaForCard({ kind: 'list' })).toBeNull()
    expect(areaForCard({ kind: 'nope' })).toBeNull()
    // Whole pages (pages in the chat, P3): each loads its area; the inbox and
    // teams pages are no area's, and the browser page retired (cloud browser C5).
    const pages: Record<string, string | null> = {
      team_board: 'actions', sequences: 'sequences', prospecting: 'prospecting', flows: 'flows', evals: 'evals',
      campaigns: 'campaigns', knowledge: 'knowledge', library: 'library', browser: null, inbox: null, teams: null,
    }
    for (const [kind, area] of Object.entries(pages)) expect(areaForCard({ kind }), kind).toBe(area)
  })

  it('names playbooks <area>-playbook', () => {
    expect(playbookSlug('mail')).toBe('mail-playbook')
    expect(playbookSlug('calendar')).toBe('calendar-playbook')
  })
})

describe('parseSkillArea (the skills API)', () => {
  it('leaves the field alone when absent, clears on null or empty, sets an area', () => {
    expect(parseSkillArea(undefined)).toEqual({ ok: true, area: undefined })
    expect(parseSkillArea(null)).toEqual({ ok: true, area: null })
    expect(parseSkillArea('')).toEqual({ ok: true, area: null })
    expect(parseSkillArea('mail')).toEqual({ ok: true, area: 'mail' })
  })

  it('refuses anything else with an error that lists the valid areas', () => {
    for (const bad of ['Mail', 'inbox', 3, ['mail'], { area: 'mail' }]) {
      const result = parseSkillArea(bad)
      expect(result.ok, String(bad)).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('calendar, actions, captures')
        expect(result.error).toContain('or null for none')
      }
    }
  })
})
