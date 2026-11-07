/**
 * Static chat skill evals (docs/plans/always-on-agent.md §1b item 5): free,
 * in every build. Each case under ../cases is held to the code, so a skill's
 * expected behaviour can't drift from the tools it names:
 *   - every tool in `tools`, `avoid`, `params` and `forbidParams` is a
 *     registry tool or a chat framework tool;
 *   - every `params` key is in that tool's input schema (nested objects and
 *     arrays too), every value has the schema's type, a number sits within
 *     the schema's minimum and maximum, and an enum param's value is one of
 *     its options (a tool's params may be a list, one entry per call: each
 *     entry is checked); `forbidParams` gets the same schema check;
 *   - a `show` call's filters name real FILTERABLE_FIELDS of its entity_type,
 *     with real operators and, for a fixed-option field, real values, and pass
 *     the card's own filter check (checkFilter: a date compared with lt or
 *     between takes an ISO date, is_relative takes "this week" and the like);
 *   - every `loads` slug and every case file's slug is a shipped system skill;
 *   - a pack-only skill is tagged with an area (or no pack lists it), and a
 *     case that loads one reaches that area's pack BEFORE the load: the
 *     area's playbook earlier in `loads`, or, ahead of a `load_skill` marker
 *     in `tools`, one of the area's tools or a `show` card of the area.
 *     `search_tools` alone reaches nothing;
 *   - each required skill has at least MIN_CASES cases;
 *   - cases/flywheel.json (the evals flywheel's promoted cases) parses with
 *     flywheelCaseSchema, names each candidate once, stays in the import's
 *     order, names a shipped skill (or `instructions`), and each case passes
 *     the same shape, tool, param and skill checks as the case files'.
 * The live layer (scripts/chat-skill-evals.live.test.ts) runs the same cases
 * against a real chat, opt-in.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TOOL_REGISTRY_MAP } from '@/lib/ai/tool-registry'
import { registryToolInputSchemas, type ToolInputJsonSchema } from '@/lib/ai/tool-schemas'
import { FILTERABLE_FIELDS, type FilterFieldDefinition } from '@/lib/views/types'
import { CARD_LIST_ENTITIES } from '@/lib/chat-cards/kinds'
import { checkFilter } from '@/lib/chat-cards/validate'
import { areaForCard, areaForTool, isAreaKey, playbookSlug } from '../../registry'
import { allShippedSkills, type SeededSkill } from '../../__tests__/playbook-seeds'
import { flywheelCaseSchema } from '@/lib/evals/flywheel/case-schema'
import { compareFlywheelCases } from '@/lib/evals/flywheel/import'
import { FLYWHEEL_CASES, INSTRUCTIONS_SUITE, caseShapeErrors, paramsList, skillEvalSuites, type SkillEvalCase } from '../index'

// ── The list to tighten ─────────────────────────────────────────────────────

/** The skills that must have cases: the A1 and A1b recipes and the rewritten cores. */
const REQUIRED_SLUGS = [
  'my-todo-list',
  'overdue-work',
  'project-status-update',
  'what-do-we-know',
  'whats-changed',
  'everything-about',
  'find-anything',
  'actions-playbook',
  'projects-playbook',
  'knowledge-playbook',
  'flows-playbook',
  'build-a-workflow',
  // A1c docs-goals-tools
  'documents-playbook',
  'initiatives-playbook',
  'evals-playbook',
  'browser-playbook',
  'library-playbook',
  'write-a-document',
  'initiative-review',
  // A1c crm-outreach
  'crm-playbook',
  'prospecting-playbook',
  'sequences-playbook',
  'campaigns-playbook',
  'build-prospect-list',
  'stale-relationships',
  'launch-a-sequence',
  // A1c meetings-mail
  'calendar-playbook',
  'captures-playbook',
  'mail-playbook',
  'meeting-prep',
  'find-a-time',
  'meeting-recap',
  'meeting-follow-up',
  'write-in-your-tone',
  'clear-inbox',
  // P8: content and marketing
  'content-playbook',
  'x-post',
  'marketing-playbook',
  'brand-context',
] as const

