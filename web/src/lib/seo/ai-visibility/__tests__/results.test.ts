/**
 * The results and trend maths (../results.ts): rates over answered answers
 * only, neutral prompts by default, the brand against its competitors with
 * positions, the gaps, and the trend over matched cells.
 */
import { describe, expect, it } from 'vitest'
import {
  answerCoverage,
  brandSummaries,
  computeTrend,
  engineShares,
  gapPrompts,
  inScope,
  promptShares,
  type ResultAnswer,
  type TrendCell,
} from '../results'
import type { AiBrandResult } from '../view'

const own = {
  name: 'Fernhill',
  domain: 'fernhillstudio.example',
  own: true,
  aliases: [],
}
const rival = {
  name: 'Oakline',
  domain: 'oakline.example',
  own: false,
  aliases: [],
}

function match(
  brand: typeof own,
  mentioned: boolean,
  cited: boolean,
  position: number | null,
): AiBrandResult {
  return {
    name: brand.name,
    domain: brand.domain,
    own: brand.own,
    mentioned,
    cited,
    first_mention: mentioned ? 0 : null,
    position,
  }
}

function row(
  id: string,
  prompt: string,
  engine: ResultAnswer['engine'],
  o: Partial<ResultAnswer> & {
    ownNamed?: boolean
    rivalNamed?: boolean
    ownPos?: number | null
    rivalPos?: number | null
  } = {},
): ResultAnswer {
  const ownNamed = o.ownNamed ?? false
  const rivalNamed = o.rivalNamed ?? false
  return {
    id,
    prompt_id: prompt,
    prompt: `prompt ${prompt}`,
    engine,
    branded: o.branded ?? false,
    status: o.status ?? 'collected',
    has_answer: o.has_answer ?? true,
    brand_mentioned: ownNamed,
    brand_cited: o.brand_cited ?? false,
    matches: [
      match(own, ownNamed, o.brand_cited ?? false, o.ownPos ?? null),
      match(rival, rivalNamed, false, o.rivalPos ?? null),
    ],
  }
}

const rows: ResultAnswer[] = [
  row('1', 'p1', 'chatgpt', {
    ownNamed: true,
    ownPos: 1,
    rivalNamed: true,
    rivalPos: 2,
    brand_cited: true,
  }),
  row('2', 'p1', 'gemini', { rivalNamed: true, rivalPos: 1 }),
  row('3', 'p2', 'chatgpt', { rivalNamed: true, rivalPos: 1 }),
  row('4', 'p2', 'gemini', { status: 'failed', has_answer: false }),
  row('5', 'p3', 'chatgpt', { has_answer: false }),
  row('6', 'p4', 'chatgpt', { branded: true, ownNamed: true, ownPos: 1 }),
]

describe('a check’s results', () => {
  const neutral = inScope(rows, 'neutral')

  it('leaves branded prompts out by default', () => {
    expect(neutral.map((r) => r.id)).toEqual(['1', '2', '3', '4', '5'])
    expect(inScope(rows, 'branded').map((r) => r.id)).toEqual(['6'])
  })

  it('counts coverage: answered, empty, failed, pending', () => {
    expect(answerCoverage(neutral)).toEqual({
      expected: 5,
      answered: 3,
      no_answer: 1,
      failed: 1,
      pending: 0,
    })
  })

  it('rates count answered answers only, per engine', () => {
    expect(engineShares(neutral, ['chatgpt', 'gemini'])).toEqual([
      {
        engine: 'chatgpt',
        label: 'ChatGPT',
        answered: 2,
        mentioned: 1,
        cited: 1,
        mention_rate: 50,
        citation_rate: 50,
      },
      {
        engine: 'gemini',
        label: 'Gemini',
        answered: 1,
        mentioned: 0,
        cited: 0,
        mention_rate: 0,
        citation_rate: 0,
      },
    ])
  })

  it('puts the brand beside its competitors, with average positions', () => {
    expect(brandSummaries(neutral, [own, rival])).toEqual([
      {
        name: 'Fernhill',
        domain: 'fernhillstudio.example',
        own: true,
        answers: 3,
        mentions: 1,
        citations: 1,
        mention_rate: 33.3,
        citation_rate: 33.3,
        average_position: 1,
      },
      {
        name: 'Oakline',
        domain: 'oakline.example',
        own: false,
        answers: 3,
        mentions: 3,
        citations: 0,
        mention_rate: 100,
        citation_rate: 0,
        average_position: 1.3,
      },
    ])
  })

  it('finds the gaps: a competitor named, the brand never', () => {
    const shares = promptShares(neutral)
    expect(shares.find((s) => s.prompt_id === 'p1')).toMatchObject({
      answered: 2,
      mentioned: 1,
      engines_mentioning: ['chatgpt'],
      competitors_named: ['Oakline'],
    })
    expect(gapPrompts(shares).map((g) => g.prompt_id)).toEqual(['p2'])
  })
})

