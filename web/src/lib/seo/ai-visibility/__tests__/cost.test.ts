/**
 * What checks cost (../cost.ts), from the real price constants: queued
 * engines at the queued price, Claude and Perplexity at the live model
 * price, a schedule as 4 (weekly) or 1 (monthly) checks a month, and the
 * confirmation line.
 */
import { AI_RECORD_COST_USD } from '@/lib/seo/shared/ai-visibility'
import { describe, expect, it } from 'vitest'
import { aiAnswerUsd, checksPerMonth, estimateAiCost, formatUsd } from '../cost'

describe('estimateAiCost', () => {
  it('prices queued engines per answer and a weekly month as four checks', () => {
    const e = estimateAiCost({
      promptCount: 12,
      engines: ['chatgpt'],
      scheduleInterval: 'weekly',
      locationCode: 2840,
    })
    expect(AI_RECORD_COST_USD).toBe(0.0012)
    expect(e).toMatchObject({
      prompt_count: 12,
      answers: 12,
      run_usd: 0.0144,
      checks_per_month: 4,
      monthly_usd: 0.0576,
      needs_confirmation: false,
    })
  })

  it('prices Claude and Perplexity at the live model price, per engine', () => {
    const e = estimateAiCost({
      promptCount: 2,
      engines: ['claude', 'perplexity', 'gemini'],
      scheduleInterval: 'off',
      locationCode: 2840,
    })
    expect(e.per_engine).toEqual([
      { engine: 'claude', answers: 2, usd: 0.36, model_api: true },
      { engine: 'perplexity', answers: 2, usd: 0.08, model_api: true },
      { engine: 'gemini', answers: 2, usd: 0.0024, model_api: false },
    ])
    expect(e.run_usd).toBe(0.4424)
    expect(e.monthly_usd).toBe(0)
    expect(e.needs_confirmation).toBe(true)
  })

  it('counts a monthly schedule once and an off schedule never', () => {
    expect(checksPerMonth('monthly')).toBe(1)
    expect(checksPerMonth('off')).toBe(0)
    expect(
      estimateAiCost({
        promptCount: 10,
        engines: ['claude'],
        scheduleInterval: 'monthly',
        locationCode: 2840,
      }).monthly_usd,
    ).toBe(1.8)
  })

  it('names engines the country can’t serve', () => {
    // ChatGPT's scraper has no data for some countries in the shared list.
    expect(
      estimateAiCost({
        promptCount: 1,
        engines: ['chatgpt', 'gemini'],
        scheduleInterval: 'off',
        locationCode: 2344,
      }).unsupported_engines,
    ).toEqual(['chatgpt'])
  })

  it('needs confirmation only above $0.25 a check', () => {
    // 208 queued answers is $0.2496; 209 is $0.2508.
    expect(
      estimateAiCost({
        promptCount: 104,
        engines: ['chatgpt', 'gemini'],
        scheduleInterval: 'off',
        locationCode: 2840,
      }).needs_confirmation,
    ).toBe(false)
    expect(
      estimateAiCost({
        promptCount: 105,
        engines: ['chatgpt', 'gemini'],
        scheduleInterval: 'off',
        locationCode: 2840,
      }).needs_confirmation,
    ).toBe(true)
  })

  it('formats money the way people read it', () => {
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(0.0144)).toBe('$0.0144')
    expect(formatUsd(1.8)).toBe('$1.80')
    expect(aiAnswerUsd('claude')).toBe(0.18)
  })
})
