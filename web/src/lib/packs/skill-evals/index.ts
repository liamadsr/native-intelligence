/**
 * Chat skill evals (docs/plans/always-on-agent.md §1b item 5): one case file
 * per skill at `cases/<slug>.ts`, each exporting `cases: SkillEvalCase[]`.
 *
 *   - Static (every build): __tests__/skill-evals-static.test.ts holds every
 *     case to the code: tools, params, `show` filters, skills, reachability.
 *   - Live (opt-in, DEV only): scripts/chat-skill-evals.live.test.ts sends
 *     each request through scripts/eve-chat-driver.ts and judges the run with
 *     judgeSkillEvalRun below. Deterministic: no judge model.
 *   - The evals flywheel (docs/plans/always-on-agent.md §8): cases promoted
 *     from real turns live in `cases/flywheel.json` (FlywheelCase[], written by
 *     scripts/eval-flywheel-import.ts) and join their skill's suite below.
 *
 * Test and script tooling only: nothing in the app imports this.
 */
import type { FlywheelCase } from '../../evals/flywheel/types'
import type { SkillEvalCase, SkillEvalParams } from './types'
import flywheelCases from './cases/flywheel.json'
import { cases as actionsPlaybook } from './cases/actions-playbook'
import { cases as buildAWorkflow } from './cases/build-a-workflow'
import { cases as everythingAbout } from './cases/everything-about'
import { cases as findAnything } from './cases/find-anything'
import { cases as flowsPlaybook } from './cases/flows-playbook'
import { cases as knowledgePlaybook } from './cases/knowledge-playbook'
import { cases as myTodoList } from './cases/my-todo-list'
import { cases as overdueWork } from './cases/overdue-work'
import { cases as projectStatusUpdate } from './cases/project-status-update'
import { cases as projectsPlaybook } from './cases/projects-playbook'
import { cases as whatDoWeKnow } from './cases/what-do-we-know'
import { cases as whatsChanged } from './cases/whats-changed'
// A1c docs-goals-tools
import { cases as browserPlaybook } from './cases/browser-playbook'
import { cases as documentsPlaybook } from './cases/documents-playbook'
import { cases as evalsPlaybook } from './cases/evals-playbook'
import { cases as initiativeReview } from './cases/initiative-review'
import { cases as initiativesPlaybook } from './cases/initiatives-playbook'
import { cases as libraryPlaybook } from './cases/library-playbook'
import { cases as writeADocument } from './cases/write-a-document'
// A1c crm-outreach
import { cases as buildProspectList } from './cases/build-prospect-list'
import { cases as campaignsPlaybook } from './cases/campaigns-playbook'
import { cases as crmPlaybook } from './cases/crm-playbook'
import { cases as launchASequence } from './cases/launch-a-sequence'
import { cases as prospectingPlaybook } from './cases/prospecting-playbook'
import { cases as sequencesPlaybook } from './cases/sequences-playbook'
import { cases as staleRelationships } from './cases/stale-relationships'
// A1c meetings-mail
import { cases as calendarPlaybook } from './cases/calendar-playbook'
import { cases as capturesPlaybook } from './cases/captures-playbook'
import { cases as clearInbox } from './cases/clear-inbox'
import { cases as findATime } from './cases/find-a-time'
import { cases as mailPlaybook } from './cases/mail-playbook'
import { cases as meetingFollowUp } from './cases/meeting-follow-up'
import { cases as meetingPrep } from './cases/meeting-prep'
import { cases as meetingRecap } from './cases/meeting-recap'
import { cases as writeInYourTone } from './cases/write-in-your-tone'
// P8: content and marketing
import { cases as brandContext } from './cases/brand-context'
import { cases as contentPlaybook } from './cases/content-playbook'
import { cases as marketingPlaybook } from './cases/marketing-playbook'
import { cases as xPost } from './cases/x-post'

export type { SkillEvalCase, SkillEvalParams } from './types'

/**
 * Every case file, by slug: one literal import each (the eve tripwire refuses
 * a computed import in src/). Adding `cases/<slug>.ts`? Add it here too: the
 * static test fails until this map covers every file in the directory.
 */
