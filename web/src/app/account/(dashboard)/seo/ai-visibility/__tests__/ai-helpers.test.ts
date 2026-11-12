import { describe, expect, it } from 'vitest'
import type { AiCostEstimate, AiTrackerListItem, AiTrackerView } from '@/lib/seo/ai-visibility/view'
import {
  addedWords,
  answerMark,
  comparisonReason,
  engineList,
  engineUnavailable,
  estimateSentence,
  excerptText,
  markTitle,
  marketWords,
  monthlyWords,
  nextCheckWords,
  parseNames,
  parseQuestionLines,
  pct,
  pointsChange,
  pollDelayMs,
  positionWords,
  runRailLine,
  scheduleWords,
  spendSentence,
  trackerSettingsLine,
  trackerStatus,
  trackerSubline,
  urlWords,
} from '../ai-helpers'
import { fieldOfRefusal } from '../tracker-dialogs'
import { answersByPrompt, highlightSegments } from '../results-tab'

const estimate = (extra: Partial<AiCostEstimate> = {}): AiCostEstimate => ({
  prompt_count: 30,
  engines: ['chatgpt', 'gemini'],
  answers: 60,
  run_usd: 0.14,
  per_engine: [],
  schedule_interval: 'weekly',
  checks_per_month: 4.3,
  monthly_usd: 0.6,
  needs_confirmation: false,
  confirm_above_usd: 0.25,
  unsupported_engines: [],
  ...extra,
})

const tracker = (extra: Partial<AiTrackerView> = {}): AiTrackerView => ({
  id: 't1',
  brand_name: 'Fernhill Studio',
  brand_aliases: [],
  domain: 'fernhillstudio.example',
  competitors: [],
  location_code: 2840,
  language_code: 'en',
  market_label: 'United States · English',
  engines: ['perplexity', 'chatgpt', 'gemini'],
  schedule_interval: 'weekly',
  next_run_at: null,
  last_run_at: null,
  last_skip_reason: null,
  last_skip_message: null,
  paused: false,
  created_by: null,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  ...extra,
})

describe('engines and schedule', () => {
  it('lists engines in the fixed order with their labels', () => {
    expect(engineList(['perplexity', 'google_ai_overview', 'chatgpt'])).toBe('ChatGPT, Google AI Overviews, Perplexity')
  })
  it('says why an engine is off in a country', () => {
    expect(engineUnavailable('chatgpt', 2840)).toBeNull()
    // ChatGPT can't collect in Germany (2276 is not in its list) but can't in, e.g., 2862.
    expect(engineUnavailable('chatgpt', 2862)).toMatch(/^ChatGPT can’t be checked in /)
    expect(engineUnavailable('gemini', 2862)).toBeNull()
  })
  it('words the schedule', () => {
    expect(scheduleWords('off')).toBe('checked by hand')
    expect(scheduleWords('monthly')).toBe('checked monthly')
  })
  it('names the market by its country, and the language only when it is not the country’s own', () => {
    expect(marketWords(tracker())).toBe('United States')
    expect(marketWords(tracker({ language_code: 'es', market_label: 'United States · Spanish' }))).toBe('United States · Spanish')
  })
  it('words the next check', () => {
    const now = new Date(2026, 10, 12, 10, 0)
    expect(nextCheckWords(null, now)).toBeNull()
    expect(nextCheckWords(new Date(2026, 10, 12, 18, 0).toISOString(), now)).toBe('next check today')
    expect(nextCheckWords(new Date(2026, 10, 13, 9, 0).toISOString(), now)).toBe('next check tomorrow')
    expect(nextCheckWords(new Date(2026, 10, 16, 9, 0).toISOString(), now)).toBe(`next check ${new Date(2026, 10, 16).toLocaleDateString(undefined, { weekday: 'long' })}`)
  })
  it('the settings line: paused drops the schedule', () => {
    expect(trackerSettingsLine(tracker({ schedule_interval: 'off' }))).toBe('ChatGPT, Gemini, Perplexity · United States · checked by hand')
    expect(trackerSettingsLine(tracker({ paused: true }))).toBe('ChatGPT, Gemini, Perplexity · United States · Paused')
  })
  it('the index line and status', () => {
    const item = { ...tracker(), prompt_count: 1, active_prompt_count: 1, latest_run: null } as AiTrackerListItem
    expect(trackerSubline(item)).toBe('1 question · ChatGPT, Gemini, Perplexity · checked weekly')
    expect(trackerStatus(item)).toBeNull()
    expect(trackerStatus({ ...item, paused: true })!.word).toBe('Paused')
    expect(trackerStatus({ ...item, last_skip_message: 'Skipped because.' })).toEqual({ word: 'Skipped', title: 'Skipped because.', tone: 'muted' })
  })
})

