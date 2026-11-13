/**
 * Mustache-lite template rendering for flow HTTP bodies.
 *
 * Supports the tokens listed in TEMPLATE_TOKENS. We deliberately do NOT
 * support arbitrary expressions, partials, conditionals, or anything else
 * that resembles a templating engine — the goal is "string interpolation
 * with a fixed vocabulary", not "let users execute logic in our process".
 *
 * Rendering is also JSON-aware: when a token's value is interpolated into
 * what looks like a JSON string literal (i.e. the token is wrapped in
 * double quotes), the value is JSON-escaped so newlines/quotes in titles
 * don't break the user's body. When interpolating into a non-quoted
 * position (e.g. an array element index) the value is left raw — the user
 * is responsible for valid JSON shape.
 */
import type { TriggerContext } from './types'
import type { RunnerEntityData } from './runner'

/**
 * Template context exposes one namespace per entity kind. Only the
 * namespace matching the entity's `kind` is populated; the others are
 * empty (so a token like `{{project.name}}` on an action flow renders to
 * an empty string, not a runtime error).
 *
 * `entity.*` is a kind-agnostic alias of whichever namespace is
 * populated — convenient for templates that want to work across types.
 */
export interface TemplateContext {
  // Action-only namespace. Populated iff kind === 'action'.
  action: {
    id: string
    identifier: string | null
    title: string
    status_id: string
    status_name: string | null
    status_category: string | null
    priority: number | null
    assignees: { id: string; display_name: string | null }[]
    labels: { id: string; name: string }[]
    url: string
  }
  // Project-only namespace. Populated iff kind === 'project'.
  project: {
    id: string
    name: string
    description: string | null
    status_value: string
    url: string
  }
  // Initiative-only namespace. Populated iff kind === 'initiative'.
  initiative: {
    id: string
    name: string
    description: string | null
    status_value: string
    url: string
  }
  // Milestone-only namespace. Populated iff kind === 'milestone'.
  milestone: {
    id: string
    name: string
    description: string | null
    status_value: string
    project_id: string
    url: string
  }
  // Kind-agnostic alias of whichever namespace above is populated. Useful
  // for templates that don't care about the entity type.
  entity: {
    id: string
    name: string
    status: string
    url: string
  }
  // Capture namespace. Populated only for capture_processed fires; null
  // otherwise (a null namespace resolves every token under it to '').
  capture: {
    id: string
    title: string | null
  } | null
  trigger: {
    type: string
    entity_type: string
    from_status_id: string | null
    to_status_id: string | null
    fired_at: string
    /** The fire's capture under the trigger too (`{{trigger.capture.title}}`); null off a call fire. */
    capture: { id: string; title: string | null } | null
    /** A quote_received fire's quote (`{{trigger.quote_id}}`); null otherwise. */
    quote_id: string | null
    /**
     * An email_received fire's thread and account; null otherwise. Ids only:
     * no sender, whose address (its local part too) is a stranger's text. A
     * step reads the mail, sender included, with read_email.
     */
    email_thread_id: string | null
    email_account_id: string | null
    /** A chat_message fire's message, channel and thread root; null otherwise. */
    chat_message_id: string | null
    chat_channel_id: string | null
    chat_thread_root_id: string | null
    /** A document_created fire's document; null otherwise. */
    document_id: string | null
  }
  workspace: {
    id: string
  }
  /**
   * F4 data passing: each earlier step's stored output, by step id
   * (`{{steps.<id>.output}}`; step-data.ts). Only the steps that ran on this
   * fire are here: a reference to any other fails loudly.
   */
  steps: Record<string, { output: string }>
}

/**
 * The full list of tokens that flows can reference. Surfaced in the UI as
 * autocomplete hints so users don't guess. Per-entity-type tokens are
 * grouped — UI can filter by the flow's entity_type.
 */