export const SKILL_EVAL_CASES: Readonly<Record<string, readonly SkillEvalCase[]>> = {
  'actions-playbook': actionsPlaybook,
  'build-a-workflow': buildAWorkflow,
  'everything-about': everythingAbout,
  'find-anything': findAnything,
  'flows-playbook': flowsPlaybook,
  'knowledge-playbook': knowledgePlaybook,
  'my-todo-list': myTodoList,
  'overdue-work': overdueWork,
  'project-status-update': projectStatusUpdate,
  'projects-playbook': projectsPlaybook,
  'what-do-we-know': whatDoWeKnow,
  'whats-changed': whatsChanged,
  // A1c docs-goals-tools
  'browser-playbook': browserPlaybook,
  'documents-playbook': documentsPlaybook,
  'evals-playbook': evalsPlaybook,
  'initiative-review': initiativeReview,
  'initiatives-playbook': initiativesPlaybook,
  'library-playbook': libraryPlaybook,
  'write-a-document': writeADocument,
  // A1c crm-outreach
  'build-prospect-list': buildProspectList,
  'campaigns-playbook': campaignsPlaybook,
  'crm-playbook': crmPlaybook,
  'launch-a-sequence': launchASequence,
  'prospecting-playbook': prospectingPlaybook,
  'sequences-playbook': sequencesPlaybook,
  'stale-relationships': staleRelationships,
  // A1c meetings-mail
  'calendar-playbook': calendarPlaybook,
  'captures-playbook': capturesPlaybook,
  'clear-inbox': clearInbox,
  'find-a-time': findATime,
  'mail-playbook': mailPlaybook,
  'meeting-follow-up': meetingFollowUp,
  'meeting-prep': meetingPrep,
  'meeting-recap': meetingRecap,
  'write-in-your-tone': writeInYourTone,
  // P8: content and marketing
  'content-playbook': contentPlaybook,
  'x-post': xPost,
  'marketing-playbook': marketingPlaybook,
  'brand-context': brandContext,
}

/**
 * The cases the evals flywheel promoted from real turns (cases/flywheel.json).
 * Each names its skill, or `instructions` for the core instructions. The
 * static test validates the file against flywheelCaseSchema
 * (src/lib/evals/flywheel/case-schema.ts) and holds each case to the same
 * checks as the case files.
 */
export const FLYWHEEL_CASES: readonly FlywheelCase[] = flywheelCases as unknown as FlywheelCase[]

/** The suite key of cases that test the core instructions rather than one skill. */
export const INSTRUCTIONS_SUITE = 'instructions'

/** How many cases of each skill the `instructions` core subset runs: its first ones. */
export const INSTRUCTIONS_CORE_CASES_PER_SKILL = 2

/** The cases of one skill: `cases/<slug>.ts`, then its flywheel cases. */
export interface SkillEvalSuite {
  slug: string
  cases: readonly SkillEvalCase[]
  /** How many of `cases`, at the end, came from cases/flywheel.json. */
  flywheel: number
  /** The `instructions` core subset: only the skill's first cases. */
  core?: boolean
}

/**
 * Every skill's cases, sorted by slug. Flywheel cases join their skill's
 * suite after the file's cases; a skill with no case file (or `instructions`)
 * gets a suite of its own. `{ flywheel: false }`: the case files only.
 */
export function skillEvalSuites(options: { flywheel?: boolean } = {}): SkillEvalSuite[] {
  const bySlug = new Map<string, { cases: SkillEvalCase[]; flywheel: number }>()
  for (const slug of Object.keys(SKILL_EVAL_CASES)) bySlug.set(slug, { cases: [...SKILL_EVAL_CASES[slug]], flywheel: 0 })
  if (options.flywheel !== false) {
    for (const entry of FLYWHEEL_CASES) {
      const suite = bySlug.get(entry.skill) ?? { cases: [], flywheel: 0 }
      suite.cases.push(entry.case as unknown as SkillEvalCase)
      suite.flywheel++
      bySlug.set(entry.skill, suite)
    }
  }
  return [...bySlug.keys()].sort().map((slug) => ({ slug, ...bySlug.get(slug)! }))
}

/**
 * The suites a run selects (CHAT_SKILL_EVAL_ONLY). Empty: every suite. A
 * slug: its whole suite, flywheel cases included. `instructions`: the core
 * subset a change to the instructions, the skills loader or the packs runs:
 * the first INSTRUCTIONS_CORE_CASES_PER_SKILL file cases of every skill not
 * named in full, plus the flywheel's `instructions` cases.
 */