/**
 * While the case files land, a required slug without one is skipped (with
 * its name saying so). Set false once they all exist: then a missing file
 * fails.
 */
const ALLOW_MISSING_CASE_FILES = false

/** The fewest cases a required skill may have. */
const MIN_CASES = 5

/** Which A1 / A1b recipes are pack-only (§1b items 2 and 6); checked once each ships. */
const EXPECTED_PACK_ONLY: Record<string, boolean> = {
  'my-todo-list': false,
  'overdue-work': true,
  'project-status-update': true,
  'what-do-we-know': false,
  'whats-changed': true,
  'everything-about': false,
  'find-anything': false,
  'build-a-workflow': true,
  // A1c docs-goals-tools
  'write-a-document': true,
  'initiative-review': true,
  // A1c crm-outreach (build-prospect-list stays global: the Prospecting page arms it by slug)
  'build-prospect-list': false,
  'stale-relationships': true,
  'launch-a-sequence': true,
  // A1c meetings-mail
  'meeting-prep': true,
  'find-a-time': true,
  'meeting-recap': true,
  'meeting-follow-up': true,
  'write-in-your-tone': true,
  'clear-inbox': true,
  // P8: the surface and brand-context skills list inside their area's pack
  'x-post': true,
  'brand-context': true,
}

// ── What the cases are checked against ──────────────────────────────────────

/**
 * The chat agent's own tools (agents/chat-agent/tools), which aren't registry
 * tools, with their input schemas where a case may give params. null: the
 * tool exists, its params aren't checked here.
 */
const FRAMEWORK_TOOLS: Record<string, ToolInputJsonSchema | null> = {
  load_skill: { type: 'object', properties: { skill: { type: 'string' } }, additionalProperties: false },
  search_tools: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
  ask_user: null,
  web_search: null,
  web_fetch: null,
  // Quick helpers (A4 slice 3, agents/chat-agent/tools/helpers.ts): a static workflow tool.
  helpers: null,
}

/** The operators a `show` filter takes (show.ts filterSchema; also in playbook-accuracy.test.ts). */
const SHOW_OPERATORS: ReadonlySet<string> = new Set([
  'is', 'is_not', 'is_any_of', 'is_none_of', 'contains', 'does_not_contain', 'gt', 'gte', 'lt', 'lte', 'between',
  'is_relative', 'includes', 'excludes', 'is_empty', 'is_not_empty',
])

const SCHEMAS = registryToolInputSchemas()
const SHIPPED: ReadonlyMap<string, SeededSkill> = new Map(allShippedSkills().map((s) => [s.slug, s]))
/** The case files' suites (the flywheel's cases are checked on their own below). */
const suites = skillEvalSuites({ flywheel: false })

