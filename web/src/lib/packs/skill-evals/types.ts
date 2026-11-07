/** The key parameters of one tool call. */
export type SkillEvalParams = Record<string, unknown>

export interface SkillEvalCase {
  /** What the person types. */
  request: string
  /** Skills the agent should load (by slug), in order; [] when none should load. */
  loads: string[]
  /** Tool names the agent should call, as an ordered SUBSEQUENCE of its calls. */
  tools: string[]
  /**
   * Key parameters per tool name (deep-partial match). One object: at least one
   * call of that tool matches it. A list of objects: EACH matches some call of
   * that tool, so a recipe that calls a tool several times can assert each call.
   */
  params?: Record<string, SkillEvalParams | SkillEvalParams[]>
  /** Tools that must NOT be called. */
  avoid?: string[]
  /**
   * Parameters per tool name that NO call of that tool may deep-partially
   * match (one object, or a list: no call may match any entry). The tool may
   * still be called otherwise: e.g. create_flow, but never with
   * `confirmed_with_user: true`.
   */
  forbidParams?: Record<string, SkillEvalParams | SkillEvalParams[]>
  /** Optional note on why. */
  why?: string
  /**
   * Every tool call must succeed: the run fails when any call errored or
   * answered `success: false` (INPUT_INVALID, REPEATED_FAILURE…). The
   * evals flywheel sets it on the cases it drafts from a failed turn.
   */
  noToolErrors?: boolean
}
