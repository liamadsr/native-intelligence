/**
 * The plan's rules live in four places the bundlers can't share: the app's one
 * writer (src/lib/work/plan.ts), the chat agent's native tool
 * (agents/chat-agent/lib/plan.ts) and the work-agent and skill-runner tools'
 * schemas. This keeps them equal (limits, statuses, the validator's answers),
 * pins the one tool name every side uses, and pins that `update_plan` is no
 * registry tool, so it never reaches createTools, the write-verb rule or MCP.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('eve/context', () => ({ defineState: () => ({ get: () => null, update: () => {} }) }))

import * as app from '@/lib/work/plan'
import { TOOL_REGISTRY_MAP } from '@/lib/ai/tool-registry'
import * as chat from '../plan'
import * as work from '../../../work-agent/tools/update_plan'
import * as skill from '../../../skill-runner/tools/update_plan'

const repo = join(__dirname, '../../../..')

describe('plan drift', () => {
  it('every side has the same limits and statuses', () => {
    for (const side of [chat, work, skill]) {
      expect(side.PLAN_MAX_STEPS).toBe(app.PLAN_MAX_STEPS)
      expect(side.PLAN_STEP_MAX_CHARS).toBe(app.PLAN_STEP_MAX_CHARS)
      expect([...side.PLAN_STEP_STATUSES]).toEqual([...app.PLAN_STEP_STATUSES])
    }
  })

  it('the chat’s Plan widget goes stale when the recitation does', () => {
    expect(chat.PLAN_STALE_TURNS).toBe(app.PLAN_STALE_TURNS)
    expect(chat.PLAN_STALE_MS).toBe(app.PLAN_STALE_MS)
  })

  it('the chat agent’s validator answers exactly as the app’s', () => {
    const cases: unknown[] = [
      undefined,
      'steps',
      [],
      [{ text: 'a', status: 'pending' }],
      [{ text: '  two\n words ', status: 'done' }],
      [{ text: '', status: 'pending' }],
      [{ text: 'x'.repeat(140), status: 'skipped' }],
      [{ text: 'x'.repeat(141), status: 'pending' }],
      [{ text: 'a', status: 'blocked' }],
      [null],
      [{ text: 'a', status: 'in_progress' }, { text: 'b', status: 'in_progress' }],
      Array.from({ length: 12 }, (_, i) => ({ text: `s${i}`, status: 'pending' })),
      Array.from({ length: 13 }, (_, i) => ({ text: `s${i}`, status: 'pending' })),
    ]
    for (const c of cases) expect(chat.validatePlanSteps(c), JSON.stringify(c)).toEqual(app.validatePlanSteps(c))
  })

  it('one tool name everywhere: the chat agent, the chat’s renderer, the skill-runner and its route', () => {
    expect(chat.UPDATE_PLAN_TOOL_NAME).toBe('update_plan')
    expect(skill.UPDATE_PLAN_TOOL_NAME).toBe('update_plan')
    const renderers = readFileSync(join(repo, 'src/app/account/(dashboard)/chat/chat-widgets-model.ts'), 'utf8')
    expect(renderers).toContain("export const UPDATE_PLAN_TOOL_NAME = 'update_plan'")
    const route = readFileSync(join(repo, 'src/app/api/internal/skill-run/tool/route.ts'), 'utf8')
    expect(route).toContain("const UPDATE_PLAN_TOOL_NAME = 'update_plan'")
  })

  it('update_plan is no registry tool: never a createTools proxy, never on MCP, never under the write-verb rule', () => {
    expect(TOOL_REGISTRY_MAP.has('update_plan')).toBe(false)
  })
})