/** The slugs that have a case file: every `<slug>.ts` in ../cases. */
function caseFileSlugs(): string[] {
  let names: string[]
  try {
    names = readdirSync(join(process.cwd(), 'src/lib/packs/skill-evals/cases'))
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts') && !n.endsWith('.test.ts'))
    .map((n) => n.slice(0, -3))
    .sort()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isPackOnly(skill: SeededSkill): boolean {
  return (skill.config as Record<string, unknown>).pack_only === true
}

function toolExists(name: string): boolean {
  return TOOL_REGISTRY_MAP.has(name) || name in FRAMEWORK_TOOLS
}

/** A tool's input schema: the registry's, a framework tool's, or undefined when there is none to check. */
function schemaFor(name: string): ToolInputJsonSchema | null | undefined {
  if (name in FRAMEWORK_TOOLS) return FRAMEWORK_TOOLS[name]
  return SCHEMAS.get(name)
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'integer':
      return Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isRecord(value)
    case 'null':
      return value === null
    default:
      return typeof value === type
  }
}

function resolveRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = root
  for (const part of ref.slice(2).split('/')) {
    node = isRecord(node) ? node[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined
  }
  return node
}

/**
 * Where `value` breaks `schema` (the JSON Schema the model is advertised), or
 * []. Partial on purpose: a case gives key params, so `required` isn't checked.
 */
function schemaErrors(schema: unknown, value: unknown, path: string, root: Record<string, unknown>): string[] {
  if (schema === true || schema === undefined || schema === null) return []
  if (schema === false) return [`${path}: not allowed`]
  if (!isRecord(schema)) return []
  if (typeof schema.$ref === 'string') return schemaErrors(resolveRef(root, schema.$ref), value, path, root)

  const branches = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined
  if (Array.isArray(branches) && branches.length > 0) {
    const results = branches.map((b) => schemaErrors(b, value, path, root))
    if (results.some((r) => r.length === 0)) return []
    return results.reduce((best, r) => (r.length < best.length ? r : best))
  }
  const errors: string[] = []
  if (Array.isArray(schema.allOf)) for (const b of schema.allOf) errors.push(...schemaErrors(b, value, path, root))

  if ('const' in schema && !Object.is(schema.const, value)) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => Object.is(e, value))) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`)
    return errors
  }
  const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? (schema.type as string[]) : null
  if (types && !types.some((t) => hasType(value, t))) {
    errors.push(`${path}: ${/^[aeiou]/.test(types[0]) ? 'an' : 'a'} ${types.join(' | ')}, not ${typeOf(value)} ${JSON.stringify(value)}`)
    return errors
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: ${value} is above the maximum ${schema.maximum}`)
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errors.push(`${path}: ${value} must be above ${schema.exclusiveMinimum}`)
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) errors.push(`${path}: ${value} must be below ${schema.exclusiveMaximum}`)
  }

  if (Array.isArray(value)) {
    if (Array.isArray(schema.items)) value.forEach((v, i) => errors.push(...schemaErrors((schema.items as unknown[])[i], v, `${path}[${i}]`, root)))
    else if (schema.items !== undefined) value.forEach((v, i) => errors.push(...schemaErrors(schema.items, v, `${path}[${i}]`, root)))
  } else if (isRecord(value)) {
    const props = isRecord(schema.properties) ? schema.properties : {}
    const extra = schema.additionalProperties
    for (const [key, child] of Object.entries(value)) {
      if (key in props) errors.push(...schemaErrors(props[key], child, `${path}.${key}`, root))
      else if (isRecord(extra) || extra === true) errors.push(...schemaErrors(extra, child, `${path}.${key}`, root))
      else if (extra === false || isRecord(schema.properties)) {
        errors.push(`${path}.${key}: not a parameter (has: ${Object.keys(props).join(', ') || 'none'})`)
      }
    }
  }
  return errors
}