export const TEMPLATE_TOKENS = [
  // Entity-agnostic
  '{{entity.id}}',
  '{{entity.name}}',
  '{{entity.status}}',
  '{{entity.url}}',
  // Action
  '{{action.id}}',
  '{{action.identifier}}',
  '{{action.title}}',
  '{{action.status_id}}',
  '{{action.status_name}}',
  '{{action.status_category}}',
  '{{action.priority}}',
  '{{action.labels}}',
  '{{action.url}}',
  // Project
  '{{project.id}}',
  '{{project.name}}',
  '{{project.description}}',
  '{{project.status_value}}',
  '{{project.url}}',
  // Initiative
  '{{initiative.id}}',
  '{{initiative.name}}',
  '{{initiative.description}}',
  '{{initiative.status_value}}',
  '{{initiative.url}}',
  // Milestone
  '{{milestone.id}}',
  '{{milestone.name}}',
  '{{milestone.description}}',
  '{{milestone.status_value}}',
  '{{milestone.project_id}}',
  '{{milestone.url}}',
  // Capture (capture_processed fires only)
  '{{capture.id}}',
  '{{capture.title}}',
  // Trigger
  '{{trigger.type}}',
  '{{trigger.entity_type}}',
  '{{trigger.from_status_id}}',
  '{{trigger.to_status_id}}',
  '{{trigger.fired_at}}',
  // quote_received fires only: the quote's id (read it with get_quote)
  '{{trigger.quote_id}}',
  // email_received fires only: ids to read the mail with read_email (never its words, nor its sender)
  '{{trigger.email_thread_id}}',
  '{{trigger.email_account_id}}',
  // chat_message fires only: ids to read it with read_team_chat_message (never its words)
  '{{trigger.chat_message_id}}',
  '{{trigger.chat_channel_id}}',
  '{{trigger.chat_thread_root_id}}',
  // document_created fires only: the document's id (read it with get_document)
  '{{trigger.document_id}}',
  // Workspace
  '{{workspace.id}}',
  // F4 data passing: the call's capture under the trigger, and an earlier step's output (by its id)
  '{{trigger.capture.title}}',
  '{{trigger.capture.id}}',
  '{{steps.<step id>.output}}',
] as const

/** Every token: word characters, dots and dashes inside double braces (a step id may be a uuid). */
const TOKEN_RE = /\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/g
/** A string that is exactly one token, nothing around it. */
const WHOLE_TOKEN_RE = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/

/** The path inside one token (`{{ steps.a.output }}` gives ['steps', 'a', 'output']). */
function tokenPath(token: string): string[] {
  return token.slice(2, -2).trim().split('.')
}

type Lookup = { found: true; value: unknown } | { found: false }

/** Walk a path through the context: own keys only (never a prototype member). */
function lookup(path: string[], ctx: TemplateContext): Lookup {
  let cursor: unknown = ctx
  for (const segment of path) {
    if (cursor && typeof cursor === 'object' && Object.hasOwn(cursor as object, segment)) {
      cursor = (cursor as Record<string, unknown>)[segment]
    } else {
      return { found: false }
    }
  }
  return { found: true, value: cursor }
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** Every token path a value's strings reference (deep), for the save-time checks. */
export function templateReferences(value: unknown): string[][] {
  const out: string[][] = []
  const walk = (v: unknown, depth: number) => {
    if (depth > 20) return
    if (typeof v === 'string') {
      for (const m of v.match(TOKEN_RE) ?? []) out.push(tokenPath(m))
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1)
    }
  }
  walk(value, 0)
  return out
}

/** The step ids a value references (`{{steps.<id>.…}}`), de-duplicated. */
export function stepReferences(value: unknown): string[] {
  return [...new Set(templateReferences(value).filter((p) => p[0] === 'steps' && p[1]).map((p) => p[1]))]
}

/** The namespaces whose own members render (as JSON when structured). */
const NAMESPACES = new Set(['action', 'project', 'initiative', 'milestone', 'entity', 'capture', 'trigger', 'workspace'])

/** A path a template may name: a listed token, a namespace, or `steps.<id>.output`. Pure (save time). */
export function isKnownTemplatePath(path: string[]): boolean {
  if (path[0] === 'steps') return path.length === 3 && !!path[1] && path[2] === 'output'
  const joined = path.join('.')
  if (TEMPLATE_TOKENS.some((t) => !t.includes('<') && t.slice(2, -2) === joined)) return true
  // action.assignees and the like: a namespace's own member.
  return path.length <= 2 && NAMESPACES.has(path[0])
}

/** Why a strict render failed: the first reference that has no value on this fire. */
export interface MissingReference {
  ok: false
  /** The token as written (`{{steps.summarise.output}}`). */
  reference: string
  /** One plain line for the run's history. */
  error: string
}

function missing(path: string[]): MissingReference {
  const reference = `{{${path.join('.')}}}`
  const error =
    path[0] === 'steps'
      ? `${reference} has no value: step "${path[1] ?? ''}" did not run before this one on this fire`
      : `${reference} has no value on this fire`
  return { ok: false, reference, error }
}

/**
 * Render one string STRICTLY (F4): every token must resolve to a value that
 * exists on this fire. A null namespace (no capture on a schedule fire) or an
 * unknown path is missing, and the render fails with the first one. A string
 * that is exactly one token keeps the value's own type (a number stays a
 * number); anything else interpolates as text. `transformValue` sees each
 * substituted value as text. Deterministic: a fixed vocabulary of paths, and
 * nothing in a template is ever run.
 */
