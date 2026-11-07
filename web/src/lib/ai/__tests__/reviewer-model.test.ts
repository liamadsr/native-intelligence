/**
 * pickReviewerModel (src/lib/ai/reviewer-model.ts): the reviewer is always a
 * different vendor from the writer (eve-alignment.md §6 decision 13).
 */
import { describe, expect, it } from 'vitest'
import { ALLOWED_MODELS, CHAT_MODELS, DEFAULT_MODEL, PREMIUM_MODELS, STRONG_MODEL } from '../models'
import { SURFACE_MODELS } from '../model-defaults'
import { REVIEWER_CANDIDATES, differentPlanModels, differentVendors, modelVendor, pickReviewerModel, planReviewerModel } from '../reviewer-model'

describe('pickReviewerModel', () => {
  it('never returns the writer’s vendor, for every model the app runs, by id or by Gateway slug', () => {
    for (const model of CHAT_MODELS) {
      for (const writer of [model.id, model.gatewayId]) {
        const reviewer = pickReviewerModel(writer)
        expect(modelVendor(reviewer), `${writer} → ${reviewer}`).not.toBe(model.provider)
        expect(differentVendors(reviewer, writer), writer).toBe(true)
      }
    }
  })

  it('never returns the writer’s vendor for any surface’s fixed model', () => {
    for (const [surface, model] of Object.entries(SURFACE_MODELS)) {
      expect(differentVendors(pickReviewerModel(model), model), surface).toBe(true)
    }
  })

  it('DeepSeek writes (the drafting default) → Haiku 4.5 reviews; Anthropic writes → Flash reviews', () => {
    expect(pickReviewerModel(DEFAULT_MODEL)).toBe('claude-haiku-4-5-20251001')
    expect(pickReviewerModel('deepseek-v4-pro')).toBe('claude-haiku-4-5-20251001')
    expect(pickReviewerModel(STRONG_MODEL)).toBe('deepseek-v4-flash')
    expect(pickReviewerModel('anthropic/claude-sonnet-5.5')).toBe('deepseek-v4-flash')
  })

  it('a writer outside CHAT_MODELS still gets another vendor: by its slug prefix, else by its name', () => {
    for (const writer of ['openai/gpt-5', 'google/gemini-3-pro', 'moonshotai/kimi-k3', 'gpt-6', 'gemini-4', 'o3-mini']) {
      expect(modelVendor(pickReviewerModel(writer)), writer).toBe('anthropic')
    }
    for (const writer of ['anthropic/claude-opus-5', 'claude-opus-9', 'CLAUDE-NEXT', ' deepseek/deepseek-v9 ']) {
      const reviewer = pickReviewerModel(writer)
      expect(differentVendors(reviewer, writer), writer).toBe(true)
    }
  })

  it('an unknown writer gets the first candidate; nothing unknown counts as "different"', () => {
    expect(pickReviewerModel('mystery-model')).toBe(REVIEWER_CANDIDATES[0])
    expect(pickReviewerModel(undefined)).toBe(REVIEWER_CANDIDATES[0])
    expect(modelVendor('')).toBeNull()
    expect(modelVendor(null)).toBeNull()
    expect(differentVendors('claude-haiku-4-5-20251001', 'mystery-model')).toBe(false)
    expect(differentVendors('deepseek-v4-flash', 'deepseek-v4-pro')).toBe(false)
  })

  it('candidates are models the app runs and prices, from two vendors, none of them premium', () => {
    for (const candidate of REVIEWER_CANDIDATES) {
      expect(ALLOWED_MODELS.has(candidate), candidate).toBe(true)
      expect(PREMIUM_MODELS.has(candidate), candidate).toBe(false)
    }
    expect(new Set(REVIEWER_CANDIDATES.map(modelVendor)).size).toBe(REVIEWER_CANDIDATES.length)
  })
})

describe('the reviewer on a ChatGPT plan (only OpenAI models)', () => {
  it("is the plan's other model", () => {
    expect(planReviewerModel('chatgpt-plan/gpt-6-luna')).toBe('gpt-6.1-sol')
    expect(planReviewerModel('chatgpt-plan/gpt-6.1-sol')).toBe('gpt-6-luna')
    expect(planReviewerModel('gpt-6.1-sol')).toBe('gpt-6-luna')
    // What a chat turn on the plan names its model as (the turn selection), so what review_post receives.
    expect(planReviewerModel('openai/gpt-6.1-sol')).toBe('gpt-6-luna')
    expect(differentPlanModels('chatgpt-plan/gpt-6-luna', 'openai/gpt-6.1-sol')).toBe(true)
  })

  it('differentPlanModels holds only for two different plan models', () => {
    expect(differentPlanModels('chatgpt-plan/gpt-6-luna', 'chatgpt-plan/gpt-6.1-sol')).toBe(true)
    expect(differentPlanModels('gpt-6-luna', 'chatgpt-plan/gpt-6.1-sol')).toBe(true)
    expect(differentPlanModels('chatgpt-plan/gpt-6-luna', 'chatgpt-plan/gpt-6-luna')).toBe(false)
    expect(differentPlanModels('chatgpt-plan/gpt-6-luna', 'deepseek-v4-flash')).toBe(false)
    expect(differentPlanModels(null, 'chatgpt-plan/gpt-6-luna')).toBe(false)
  })
})