function cell(
  run: string,
  at: string,
  prompt: string,
  engine: TrendCell['engine'],
  mentioned: boolean,
  o: Partial<TrendCell> = {},
): TrendCell {
  return {
    run_id: run,
    run_created_at: at,
    location_code: 2840,
    language_code: 'en',
    own_domain: 'fernhillstudio.example',
    prompt_id: prompt,
    engine,
    branded: false,
    status: 'collected',
    has_answer: true,
    brand_mentioned: mentioned,
    brand_cited: false,
    ...o,
  }
}

describe('the trend', () => {
  const now = new Date('2026-11-12T00:00:00Z')

  it('compares matched cells and reports a change only when both periods are complete', () => {
    const cells = [
      // Previous period (8-14 days ago): p1 not named, p2 named.
      cell('r1', '2026-11-01T06:00:00+00:00', 'p1', 'chatgpt', false),
      cell('r1', '2026-11-01T06:00:00+00:00', 'p2', 'chatgpt', true),
      // Current period: both named; p3 is new and only in the current period.
      cell('r2', '2026-11-08T06:00:00+00:00', 'p1', 'chatgpt', true),
      cell('r2', '2026-11-08T06:00:00+00:00', 'p2', 'chatgpt', true),
      cell('r2', '2026-11-08T06:00:00+00:00', 'p3', 'chatgpt', false),
      // Branded prompts never count.
      cell('r2', '2026-11-08T06:00:00+00:00', 'p9', 'chatgpt', true, {
        branded: true,
      }),
    ]
    const trend = computeTrend(cells, 7, now)
    expect(trend.comparison).toBe('comparable')
    expect(trend.mentions).toMatchObject({
      current: 100,
      previous: 50,
      change: 50,
      matched_cells: 2,
      current_cells: 3,
      previous_cells: 2,
    })
    expect(trend.engines.map((e) => e.engine)).toEqual(['chatgpt'])
    expect(trend.runs.map((r) => [r.run_id, r.mention_rate])).toEqual([
      ['r1', 50],
      ['r2', 100],
    ])
    expect(trend.current.coverage).toMatchObject({
      runs: 1,
      expected: 3,
      answered: 3,
    })
  })

  it('withholds the change when a period collected under 90% of its answers', () => {
    const cells = [
      cell('r1', '2026-11-01T06:00:00+00:00', 'p1', 'chatgpt', false),
      cell('r1', '2026-11-01T06:00:00+00:00', 'p2', 'chatgpt', false, {
        status: 'failed',
        has_answer: false,
      }),
      cell('r2', '2026-11-08T06:00:00+00:00', 'p1', 'chatgpt', true),
      cell('r2', '2026-11-08T06:00:00+00:00', 'p2', 'chatgpt', true),
    ]
    const trend = computeTrend(cells, 7, now)
    expect(trend.comparison).toBe('incomplete')
    expect(trend.mentions.change).toBeNull()
    expect(trend.mentions.current).toBe(100)
  })

  it('says why there is nothing to compare', () => {
    expect(computeTrend([], 7, now).comparison).toBe('no_data')
    expect(
      computeTrend(
        [cell('r2', '2026-11-08T06:00:00+00:00', 'p1', 'chatgpt', true)],
        7,
        now,
      ).comparison,
    ).toBe('no_previous')
    expect(
      computeTrend(
        [
          cell('r1', '2026-11-01T06:00:00+00:00', 'p1', 'chatgpt', true),
          cell('r2', '2026-11-08T06:00:00+00:00', 'p2', 'gemini', true),
        ],
        7,
        now,
      ).comparison,
    ).toBe('scope_changed')
  })

  it('ignores checks older than the two windows', () => {
    const trend = computeTrend(
      [cell('r0', '2026-10-01T06:00:00+00:00', 'p1', 'chatgpt', true)],
      7,
      now,
    )
    expect(trend.comparison).toBe('no_data')
    expect(trend.runs).toEqual([])
  })
})
