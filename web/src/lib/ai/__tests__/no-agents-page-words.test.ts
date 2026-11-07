import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTools } from '../tools'
import { TOOL_CATEGORIES } from '../tool-registry'
import { TOOL_GUIDES } from '../tool-guides'
import { AREA_GUIDES } from '@/lib/packs/area-guides'
import { TOOL_FAMILIES } from '@/lib/packs/tool-families'
import { buildTeammateReport, teammateReportContextLine, type TeammateReportStatus } from '@/lib/chat/teammate-report'
import { renderHelperTask } from '@/lib/chat/start-helper'
import { runStartSection } from '@/lib/agent-run/run-work-spec-rebuild'

/**
 * Bots v4 Phase 7a: the Agents page (its "Needs you" lane) is going, so the
 * words the main chat agent and the work it delegates are given never send
 * anyone there again. A teammate's work is with its bot (its bubble and its
 * page), which the main agent reads with list_bot_work / get_bot_item.
 *
 * Checked: the chat agent's instructions, every tool description the main chat
 * can hold (the live tool set and the search_tools registry), the per-turn
 * "Teammate updates" lines, the delegated run's task and its "How this run
 * started", and the chat tool route's model-facing replies.
 *
 * Since Phase 7b the page is gone, so none of them names it at all ("the
 * Agents page"), not even as "until it goes".
 */
const PLACE = /\bNeeds you\b|Agents\s*(→|->)|\b[Aa]gents [Pp]age\b/

const stubSupabase = {} as unknown as SupabaseClient

function offenders(texts: Array<[string, string]>): string[] {
  return texts.filter(([, text]) => PLACE.test(text)).map(([where]) => where)
}

describe('the main agent is never sent to the Agents page (bots v4 Phases 7a and 7b)', () => {
  it('the chat agent instructions', () => {
    const md = readFileSync(join(process.cwd(), 'agents/chat-agent/instructions.md'), 'utf8').replace(/\s+/g, ' ')
    expect(md).not.toMatch(PLACE)
  })

  it('every tool description: the live tool set and the registry search_tools reads', () => {
    const tools = createTools('test-user', stubSupabase, 'test-workspace') as Record<string, { description?: string }>
    const live = Object.entries(tools).map(([name, t]): [string, string] => [`tool ${name}`, t.description ?? ''])
    const registry = TOOL_CATEGORIES.flatMap((c) => [
      [`category ${c.id}`, c.description] as [string, string],
      ...c.tools.map((t): [string, string] => [`registry ${t.name}`, t.description]),
    ])
    expect(live.length).toBeGreaterThan(50)
    // The usage notes a loaded tool adds (tool-guides.ts) and the areas' guides (area-guides.ts).
    const guides = [
      ...Object.entries(TOOL_GUIDES).map(([name, text]): [string, string] => [`guide ${name}`, text]),
      ...Object.entries(AREA_GUIDES).map(([area, text]): [string, string] => [`area guide ${area}`, text ?? '']),
      ...TOOL_FAMILIES.map((f): [string, string] => [`tool family ${f.key}`, f.guide]),
    ]
    expect(offenders([...live, ...registry, ...guides])).toEqual([])
  })

  it('the per-turn teammate lines, the delegated run’s prompt and the chat tool route’s replies', () => {
    const statuses: TeammateReportStatus[] = ['needs_review', 'needs_input', 'failed', 'canceled']
    const lines = statuses.flatMap((status) =>
      [true, false].map((withText): [string, string] => [
        `report ${status}`,
        teammateReportContextLine(
          buildTeammateReport({
            runId: 'run-1',
            workItemId: 'item-1',
            workspaceId: 'w1',
            status,
            teammateId: 'tm-1',
            teammateName: 'Quill',
            title: 'Q3 recap',
            deliverables: withText ? [{ type: 'document', id: 'doc-1', label: 'Q3 recap' }] : [],
            question: withText ? 'Fiscal or calendar?' : null,
            reason: withText ? 'No access' : null,
          }),
        ),
      ]),
    )
    const task = renderHelperTask({ task: 'Research Acme' })
    const route = readFileSync(join(process.cwd(), 'src/app/api/internal/chat/tool/route.ts'), 'utf8')
    const helper = readFileSync(join(process.cwd(), 'src/lib/chat/start-helper.ts'), 'utf8')
    expect(task).toContain('waits for their review')
    expect(
      offenders([
        ...lines,
        ['helper task', task],
        ['run start (chat)', runStartSection('chat')],
        ['chat tool route', route],
        ['start-helper', helper],
      ]),
    ).toEqual([])
  })
})