export function renderStrict(
  template: string,
  ctx: TemplateContext,
  options: { transformValue?: (value: string, path: string[]) => string } = {},
): { ok: true; value: unknown } | MissingReference {
  const whole = WHOLE_TOKEN_RE.exec(template)
  if (whole) {
    const path = whole[1].split('.')
    const hit = lookup(path, ctx)
    if (!hit.found || hit.value === null || hit.value === undefined) return missing(path)
    if (options.transformValue) return { ok: true, value: options.transformValue(stringify(hit.value), path) }
    return { ok: true, value: hit.value }
  }
  let failure: MissingReference | null = null
  const value = template.replace(TOKEN_RE, (match) => {
    if (failure) return ''
    const path = tokenPath(match)
    const hit = lookup(path, ctx)
    if (!hit.found || hit.value === null || hit.value === undefined) {
      failure = missing(path)
      return ''
    }
    const text = stringify(hit.value)
    return options.transformValue ? options.transformValue(text, path) : text
  })
  return failure ?? { ok: true, value }
}

/**
 * Render every string in a JSON value strictly (a call_tool input). Keys are
 * never templates. Fails with the first missing reference.
 */
export function renderInputStrict(
  input: unknown,
  ctx: TemplateContext,
  depth = 0,
): { ok: true; value: unknown } | MissingReference {
  if (depth > 20) return { ok: true, value: input }
  if (typeof input === 'string') return renderStrict(input, ctx)
  if (Array.isArray(input)) {
    const out: unknown[] = []
    for (const v of input) {
      const r = renderInputStrict(v, ctx, depth + 1)
      if (!r.ok) return r
      out.push(r.value)
    }
    return { ok: true, value: out }
  }
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const r = renderInputStrict(v, ctx, depth + 1)
      if (!r.ok) return r
      out[k] = r.value
    }
    return { ok: true, value: out }
  }
  return { ok: true, value: input }
}

/**
 * The first `{{steps.…}}` reference in `template` that this fire has no
 * output for, or null. The lenient renderer (http_post bodies, skill
 * instructions) still renders an unknown entity token as '' as it always
 * has, but a step reference never silently renders empty (F4): the step
 * fails and the run says why.
 */
export function missingStepReference(template: string, ctx: TemplateContext): MissingReference | null {
  for (const path of templateReferences(template)) {
    if (path[0] !== 'steps') continue
    const hit = lookup(path, ctx)
    if (!hit.found || hit.value === null || hit.value === undefined) return missing(path)
  }
  return null
}

function resolveToken(token: string, ctx: TemplateContext): string {
  // Strip {{ }} and split on dots. Own keys only (never a prototype member).
  const hit = lookup(tokenPath(token), ctx)
  return hit.found ? stringify(hit.value) : ''
}

/**
 * Render a template string. Returns the rendered string.
 *
 * If `jsonAware` is true (default for body_template), token values that
 * would land inside a JSON string literal get backslash-escaped so the
 * resulting body remains valid JSON. We detect this with a simple "is the
 * token immediately preceded by an unescaped double quote and immediately
 * followed by an unescaped double quote" heuristic — not perfect, but
 * covers the common case of body templates like `{"text": "{{action.title}}"}`.
 */
export function renderTemplate(
  template: string,
  ctx: TemplateContext,
  options: {
    jsonAware?: boolean
    /**
     * Applied to each substituted value before any JSON escaping: a run_agent
     * task fences entity / trigger text (which a meeting or an email may have
     * written) as untrusted. The template's own text is never passed through it.
     */
    transformValue?: (value: string) => string
  } = {},
): string {
  const jsonAware = options.jsonAware ?? false
  return template.replace(TOKEN_RE, (match, offset) => {
    const resolved = resolveToken(match, ctx)
    const value = options.transformValue ? options.transformValue(resolved) : resolved
    if (!jsonAware) return value
    // Are we sitting between two double quotes? Look at the nearest quote
    // characters before and after this token in the original template.
    const before = template.slice(0, offset)
    const after = template.slice(offset + match.length)
    const insideJsonString =
      /"[^"\n]*$/.test(before) && /^[^"\n]*"/.test(after)
    if (!insideJsonString) return value
    // Escape the JSON string contents — quote, backslash, control chars.
    // We do NOT wrap in quotes ourselves; the template already provides them.
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
  })
}

