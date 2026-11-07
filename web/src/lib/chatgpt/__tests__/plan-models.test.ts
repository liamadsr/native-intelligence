import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAT_MODELS, gatewayModelSlug } from '@/lib/ai/models'
import { SURFACE_MODELS } from '@/lib/ai/model-defaults'
import { PLAN_MODELS, backgroundPlanSpec, chatGptPlanSpec, isChatGptPlanUsage, planModelFromSlug, planModelLabel, planModelOfStep, planModelSlug } from '../plan-models'

describe('plan models', () => {
  it('reads the plan model off a step slug, and nothing else', () => {
    expect(planModelFromSlug('chatgpt-plan/gpt-6.1-sol')).toBe('gpt-6.1-sol')
    expect(planModelFromSlug('openai/gpt-6.1-sol')).toBeNull()
    expect(planModelFromSlug('gateway/deepseek/deepseek-v4-flash')).toBeNull()
    expect(planModelFromSlug('chatgpt-plan/')).toBeNull()
    expect(planModelFromSlug(null)).toBeNull()
  })

  it("reads a reported step's plan model under either name eve gives it", () => {
    expect(planModelOfStep('chatgpt-plan/gpt-6-luna')).toBe('gpt-6-luna')
    expect(planModelOfStep('openai/gpt-6.1-sol')).toBe('gpt-6.1-sol')
    expect(planModelOfStep('openai/gpt-5.6-sol')).toBeNull()
    expect(planModelOfStep('gateway/openai/gpt-6.1-sol')).toBeNull()
    expect(planModelOfStep('deepseek/deepseek-v4-flash')).toBeNull()
    expect(planModelOfStep(null)).toBeNull()
  })

  // planModelOfStep bills `openai/<plan model>` as the person's plan, at no
  // cost. That is right only while no Gateway model Dial8 runs is one.
  it('names no plan model among the Gateway models Dial8 runs', () => {
    const gateway = [
      ...CHAT_MODELS.flatMap((m) => [m.id, m.gatewayId, gatewayModelSlug(m.id)]),
      ...Object.values(SURFACE_MODELS).flatMap((id) => [id, gatewayModelSlug(id)]),
    ]
    for (const id of gateway) {
      expect(planModelOfStep(id), id).toBeNull()
      expect(PLAN_MODELS.has(id.split('/').at(-1) ?? id), id).toBe(false)
    }
  })

  // The same rule over the code itself: a plan model written as a Gateway
  // slug (`openai/gpt-6.1-sol`) anywhere a model is chosen would be billed as
  // the plan's. Plan selections build `openai/${model}` from a plan, never a literal.
  it('names no plan model as a Gateway slug anywhere in the app or the agents', () => {
    const root = join(__dirname, '../../../..')
    const literal = /['"`]openai\/(gpt-6\.1-sol|gpt-6-luna)['"`]/
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(name) && literal.test(readFileSync(path, 'utf8'))) offenders.push(path.slice(root.length + 1))
      }
    }
    walk(join(root, 'src'))
    walk(join(root, 'agents'))
    expect(offenders).toEqual([])
  })

  it('puts a person on their plan for an active or out-of-credits check only', () => {
    expect(isChatGptPlanUsage({ reason: 'chatgpt_plan' })).toBe(true)
    expect(isChatGptPlanUsage({ reason: 'chatgpt_plan_exhausted' })).toBe(true)
    expect(isChatGptPlanUsage({ reason: 'chatgpt_plan_unsupported' })).toBe(false)
    expect(isChatGptPlanUsage({ reason: 'within_limits' })).toBe(false)
    expect(isChatGptPlanUsage(undefined)).toBe(false)
  })

  it('runs Sol always, thinking harder on Think, with Luna for helpers', () => {
    expect(chatGptPlanSpec('fast')).toEqual({ model: 'gpt-6.1-sol', helperModel: 'gpt-6-luna', reasoning: 'low' })
    expect(chatGptPlanSpec('think')).toEqual({ model: 'gpt-6.1-sol', helperModel: 'gpt-6-luna', reasoning: 'medium' })
    expect(planModelLabel('gpt-6.1-sol')).toBe('GPT-6.1 Sol')
  })

  it('runs background work (work, loop and live agents) on Luna, thinking harder unless Fast', () => {
    expect(backgroundPlanSpec('think')).toEqual({ model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'medium' })
    expect(backgroundPlanSpec('strong')).toEqual({ model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'medium' })
    expect(backgroundPlanSpec('fast')).toEqual({ model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'low' })
    expect(planModelFromSlug(planModelSlug('gpt-6-luna'))).toBe('gpt-6-luna')
  })
})