/** Where a case's `show` params break the card's real filter fields, or []. */
function showFilterErrors(params: Record<string, unknown>): string[] {
  const filters = params.filters
  if (filters === undefined) return []
  const entity = params.entity_type
  if (typeof entity !== 'string' || !(CARD_LIST_ENTITIES as readonly string[]).includes(entity)) {
    return ['show.filters: give show.entity_type too (a list entity), so the fields can be checked']
  }
  const defs = FILTERABLE_FIELDS[entity as keyof typeof FILTERABLE_FIELDS] as FilterFieldDefinition[]
  const errors: string[] = []
  if (!Array.isArray(filters)) return errors // the schema check reports it
  filters.forEach((f, i) => {
    if (!isRecord(f)) return
    const at = `show.filters[${i}]`
    const def = typeof f.field === 'string' ? defs.find((d) => d.field === f.field) : undefined
    if (f.field !== undefined && !def) {
      errors.push(`${at}.field: ${JSON.stringify(f.field)} is not a filterable ${entity} field (has: ${defs.map((d) => d.field).join(', ')})`)
    }
    if (f.operator !== undefined && !(typeof f.operator === 'string' && SHOW_OPERATORS.has(f.operator))) {
      errors.push(`${at}.operator: ${JSON.stringify(f.operator)} is not a show operator`)
    }
    const before = errors.length
    if (def && def.type === 'enum' && Array.isArray(def.options) && f.value !== undefined) {
      const values = Array.isArray(f.value) ? f.value : [f.value]
      for (const v of values) {
        if (typeof v === 'string' && !v.startsWith('@') && !def.options.includes(v)) {
          errors.push(`${at}.value: ${JSON.stringify(v)} is not a ${def.field} option (${def.options.join(', ')})`)
        }
      }
    }
    // The card's own check (src/lib/chat-cards/validate.ts), once the field
    // and operator are known good: the operator suits the field's type, and
    // the value its shape (a date compared with lt takes an ISO date, not
    // "today"; is_relative takes "this week" or a {unit, direction}).
    const hasValue = f.value !== undefined || f.operator === 'is_empty' || f.operator === 'is_not_empty'
    if (def && errors.length === before && typeof f.operator === 'string' && SHOW_OPERATORS.has(f.operator) && hasValue) {
      const checked = checkFilter(entity as keyof typeof FILTERABLE_FIELDS, f, at)
      if (!checked.ok) errors.push(checked.error)
    }
  })
  return errors
}

/** Every problem with one case's tools and params, or []. */
function caseToolErrors(c: SkillEvalCase): string[] {
  const errors: string[] = []
  const named = new Set([...c.tools, ...(c.avoid ?? []), ...Object.keys(c.params ?? {}), ...Object.keys(c.forbidParams ?? {})])
  for (const name of named) if (!toolExists(name)) errors.push(`${name}: not a registry or chat framework tool`)
  const groups: Array<[string, SkillEvalCase['params']]> = [
    ['', c.params],
    ['forbidParams ', c.forbidParams],
  ]
  for (const [label, group] of groups) {
    for (const [tool, expected] of Object.entries(group ?? {})) {
      if (!toolExists(tool)) continue
      const schema = schemaFor(tool)
      if (schema === undefined) {
        errors.push(`${label}${tool}: has no input schema to check params against`)
        continue
      }
      const entries = paramsList(expected)
      entries.forEach((params, i) => {
        const at = `${label}${Array.isArray(expected) ? `${tool}[${i}]` : tool}`
        if (schema !== null) errors.push(...schemaErrors(schema, params, at, schema))
        if (tool === 'show') errors.push(...showFilterErrors(params).map((e) => e.replace(/^show/, at)))
      })
    }
  }
  return errors
}

/**
 * The areas whose pack a case reaches BEFORE it loads the skill at `index` of
 * its loads:
 *   - an area's playbook earlier in `loads`;
 *   - ahead of the first `load_skill` in `tools` (the marker of where the
 *     loads happen), a tool of the area or a `show` card of the area.
 * With no `load_skill` in `tools`, the loads come first and no tool counts.
 * `search_tools` is no area's tool: it reveals tools, and a case that relies
 * on that names the revealed tool before the marker.
 */
function reachedAreas(c: SkillEvalCase, index: number): Set<string> {
  const areas = new Set<string>()
  for (const slug of c.loads.slice(0, index)) {
    const m = /^([a-z_]+)-playbook$/.exec(slug)
    if (m) areas.add(m[1])
  }
  const marker = c.tools.indexOf('load_skill')
  const before = marker < 0 ? [] : c.tools.slice(0, marker)
  for (const tool of before) {
    const area = areaForTool(tool)
    if (area) areas.add(area)
  }
  if (before.includes('show') && c.params?.show) {
    for (const show of paramsList(c.params.show)) {
      if (typeof show.kind !== 'string') continue
      const record = isRecord(show.record) && typeof show.record.type === 'string' ? show.record.type : null
      const area = areaForCard({ kind: show.kind, entity_type: typeof show.entity_type === 'string' ? show.entity_type : null, record_type: record })
      if (area) areas.add(area)
    }
  }
  return areas
}