export function selectSkillEvalSuites(only: readonly string[]): SkillEvalSuite[] {
  const all = skillEvalSuites()
  if (only.length === 0) return all
  const named = new Set(only)
  const out = all.filter((s) => named.has(s.slug))
  if (named.has(INSTRUCTIONS_SUITE)) {
    for (const suite of skillEvalSuites({ flywheel: false })) {
      if (named.has(suite.slug)) continue
      out.push({ slug: suite.slug, cases: suite.cases.slice(0, INSTRUCTIONS_CORE_CASES_PER_SKILL), flywheel: 0, core: true })
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}

/** Names in `only` that select nothing: neither a suite nor `instructions`. */
export function unknownSkillEvalSlugs(only: readonly string[]): string[] {
  const slugs = new Set(skillEvalSuites().map((s) => s.slug))
  return only.filter((slug) => slug !== INSTRUCTIONS_SUITE && !slugs.has(slug))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)
}

/**
 * Every field of a SkillEvalCase. caseShapeErrors refuses any other, and the
 * flywheel's schema (src/lib/evals/flywheel/case-schema.ts) has exactly these:
 * a test holds the type, this list and the schema together.
 */
export const SKILL_EVAL_CASE_KEYS = ['request', 'loads', 'tools', 'params', 'avoid', 'forbidParams', 'why', 'noToolErrors'] as const satisfies readonly (keyof SkillEvalCase)[]

/** What is wrong with a case's shape (a JS file or a cast can dodge the type), or []. */
export function caseShapeErrors(c: unknown): string[] {
  if (!isRecord(c)) return ['not an object']
  const errors: string[] = []
  if (typeof c.request !== 'string' || c.request.trim() === '') errors.push('request: a non-empty string')
  if (!isStringArray(c.loads)) errors.push('loads: an array of skill slugs')
  if (!isStringArray(c.tools)) errors.push('tools: an array of tool names')
  const paramsOk = (v: unknown) => isRecord(v) || (Array.isArray(v) && v.length > 0 && v.every(isRecord))
  if (c.params !== undefined) {
    if (!isRecord(c.params) || !Object.values(c.params).every(paramsOk)) {
      errors.push('params: { tool: { param: value } } or { tool: [{ param: value }, …] }')
    }
  }
  if (c.forbidParams !== undefined) {
    if (!isRecord(c.forbidParams) || !Object.values(c.forbidParams).every(paramsOk)) {
      errors.push('forbidParams: { tool: { param: value } } or { tool: [{ param: value }, …] }')
    }
  }
  if (c.avoid !== undefined && !isStringArray(c.avoid)) errors.push('avoid: an array of tool names')
  if (c.why !== undefined && typeof c.why !== 'string') errors.push('why: a string')
  if (c.noToolErrors !== undefined && typeof c.noToolErrors !== 'boolean') errors.push('noToolErrors: a boolean')
  const known = new Set<string>(SKILL_EVAL_CASE_KEYS)
  for (const key of Object.keys(c)) if (!known.has(key)) errors.push(`unknown field: ${key}`)
  if (isStringArray(c.tools) && isStringArray(c.avoid)) {
    for (const t of c.avoid) if (c.tools.includes(t)) errors.push(`${t} is in both tools and avoid`)
  }
  if (isRecord(c.params) && isStringArray(c.avoid)) {
    for (const t of Object.keys(c.params)) if (c.avoid.includes(t)) errors.push(`params for ${t}, which is in avoid`)
  }
  if (isRecord(c.forbidParams) && isStringArray(c.avoid)) {
    for (const t of Object.keys(c.forbidParams)) if (c.avoid.includes(t)) errors.push(`forbidParams for ${t}, which is in avoid (avoid already forbids every call)`)
  }
  return errors
}

/** A tool's expected params as a list: one entry per call to match. */
export function paramsList(expected: SkillEvalParams | readonly SkillEvalParams[]): readonly SkillEvalParams[] {
  return Array.isArray(expected) ? expected : [expected as SkillEvalParams]
}

/** True when `wanted` appears in `seen` in order, gaps allowed. */
export function isOrderedSubsequence<T>(wanted: readonly T[], seen: readonly T[], eq: (w: T, s: T) => boolean = Object.is): boolean {
  let i = 0
  for (const s of seen) {
    if (i < wanted.length && eq(wanted[i], s)) i++
  }
  return i === wanted.length
}

/**
 * True when `actual` holds everything `expected` says. Objects: every
 * expected key matches. Arrays: every expected item matches some actual item
 * (order-free). Strings: equal after trim, ignoring case. Everything else:
 * strictly equal.
 */
export function deepPartialMatch(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false
    return expected.every((e) => actual.some((a) => deepPartialMatch(e, a)))
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false
    return Object.entries(expected).every(([k, v]) => deepPartialMatch(v, actual[k]))
  }
  if (typeof expected === 'string') {
    return typeof actual === 'string' && expected.trim().toLowerCase() === actual.trim().toLowerCase()
  }
  return Object.is(expected, actual)
}

