/**
 * Tool families (src/lib/packs/tool-families.ts): the packs for the main
 * agent's own tools of no area, which carry what their descriptions can't
 * (OpenAI's 1024-character limit).
 *
 * Pinned:
 *   1. a family's key is no area's (the chat-agent keys loaded packs by it),
 *      and the chat-agent's pack shape check accepts it;
 *   2. its tools are registry tools of no area, each in one family only, so
 *      a tool's first touch loads exactly one pack;
 *   3. the chat spec's packs carry every family, even when the area packs
 *      can't be read;
 *   4. what moved out of the always-on instructions is said in its family.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { getToolDefinition } from '@/lib/ai/tool-registry'
import { AREA_KEYS, areaForTool } from '../registry'
import { TOOL_FAMILIES, TOOL_FAMILY_KEYS, toolFamilyPack } from '../tool-families'
import { PACKS_VERSION, rebuildChatPacks } from '../chat-packs'
import { validPacks } from '../../../../agents/chat-agent/lib/expertise'

const family = (key: string) => TOOL_FAMILIES.find((f) => f.key === key)!.guide

describe('tool families', () => {
  it('a family key is never an area, and the chat-agent takes its pack', () => {
    expect(TOOL_FAMILIES.map((f) => f.key)).toEqual([...TOOL_FAMILY_KEYS])
    for (const key of TOOL_FAMILY_KEYS) expect((AREA_KEYS as readonly string[]).includes(key), key).toBe(false)
    const packs = validPacks(TOOL_FAMILIES.map(toolFamilyPack))
    expect(packs.map((p) => p.area)).toEqual([...TOOL_FAMILY_KEYS])
    for (const p of packs) expect(p.markdown.startsWith(`# ${p.name}\n\n- `), p.area).toBe(true)
  })

  it('its tools are registry tools of no area, each in one family', () => {
    const seen = new Set<string>()
    for (const f of TOOL_FAMILIES) {
      for (const name of f.toolNames) {
        expect(getToolDefinition(name), name).toBeDefined()
        expect(areaForTool(name), name).toBeNull()
        expect(seen.has(name), name).toBe(false)
        seen.add(name)
      }
    }
  })

  it('the chat spec carries every family, after the area packs', async () => {
    const supabase = makeFakeSupabase({ project: true }) as unknown as SupabaseClient
    const packs = await rebuildChatPacks(supabase, { workspaceId: 'ws-1', userId: 'u-1' }, [], {})
    expect(packs.slice(-TOOL_FAMILY_KEYS.length).map((p) => p.area)).toEqual([...TOOL_FAMILY_KEYS])
    expect(packs.some((p) => p.area === 'actions')).toBe(true)
  })

  it('the packs carry a version of their code-defined text, so a deploy that changes it reaches live conversations', () => {
    expect(PACKS_VERSION).toMatch(/^\d+:[0-9a-f]+$/)
  })

  it('what left the always-on instructions is said in its family', () => {
    const agents = family('agents')
    for (const part of ['`self`', '`without_bot`', '`unowned_cards`', '`asks_in_chat`', '`idle_bots`', '`states_unread`', '"Switched off"', '"Attempts paused"', '"Stopped by the AI limit"', '`settle_card`', '`revise_email_draft`', '`settle_work_item`', '`send_work_answer`', "this chat's workspace only", 'A bulk action they didn\'t spell out item by item', 'About → Customize', 'make a copy for this one first']) {
      expect(agents, part).toContain(part)
    }
    expect(family('helpers')).toContain('Work nobody is watching files such a step as a suggested action for the person to confirm, never as a confirmed one.')
    const local = family('local_agents')
    for (const part of ['One agent per folder', '`joined`', '`FOLDER_BUSY`', '`cloud_fallback`', 'up to 6 hours', 'never paste it', 'Agents (top right)', 'only ever opens a draft']) expect(local, part).toContain(part)
    const links = family('agent_links')
    for (const part of ['instead of telling the person to chase it', 'Approve and Decline', '`hand_off`', 'The invite is ready for your OK.']) expect(links, part).toContain(part)
  })
})