describe('a check', () => {
  it('the rail counts the answers in', () => {
    expect(runRailLine({ status: 'running', answers_total: 30, answers_open: 12 })).toEqual({ verb: 'Asking the assistants', clauses: ['18 of 30 answers in'] })
    expect(runRailLine({ status: 'running', answers_total: 0, answers_open: 0 })).toEqual({ verb: 'Asking the assistants', clauses: [] })
    expect(runRailLine({ status: 'queued', answers_total: 30, answers_open: 30 }).verb).toBe('Starting the check')
  })
  it('polls at the route’s pace, never under 5 s', () => {
    expect(pollDelayMs(null)).toBe(5000)
    expect(pollDelayMs({ poll_after_seconds: 2 })).toBe(5000)
    expect(pollDelayMs({ poll_after_seconds: 30 })).toBe(30000)
  })
})

describe('money', () => {
  it('says the route’s estimate in a sentence', () => {
    expect(estimateSentence(estimate())).toBe('A check asks 30 questions of 2 assistants and costs about $0.14. Weekly, about $0.60 a month.')
    expect(estimateSentence(estimate({ schedule_interval: 'off', checks_per_month: 0 }))).toBe('A check asks 30 questions of 2 assistants and costs about $0.14.')
    expect(estimateSentence(estimate({ prompt_count: 1, engines: ['gemini'], run_usd: 0.001, schedule_interval: 'off' }))).toBe('A check asks 1 question of 1 assistant and costs less than a cent.')
    expect(estimateSentence(estimate({ prompt_count: 0 }))).toBeNull()
  })
  it('the monthly words', () => {
    expect(monthlyWords(estimate())).toBe('about $0.60 a month')
    expect(monthlyWords(estimate({ schedule_interval: 'off' }))).toBe('nothing on its own')
    expect(monthlyWords(estimate({ prompt_count: 0, run_usd: 0, monthly_usd: 0 }))).toBe('nothing until questions are added')
    expect(monthlyWords(estimate({ prompt_count: 0, schedule_interval: 'off', checks_per_month: 0 }))).toBe('nothing on its own')
  })
  it('a spend confirmation’s before and after, a schedule with no questions in words', () => {
    expect(spendSentence(estimate())).toBe('A check asks 30 questions of 2 assistants and costs about $0.14. Weekly, about $0.60 a month.')
    expect(spendSentence(estimate({ schedule_interval: 'off', checks_per_month: 0, monthly_usd: 0 }))).toBe('A check asks 30 questions of 2 assistants and costs about $0.14. Nothing is spent on its own.')
    expect(spendSentence(estimate({ prompt_count: 0, run_usd: 0, monthly_usd: 0, schedule_interval: 'monthly', checks_per_month: 1 }))).toBe(
      'Monthly checks cost nothing while there are no questions. Once questions are added, every check costs for each one it asks, and you are asked first.',
    )
    expect(spendSentence(estimate({ prompt_count: 0, schedule_interval: 'off', checks_per_month: 0 }))).toBe('Nothing is spent on its own.')
    expect(spendSentence(estimate({ engines: [] }))).toBeNull()
  })
})

describe('typed input', () => {
  it('questions: trimmed, spaces folded, once each ignoring case', () => {
    expect(parseQuestionLines('  Who is best?  \n\nwho   is BEST?\r\nWhere to buy?')).toEqual(['Who is best?', 'Where to buy?'])
  })
  it('other names: comma separated, once each', () => {
    expect(parseNames('Fernhill, fernhill , ,Fernhill Studios')).toEqual(['Fernhill', 'Fernhill Studios'])
  })
  it('an add’s outcome', () => {
    expect(addedWords({ added: 3, skipped_duplicates: 0, skipped_over_cap: 0 })).toBe('Added 3 questions.')
    expect(addedWords({ added: 1, skipped_duplicates: 2, skipped_over_cap: 1 })).toBe('Added 1 question. 2 were already there, 1 didn’t fit (a tracker holds up to 50).')
  })
  it('a refusal finds its field', () => {
    expect(fieldOfRefusal('NO_SITE', 'Add a website.')).toBe('domain')
    expect(fieldOfRefusal('VALIDATION_ERROR', 'A tracker compares with up to 10 competitors.')).toBe('competitors')
    expect(fieldOfRefusal('VALIDATION_ERROR', 'ChatGPT can’t be checked in this country. Leave it out or pick another country.')).toBe('engines')
    expect(fieldOfRefusal('VALIDATION_ERROR', 'That country isn’t one we can check.')).toBe('market')
    expect(fieldOfRefusal('VALIDATION_ERROR', 'Choose at least one AI engine.')).toBe('engines')
    expect(fieldOfRefusal('VALIDATION_ERROR', 'Give the brand a name.')).toBe('brand')
    expect(fieldOfRefusal('TRACKER_LIMIT', 'A workspace can have 10 trackers.')).toBe('form')
  })
})

