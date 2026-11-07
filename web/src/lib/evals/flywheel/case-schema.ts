/**
 * The evals flywheel's case schema (docs/plans/always-on-agent.md §8): the
 * shape a reviewer promotes a candidate into (/admin/evals), the export
 * carries and cases/flywheel.json holds. A case is exactly a chat skill eval
 * case (src/lib/packs/skill-evals/types.ts SkillEvalCase); a test holds the
 * two together, so a field added to one and not the other fails.
 *
 * Shape only: whether its tools exist and its params fit their schemas is the
 * static test's job (src/lib/packs/skill-evals/__tests__/skill-evals-static.test.ts),
 * which runs on cases/flywheel.json in every build.
 *
 * Client-safe (no server imports): the admin editor validates with it.
 */
import { z } from 'zod'
import { jsonbTextBytes } from './bytes'
import { EVAL_CANDIDATE_SOURCES, FLYWHEEL_LIMITS, polarityOf } from './types'

/** A skill's slug (kebab-case), or `instructions` for the core instructions. */
export const FLYWHEEL_SKILL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const flywheelSkillSchema = z
  .string()
  .regex(FLYWHEEL_SKILL_RE, 'a skill slug in kebab-case, or "instructions"')
  .max(100)

const nameList = z.array(z.string().trim().min(1, 'a non-empty name'))
const paramsObject = z.record(z.string(), z.unknown())
const paramsByTool = z.record(z.string(), z.union([paramsObject, z.array(paramsObject).min(1)]))

export const flywheelSkillCaseSchema = z
  .strictObject({
    /** What the person types. */
    request: z.string().trim().min(1, 'the request the person types').max(FLYWHEEL_LIMITS.request),
    /** Skills the agent should load, in order; [] when none should. */
    loads: nameList,
    /** Tools the agent should call, as an ordered subsequence of its calls. */
    tools: nameList,
    params: paramsByTool.optional(),
    avoid: nameList.optional(),
    forbidParams: paramsByTool.optional(),
    why: z.string().max(FLYWHEEL_LIMITS.reason).optional(),
    /** Every tool call must succeed (no output-error, no `success: false`). */
    noToolErrors: z.boolean().optional(),
  })
  .superRefine((c, ctx) => {
    // The same cross-field rules as caseShapeErrors (src/lib/packs/skill-evals/index.ts).
    const avoid = c.avoid ?? []
    for (const t of avoid) {
      if (c.tools.includes(t)) ctx.addIssue({ code: 'custom', path: ['avoid'], message: `${t} is in both tools and avoid` })
    }
    for (const t of Object.keys(c.params ?? {})) {
      if (avoid.includes(t)) ctx.addIssue({ code: 'custom', path: ['params', t], message: `params for ${t}, which is in avoid` })
    }
    for (const t of Object.keys(c.forbidParams ?? {})) {
      if (avoid.includes(t)) ctx.addIssue({ code: 'custom', path: ['forbidParams', t], message: `forbidParams for ${t}, which is in avoid (avoid already forbids every call)` })
    }
  })

export type FlywheelSkillCase = z.infer<typeof flywheelSkillCaseSchema>

/** The keys of a flywheel case, for the test that holds it to SkillEvalCase. */
export const FLYWHEEL_SKILL_CASE_KEYS = Object.keys(flywheelSkillCaseSchema.shape) as Array<keyof FlywheelSkillCase>

/** One promoted case as exported (types.ts FlywheelCase, with its case typed). */
export const flywheelCaseSchema = z
  .strictObject({
    candidateId: z.string().trim().min(1).max(100),
    skill: flywheelSkillSchema,
    source: z.enum(EVAL_CANDIDATE_SOURCES),
    polarity: z.enum(['bad', 'good']),
    promotedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'an ISO timestamp'),
    case: flywheelSkillCaseSchema,
  })
  .refine((c) => c.polarity === polarityOf(c.source), { path: ['polarity'], message: 'polarity must match the source (a thumbs-up is good, every other source bad)' })

export type TypedFlywheelCase = z.infer<typeof flywheelCaseSchema>

/** The draft a reviewer saves: which skill, and the case. */
export const caseDraftSchema = z.strictObject({
  skill: flywheelSkillSchema,
  case: flywheelSkillCaseSchema,
})

/** zod's issues as one line: `path: message; path: message`. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.map(String).join('.')
      return path ? `${path}: ${i.message}` : i.message
    })
    .join('; ')
}

/**
 * Check a reviewer's case draft before it is saved or promoted: the skill a
 * kebab-case slug (or `instructions`), the case a SkillEvalCase with a
 * request, and the whole within FLYWHEEL_LIMITS.caseDraftBytes (migration
 * 349's check on case_draft).
 */
export function validateCaseDraft(input: unknown): { ok: true; value: { skill: string; case: FlywheelSkillCase } } | { ok: false; error: string } {
  const parsed = caseDraftSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: formatIssues(parsed.error) }
  // Measured as the check measures it (`case_draft::text`, a space after every `:` and `,`).
  const bytes = jsonbTextBytes(parsed.data)
  if (bytes > FLYWHEEL_LIMITS.caseDraftBytes) {
    return { ok: false, error: `the case is ${bytes} bytes; the most is ${FLYWHEEL_LIMITS.caseDraftBytes}` }
  }
  return { ok: true, value: parsed.data }
}