/** Every problem with one case's skills, or []. */
function caseSkillErrors(c: SkillEvalCase, shipped: ReadonlyMap<string, SeededSkill>): string[] {
  const errors: string[] = []
  c.loads.forEach((slug, i) => {
    const skill = shipped.get(slug)
    if (!skill) {
      errors.push(`loads ${slug}: not a shipped system skill`)
      return
    }
    // A pack-only skill is listed only in its area's pack: the case must
    // reach that pack before the load.
    if (isPackOnly(skill) && isAreaKey(skill.area)) {
      if (!reachedAreas(c, i).has(skill.area)) {
        errors.push(
          `loads ${slug}: pack-only (listed in the ${skill.area} pack), but nothing in the case reaches that pack before the load ` +
            `(load ${playbookSlug(skill.area)} earlier, or call a ${skill.area} tool or show a ${skill.area} card ahead of load_skill in tools)`,
        )
      }
    }
  })
  return errors
}

/**
 * Every problem with one cases/flywheel.json entry, or []: its schema, its
 * skill (shipped, or `instructions`), and the case files' own checks.
 */
function flywheelCaseErrors(entry: unknown, shipped: ReadonlyMap<string, SeededSkill>): string[] {
  const parsed = flywheelCaseSchema.safeParse(entry)
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(entry)'}: ${i.message}`)
  const { skill, case: c } = parsed.data
  const errors: string[] = []
  if (skill !== INSTRUCTIONS_SUITE && !shipped.has(skill)) errors.push(`skill ${skill}: not a shipped system skill (or "${INSTRUCTIONS_SUITE}")`)
  errors.push(...caseShapeErrors(c), ...caseToolErrors(c), ...caseSkillErrors(c, shipped))
  return errors
}

// ── The checks ──────────────────────────────────────────────────────────────