/** One tool call as the chat driver records it (scripts/eve-chat-driver.ts). */
export interface ObservedToolCall {
  name: string
  input?: unknown
  /** load_skill: the skill it resolved to (its output's `skill`). */
  skill?: string
  /** Areas whose expertise pack rode this call's result (seen on the raw eve stream). */
  packs?: string[]
  /**
   * False when the call errored (an output-error) or answered `success:
   * false`; true when it returned otherwise. Absent when the driver saw no
   * result (or predates the field): not counted as an error.
   */
  ok?: boolean
  /** Dial8's error code when a failed call gave one (INPUT_INVALID, REPEATED_FAILURE…). */
  code?: string
  /** The failed call's error text, clipped. */
  error?: string
}

/** One driven chat turn, as the live runner judges it. */
export interface ObservedRun {
  toolCalls: ObservedToolCall[]
  finished: boolean
  error: string | null
}

export interface SkillEvalVerdict {
  pass: boolean
  failures: string[]
  /** What counted as loads, in order: load_skill resolutions and `<area>-playbook` for each pack attached. */
  loadsSeen: string[]
  toolsSeen: string[]
}

/**
 * Judge one run against its case, deterministically:
 *   - loads: in order among what loaded. A load is a `load_skill` call (the
 *     skill its output names, else the name it was called with) or an area's
 *     pack riding a result, which counts as `<area>-playbook` (a core loads
 *     that way on a search, a core tool's first call or a card, not only by
 *     load_skill). `loads: []` means no load_skill call; packs still ride;
 *   - tools: an ordered subsequence of the calls' names;
 *   - params: per tool, at least one call whose input deep-partially matches
 *     (a list: each entry matched by some call);
 *   - forbidParams: per tool, no call whose input deep-partially matches
 *     (a list: any entry);
 *   - avoid: never called;
 *   - noToolErrors: no call errored (`ok: false`);
 *   - the turn finished without an error.
 */
export function judgeSkillEvalRun(c: SkillEvalCase, run: ObservedRun): SkillEvalVerdict {
  const failures: string[] = []
  const toolsSeen = run.toolCalls.map((t) => t.name)
  const loadsSeen: string[] = []
  for (const call of run.toolCalls) {
    if (call.name === 'load_skill') {
      const asked = isRecord(call.input) && typeof call.input.skill === 'string' ? call.input.skill : undefined
      const name = call.skill ?? asked
      if (name) loadsSeen.push(name.trim().toLowerCase())
    }
    for (const area of call.packs ?? []) loadsSeen.push(`${area}-playbook`)
  }

  if (run.error) failures.push(`run error: ${run.error}`)
  if (!run.finished) failures.push('turn did not finish')

  if (c.loads.length === 0) {
    const loaded = run.toolCalls.filter((t) => t.name === 'load_skill')
    if (loaded.length > 0) failures.push(`expected no load_skill, got ${loaded.length} (${loadsSeen.join(', ')})`)
  } else if (!isOrderedSubsequence(c.loads.map((l) => l.toLowerCase()), loadsSeen)) {
    failures.push(`loads [${c.loads.join(', ')}] not in order among [${loadsSeen.join(', ')}]`)
  }

  if (!isOrderedSubsequence(c.tools, toolsSeen)) {
    failures.push(`tools [${c.tools.join(', ')}] not an ordered subsequence of [${toolsSeen.join(', ')}]`)
  }

  for (const [tool, expected] of Object.entries(c.params ?? {})) {
    const calls = run.toolCalls.filter((t) => t.name === tool)
    if (calls.length === 0) {
      failures.push(`params for ${tool}: never called`)
      continue
    }
    for (const entry of paramsList(expected)) {
      if (!calls.some((t) => deepPartialMatch(entry, t.input))) {
        failures.push(`params for ${tool}: no call matched ${JSON.stringify(entry)} (got ${calls.map((t) => JSON.stringify(t.input)).join(' | ')})`)
      }
    }
  }

  for (const [tool, forbidden] of Object.entries(c.forbidParams ?? {})) {
    for (const entry of paramsList(forbidden)) {
      const hit = run.toolCalls.find((t) => t.name === tool && deepPartialMatch(entry, t.input))
      if (hit) failures.push(`forbidParams for ${tool}: a call matched ${JSON.stringify(entry)} (${JSON.stringify(hit.input)})`)
    }
  }

  for (const tool of c.avoid ?? []) {
    if (toolsSeen.includes(tool)) failures.push(`called ${tool}, which it should avoid`)
  }

  if (c.noToolErrors) {
    for (const call of run.toolCalls) {
      if (call.ok !== false) continue
      const why = [call.code ? `[${call.code}]` : '', call.error ?? ''].filter(Boolean).join(' ')
      failures.push(`tool error: ${call.name}${why ? ` ${why}` : ''}`)
    }
  }

  return { pass: failures.length === 0, failures, loadsSeen, toolsSeen }
}