describe('numbers and answers', () => {
  it('percent and points', () => {
    expect(pct(42.5)).toBe('42.5%')
    expect(pct(null)).toBeNull()
    expect(pointsChange(4.2)).toEqual({ note: 'Up 4.2 points', tone: 'up' })
    expect(pointsChange(-1)).toEqual({ note: 'Down 1 point', tone: 'down' })
    expect(pointsChange(0)).toEqual({ note: 'No change', tone: 'flat' })
    expect(pointsChange(null)).toBeNull()
  })
  it('why a trend is not compared', () => {
    expect(comparisonReason('comparable', 30)).toBeNull()
    expect(comparisonReason('no_previous', 7)).toBe('Not compared yet: there were no checks in the 7 days before.')
  })
  it('marks an answer', () => {
    expect(answerMark(null)).toBe('no_answer')
    expect(answerMark({ status: 'posted', answer_status: null, brand_mentioned: null })).toBe('waiting')
    expect(answerMark({ status: 'collected', answer_status: 'answered', brand_mentioned: true })).toBe('named')
    expect(answerMark({ status: 'collected', answer_status: 'answered', brand_mentioned: false })).toBe('not_named')
    expect(answerMark({ status: 'collected', answer_status: 'no_answer', brand_mentioned: null })).toBe('no_answer')
    expect(markTitle('google_ai_overview', { status: 'collected', answer_status: 'no_answer', brand_mentioned: null, error: null, late: false })).toBe('Google AI Overviews: Google showed no AI Overview')
    expect(markTitle('chatgpt', { status: 'collected', answer_status: 'answered', brand_mentioned: true, error: null, late: true })).toBe('ChatGPT named you (came in late)')
    // An answer charged but not recorded: its own words, from the code when the row carries no sentence.
    expect(markTitle('gemini', { status: 'failed', answer_status: null, brand_mentioned: null, error: null, error_code: 'NOT_TRACKED', late: false })).toBe(
      'Gemini: This answer was asked for and charged, but its result could not be recorded.',
    )
    expect(markTitle('gemini', { status: 'failed', answer_status: null, brand_mentioned: null, error: null, late: false })).toBe('Gemini: no answer came')
  })
  it('positions in words', () => {
    expect(positionWords(1)).toBe('Named first')
    expect(positionWords(2)).toBe('Named 2nd')
    expect(positionWords(11)).toBe('Named 11th')
    expect(positionWords(23)).toBe('Named 23rd')
    expect(positionWords(null)).toBeNull()
  })
  it('an excerpt is plain text: no markup, citation pills gone, folded and cut', () => {
    expect(excerptText('# Top\n\n**Fernhill** is [great](https://x.example) <b>really</b> [1](https://y.example)')).toBe('Top Fernhill is great <b>really</b>')
    expect(excerptText('a'.repeat(700), 600)).toHaveLength(601)
    expect(excerptText(null)).toBe('')
  })
  it('marks the brand’s spans in the text, ignoring bad or overlapping ones', () => {
    expect(highlightSegments('Try Fernhill now', [{ start: 4, end: 12 }, { start: 6, end: 9 }, { start: 40, end: 50 }])).toEqual([
      { text: 'Try ', mark: false },
      { text: 'Fernhill', mark: true },
      { text: ' now', mark: false },
    ])
  })
  it('groups answers by question then engine', () => {
    const map = answersByPrompt([
      { prompt_id: 'p1', engine: 'chatgpt' },
      { prompt_id: 'p1', engine: 'gemini' },
      { prompt_id: 'p2', engine: 'chatgpt' },
    ] as never)
    expect([...map.keys()]).toEqual(['p1', 'p2'])
    expect([...map.get('p1')!.keys()]).toEqual(['chatgpt', 'gemini'])
  })
  it('a page URL without its scheme', () => {
    expect(urlWords('https://www.example.com/guide?x=1')).toBe('example.com/guide?x=1')
    expect(urlWords('https://example.com/')).toBe('example.com')
  })
})