describe('the static checks catch what they claim to (one inline example case)', () => {
  const bad: SkillEvalCase = {
    request: 'what is on my plate',
    loads: ['my-todo-lists'],
    tools: ['list_actions', 'list_my_todos'],
    params: {
      list_actions: { assignee: 'me', filter: 'next_week', project: 'x', limit: '20' },
      show: { kind: 'list', title: 'Mine', entity_type: 'action', filters: [{ field: 'owner_id', operator: 'is', value: '@me' }, { field: 'status_type', operator: 'equals', value: 'done' }] },
    },
  }

  it('flags an unknown tool, an unknown param, a bad enum value, a wrong type and a bad show filter', () => {
    const errors = caseToolErrors(bad)
    expect(errors).toEqual(
      expect.arrayContaining([
        'list_my_todos: not a registry or chat framework tool',
        expect.stringContaining('list_actions.filter: "next_week" is not one of'),
        expect.stringContaining('list_actions.project: not a parameter'),
        expect.stringContaining('list_actions.limit: an integer'),
        expect.stringContaining('show.filters[0].field: "owner_id" is not a filterable action field'),
        'show.filters[1].operator: "equals" is not a show operator',
        expect.stringContaining('show.filters[1].value: "done" is not a status_type option'),
      ]),
    )
  })

  it('passes a good case', () => {
    const good: SkillEvalCase = {
      request: 'what is on my plate',
      loads: [],
      tools: ['search_tools', 'list_actions'],
      params: {
        list_actions: { assignee: 'me', filter: 'overdue' },
        load_skill: { skill: 'actions-playbook' },
        show: { kind: 'list', title: 'Mine', entity_type: 'action', filters: [{ field: 'assignee_id', operator: 'is', value: '@me' }, { field: 'status_type', operator: 'is_none_of', value: ['completed', 'canceled'] }] },
      },
    }
    expect(caseToolErrors(good)).toEqual([])
    expect(caseShapeErrors(good)).toEqual([])
  })

  it('flags an unshipped skill', () => {
    expect(caseSkillErrors(bad, SHIPPED)).toEqual(['loads my-todo-lists: not a shipped system skill'])
  })

  it('flags a pack-only skill the case never reaches', () => {
    const packOnly: SeededSkill = { file: 'x.sql', id: 'x', slug: 'stale-deals', area: 'crm', description: '', prompt: '', config: { pack_only: true } as unknown as SeededSkill['config'] }
    const shipped = new Map<string, SeededSkill>([...SHIPPED, ['stale-deals', packOnly]])
    const unreached: SkillEvalCase = { request: 'stale deals?', loads: ['stale-deals'], tools: ['list_actions'] }
    expect(caseSkillErrors(unreached, shipped)).toEqual([expect.stringContaining('pack-only (listed in the crm pack)')])
    // Reached: the playbook earlier in loads, or an area tool ahead of the load_skill marker.
    expect(caseSkillErrors({ ...unreached, loads: ['crm-playbook', 'stale-deals'] }, shipped)).toEqual([])
    expect(caseSkillErrors({ ...unreached, tools: ['search_tools', 'list_companies', 'load_skill'] }, shipped)).toEqual([])
    // Not reached: bare search_tools, an area tool AFTER the load, or no marker at all.
    expect(caseSkillErrors({ ...unreached, tools: ['search_tools', 'load_skill'] }, shipped)).toHaveLength(1)
    expect(caseSkillErrors({ ...unreached, tools: ['load_skill', 'search_tools', 'list_companies'] }, shipped)).toHaveLength(1)
    expect(caseSkillErrors({ ...unreached, tools: ['search_tools', 'list_companies'] }, shipped)).toHaveLength(1)
    // The playbook must come BEFORE the skill in loads.
    expect(caseSkillErrors({ ...unreached, loads: ['stale-deals', 'crm-playbook'] }, shipped)).toHaveLength(1)
  })

  it('reaches an area by a show card ahead of the marker', () => {
    const packOnly: SeededSkill = { file: 'x.sql', id: 'x', slug: 'late-work', area: 'actions', description: '', prompt: '', config: { pack_only: true } as unknown as SeededSkill['config'] }
    const shipped = new Map<string, SeededSkill>([...SHIPPED, ['late-work', packOnly]])
    const card = { show: { kind: 'list', entity_type: 'action' } }
    expect(caseSkillErrors({ request: 'late?', loads: ['late-work'], tools: ['show', 'load_skill'], params: card }, shipped)).toEqual([])
    expect(caseSkillErrors({ request: 'late?', loads: ['late-work'], tools: ['load_skill', 'show'], params: card }, shipped)).toHaveLength(1)
  })

  it('checks numbers against the schema bounds and show dates against the card check', () => {
    const errors = caseToolErrors({
      request: 'x',
      loads: [],
      tools: ['list_actions', 'show'],
      params: {
        list_actions: { limit: 500 },
        show: {
          kind: 'list',
          entity_type: 'action',
          filters: [
            { field: 'due_at', operator: 'lt', value: 'today' },
            { field: 'due_at', operator: 'is_relative', value: 'this week' },
            { field: 'due_at', operator: 'lt', value: '2026-10-14' },
          ],
        },
      },
    })
    expect(errors).toEqual([
      'list_actions.limit: 500 is above the maximum 200',
      expect.stringContaining('show.filters[0]: due_at takes an ISO date'),
    ])
  })

  it('checks forbidParams against the schema too', () => {
    const errors = caseToolErrors({
      request: 'x',
      loads: [],
      tools: ['create_flow'],
      forbidParams: { create_flow: [{ enabled: true }, { confirmed: true }], list_flowz: { a: 1 } },
    })
    expect(errors).toEqual([
      'list_flowz: not a registry or chat framework tool',
      expect.stringContaining('forbidParams create_flow[1].confirmed: not a parameter'),
    ])
  })

  it('checks each entry of a list of params', () => {
    const errors = caseToolErrors({
      request: 'x',
      loads: [],
      tools: ['list_actions'],
      params: { list_actions: [{ assignee: 'me' }, { filter: 'next_week' }] },
    })
    expect(errors).toEqual([expect.stringContaining('list_actions[1].filter: "next_week" is not one of')])
  })
})

