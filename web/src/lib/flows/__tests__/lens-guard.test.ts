/**
 * Where a lens skill may be saved (F3 review S1, S10): only on a call
 * trigger, and the marketing lens only by an owner or admin.
 */
import { describe, it, expect } from 'vitest'
import { lensFakeDb } from './lens-fake-db'
import { lensStepRefusal } from '../lens-guard'
import { TRIAGE_SEED_KEY } from '../lens-plan'
import { SEED_KEYS } from '../seed-default-loops'
import type { FlowAction } from '../types'

const CONTENT = '8ef0cb7e-6c81-4da5-9deb-a967dc16aa30'
const MARKETING = 'b0a0af26-be52-493a-a2e4-ea0cb5b6cbbb'
const PLAIN = '11111111-1111-4111-8111-111111111111'

const step = (skill: string) => ({ type: 'run_skill', config: { skill_id: skill, mode: 'report' } }) as Pick<FlowAction, 'type' | 'config'>

function db(role: string) {
  return lensFakeDb({
    recipe: [
      { id: CONTENT, name: 'Content lens', category: 'skill', agent_config: { lens: 'content' } },
      { id: MARKETING, name: 'Marketing lens', category: 'skill', agent_config: { lens: 'marketing' } },
      { id: PLAIN, name: 'Weekly posts', category: 'skill', agent_config: {} },
    ],
    member: [{ workspace_id: 'ws', user_id: 'u', role }],
  }).client
}

const check = (role: string, triggerType: string, skill: string) => lensStepRefusal(db(role), { workspaceId: 'ws', userId: 'u', triggerType, actions: [step(PLAIN), step(skill)] })

describe('lensStepRefusal', () => {
  it('a lens skill only on a capture_processed trigger', async () => {
    expect(await check('member', 'capture_processed', CONTENT)).toBeNull()
    expect(await check('member', 'schedule', CONTENT)).toMatchObject({ index: 1, message: expect.stringMatching(/only runs on a capture_processed trigger/) })
  })

  it('the marketing lens only for an owner or admin (it edits the product doc)', async () => {
    expect(await check('member', 'capture_processed', MARKETING)).toMatchObject({ index: 1, message: expect.stringMatching(/only owners and admins can edit/) })
    expect(await check('admin', 'capture_processed', MARKETING)).toBeNull()
    expect(await check('owner', 'capture_processed', MARKETING)).toBeNull()
  })

  it('no lens: nothing to refuse, on any trigger', async () => {
    expect(await lensStepRefusal(db('member'), { workspaceId: 'ws', userId: 'u', triggerType: 'schedule', actions: [step(PLAIN)] })).toBeNull()
  })
})

it("lens-plan's inlined Triage seed key is the seeder's", () => {
  expect(TRIAGE_SEED_KEY).toBe(SEED_KEYS.triage)
})
