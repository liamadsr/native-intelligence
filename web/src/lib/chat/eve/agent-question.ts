/**
 * The clarifying-question shapes the agents' `ask_user` tool carries
 * (src/lib/ai/tools/ask-user.ts is the schema): the input the QuestionPicker
 * renders, and how the transport's `answerPermission` reads its reply.
 */

/** One option in a clarifying question (label + muted description). */
export interface AgentQuestionOption {
  label: string
  description?: string
}

/** One clarifying question: header chip, prompt, 2–4 options, single/multi. */
export interface AgentQuestion {
  question: string
  header: string
  options: AgentQuestionOption[]
  multiSelect: boolean
}

/** How an `answerPermission` call's `response` is meant. */
export interface AnswerPermissionOptions {
  /**
   * `response` holds words the person typed into the composer while the
   * question was open. They ANSWER it (the #681 rule,
   * docs/plans/always-on-agent.md §2b), never dismiss it. Without this flag a
   * `response` is the Skip / X dismissal ("(skipped)" / "(dismissed)").
   */
  typed?: boolean
}