describe('the flywheel checks catch what they claim to (fixtures, not cases/flywheel.json)', () => {
  const valid = {
    candidateId: '00000000-0000-4000-8000-000000000001',
    skill: 'my-todo-list',
    source: 'input_invalid',
    polarity: 'bad',
    promotedAt: '2026-10-16T09:00:00.000Z',
    case: {
      request: "what's on my plate today?",
      loads: ['my-todo-list'],
      tools: ['list_actions'],
      params: { list_actions: { assignee: 'me', filter: 'today' } },
      noToolErrors: true,
      why: 'INPUT_INVALID on list_actions: filter "today_and_overdue" is not an option',
    },
  }

  it('passes a valid case, and one for the instructions', () => {
    expect(flywheelCaseErrors(valid, SHIPPED)).toEqual([])
    const instructions = { ...valid, skill: INSTRUCTIONS_SUITE, source: 'thumbs_up', polarity: 'good', case: { request: 'what can you do?', loads: [], tools: [] } }
    expect(flywheelCaseErrors(instructions, SHIPPED)).toEqual([])
  })

  it('flags a bad schema: empty request, bad slug, wrong polarity, unknown field', () => {
    expect(flywheelCaseErrors({ ...valid, case: { ...valid.case, request: '  ' } }, SHIPPED)).toEqual([expect.stringContaining('case.request')])
    expect(flywheelCaseErrors({ ...valid, skill: 'My Todo List' }, SHIPPED)).toEqual([expect.stringContaining('skill: a skill slug in kebab-case')])
    expect(flywheelCaseErrors({ ...valid, polarity: 'good' }, SHIPPED)).toEqual([expect.stringContaining('polarity must match the source')])
    expect(flywheelCaseErrors({ ...valid, case: { ...valid.case, expect: 'x' } }, SHIPPED)).toEqual([expect.stringContaining('expect')])
  })

  it('flags an unshipped skill, an unknown tool and params that break the schema', () => {
    expect(flywheelCaseErrors({ ...valid, skill: 'my-todo-lists' }, SHIPPED)).toEqual(['skill my-todo-lists: not a shipped system skill (or "instructions")'])
    const errors = flywheelCaseErrors(
      { ...valid, case: { ...valid.case, loads: ['my-todo-lists'], tools: ['list_my_todos'], params: { list_actions: { filter: 'next_week' } } } },
      SHIPPED,
    )
    expect(errors).toEqual(
      expect.arrayContaining([
        'list_my_todos: not a registry or chat framework tool',
        expect.stringContaining('list_actions.filter: "next_week" is not one of'),
        'loads my-todo-lists: not a shipped system skill',
      ]),
    )
  })
})

describe('flywheel cases (cases/flywheel.json)', () => {
  it('names each candidate once, in the import order (by skill, then promotedAt)', () => {
    expect(Array.isArray(FLYWHEEL_CASES)).toBe(true)
    const ids = FLYWHEEL_CASES.map((c) => c.candidateId)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i), 'a candidate twice').toEqual([])
    const parsed = FLYWHEEL_CASES.map((c) => flywheelCaseSchema.safeParse(c)).flatMap((r) => (r.success ? [r.data] : []))
    if (parsed.length === FLYWHEEL_CASES.length) {
      expect(parsed.map((c) => c.candidateId), 'run scripts/eval-flywheel-import.ts (it keeps the order)').toEqual([...parsed].sort(compareFlywheelCases).map((c) => c.candidateId))
    }
  })

  it('joins each case to its skill\'s suite (a skill with no case file, or instructions, gets its own)', () => {
    const merged = new Map(skillEvalSuites().map((s) => [s.slug, s]))
    for (const entry of FLYWHEEL_CASES) {
      const suite = merged.get(entry.skill)
      expect(suite, `no suite for ${entry.skill}`).toBeDefined()
      expect(suite!.cases).toContain(entry.case)
    }
    expect([...merged.values()].reduce((n, s) => n + s.flywheel, 0)).toBe(FLYWHEEL_CASES.length)
  })

  FLYWHEEL_CASES.forEach((entry, i) => {
    it(`${i + 1}: ${entry.skill} — ${String((entry.case as { request?: unknown }).request).slice(0, 60)}`, () => {
      expect(flywheelCaseErrors(entry, SHIPPED)).toEqual([])
    })
  })
})