// Empty placeholder shapes so unused namespaces resolve to empty strings
// rather than `undefined`. The token resolver returns '' for missing keys
// anyway, but populating with defined empties keeps the type clean.
const EMPTY_ACTION: TemplateContext['action'] = {
  id: '',
  identifier: null,
  title: '',
  status_id: '',
  status_name: null,
  status_category: null,
  priority: null,
  assignees: [],
  labels: [],
  url: '',
}
const EMPTY_NAMED_ENTITY: {
  id: string
  name: string
  description: string | null
  status_value: string
  url: string
} = {
  id: '',
  name: '',
  description: null,
  status_value: '',
  url: '',
}

/**
 * Build a TemplateContext from the runner entity data + trigger metadata.
 * Switches on the entity's discriminator to populate the right namespace.
 *
 * Entity-less triggers (schedule, capture_processed) pass `entity: null` —
 * every entity namespace stays empty and the workspace id comes from
 * `extras.workspaceId`. capture_processed fires additionally populate the
 * capture namespace via `extras.capture`.
 */
export function buildTemplateContext(
  entity: RunnerEntityData | null,
  trigger: TriggerContext,
  appBaseUrl: string,
  extras: {
    capture?: { id: string; title: string | null } | null
    /** Required when entity is null (nothing else carries the workspace). */
    workspaceId?: string
    /** F4: the outputs of the steps that ran before this one on this fire. */
    steps?: Record<string, { output: string }>
  } = {},
): TemplateContext {
  const base: TemplateContext = {
    action: EMPTY_ACTION,
    project: { ...EMPTY_NAMED_ENTITY },
    initiative: { ...EMPTY_NAMED_ENTITY },
    milestone: { ...EMPTY_NAMED_ENTITY, project_id: '' },
    entity: { id: '', name: '', status: '', url: '' },
    capture: extras.capture ?? null,
    trigger: {
      type: trigger.type,
      entity_type: trigger.entity_type ?? '',
      from_status_id: trigger.from_status_id,
      to_status_id: trigger.to_status_id,
      fired_at: trigger.fired_at,
      capture: extras.capture ?? null,
      quote_id: trigger.quote_id ?? null,
      email_thread_id: trigger.email_thread_id ?? null,
      email_account_id: trigger.email_account_id ?? null,
      chat_message_id: trigger.chat_message_id ?? null,
      chat_channel_id: trigger.chat_channel_id ?? null,
      chat_thread_root_id: trigger.chat_thread_root_id ?? null,
      document_id: trigger.document_id ?? null,
    },
    workspace: {
      id: entity?.workspace_id ?? extras.workspaceId ?? '',
    },
    steps: extras.steps ?? {},
  }

  if (!entity) return base

  switch (entity.kind) {
    case 'action': {
      const url = `${appBaseUrl}/account?action=${entity.id}`
      base.action = {
        id: entity.id,
        identifier: entity.identifier,
        title: entity.title,
        status_id: entity.status_id,
        status_name: entity.status_name,
        status_category: entity.status_category,
        priority: entity.priority,
        assignees: entity.assignees,
        labels: entity.labels,
        url,
      }
      base.entity = {
        id: entity.id,
        name: entity.title,
        status: entity.status_name ?? entity.status_id,
        url,
      }
      return base
    }
    case 'project': {
      const url = `${appBaseUrl}/account?project=${entity.id}`
      base.project = {
        id: entity.id,
        name: entity.name,
        description: entity.description,
        status_value: entity.status_value,
        url,
      }
      base.entity = {
        id: entity.id,
        name: entity.name,
        status: entity.status_value,
        url,
      }
      return base
    }
    case 'initiative': {
      const url = `${appBaseUrl}/account?initiative=${entity.id}`
      base.initiative = {
        id: entity.id,
        name: entity.name,
        description: entity.description,
        status_value: entity.status_value,
        url,
      }
      base.entity = {
        id: entity.id,
        name: entity.name,
        status: entity.status_value,
        url,
      }
      return base
    }
    case 'milestone': {
      const url = `${appBaseUrl}/account?milestone=${entity.id}`
      base.milestone = {
        id: entity.id,
        name: entity.name,
        description: entity.description,
        status_value: entity.status_value,
        project_id: entity.project_id,
        url,
      }
      base.entity = {
        id: entity.id,
        name: entity.name,
        status: entity.status_value,
        url,
      }
      return base
    }
    default: {
      // Exhaustiveness check: if RunnerEntityData grows a new variant and
      // someone forgets to add a case here, the type system catches it at
      // compile time. The runtime throw is belt-and-suspenders for the
      // case where TS is bypassed (e.g. a JSON-deserialized payload).
      const _exhaustive: never = entity
      throw new Error(
        `buildTemplateContext: unhandled entity kind ${JSON.stringify(_exhaustive)}`,
      )
    }
  }
}