describe('skill eval case files', () => {
  it('SKILL_EVAL_CASES (../index.ts) imports every case file in the directory, and nothing else', () => {
    expect(suites.map((s) => s.slug), 'add each cases/<slug>.ts to SKILL_EVAL_CASES in src/lib/packs/skill-evals/index.ts').toEqual(caseFileSlugs())
  })

  const present = new Set(suites.map((s) => s.slug))
  const missing = REQUIRED_SLUGS.filter((s) => !present.has(s))
  if (missing.length > 0 && ALLOW_MISSING_CASE_FILES) {
    console.warn(`[skill-evals] no case file yet for: ${missing.join(', ')} (skipped; set ALLOW_MISSING_CASE_FILES = false once they land)`)
  }

  for (const slug of REQUIRED_SLUGS) {
    const skip = !present.has(slug) && ALLOW_MISSING_CASE_FILES
    it.skipIf(skip)(`${slug} has at least ${MIN_CASES} cases${skip ? ' (no case file yet)' : ''}`, () => {
      const suite = suites.find((s) => s.slug === slug)
      expect(suite, `src/lib/packs/skill-evals/cases/${slug}.ts is missing`).toBeDefined()
      expect(suite!.cases.length).toBeGreaterThanOrEqual(MIN_CASES)
    })
  }

  for (const [slug, packOnly] of Object.entries(EXPECTED_PACK_ONLY)) {
    const skill = SHIPPED.get(slug)
    it.skipIf(!skill && ALLOW_MISSING_CASE_FILES)(`${slug} is ${packOnly ? '' : 'not '}pack-only${skill ? '' : ' (not shipped yet)'}`, () => {
      expect(skill, `${slug} is not a shipped system skill`).toBeDefined()
      expect(isPackOnly(skill!)).toBe(packOnly)
    })
  }

  it('every pack-only shipped skill is tagged with an area, so a pack lists it', () => {
    for (const skill of SHIPPED.values()) {
      if (!isPackOnly(skill)) continue
      expect(isAreaKey(skill.area), `${skill.slug}: pack_only but its area ${JSON.stringify(skill.area)} is not an area`).toBe(true)
    }
  })

  for (const suite of suites) {
    describe(suite.slug, () => {
      it('is a shipped system skill', () => {
        expect(SHIPPED.has(suite.slug), `cases/${suite.slug}.ts: no shipped system skill has this slug`).toBe(true)
      })

      it('has cases, at least one of which loads it, and no request twice', () => {
        expect(suite.cases.length).toBeGreaterThan(0)
        expect(suite.cases.some((c) => Array.isArray(c.loads) && c.loads.includes(suite.slug)), `no case loads ${suite.slug}`).toBe(true)
        const requests = suite.cases.map((c) => c.request?.trim().toLowerCase())
        expect(requests.filter((r, i) => requests.indexOf(r) !== i)).toEqual([])
      })

      suite.cases.forEach((c, i) => {
        it(`case ${i + 1}: ${String(c.request).slice(0, 60)}`, () => {
          const shape = caseShapeErrors(c)
          expect(shape, 'case shape').toEqual([])
          expect(caseToolErrors(c), 'tools and params').toEqual([])
          expect(caseSkillErrors(c, SHIPPED), 'skills').toEqual([])
        })
      })
    })
  }
})
