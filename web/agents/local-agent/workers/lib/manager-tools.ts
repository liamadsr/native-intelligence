/**
 * The three tools a worker agent gets from Native Intelligence, served over
 * MCP (mcp-http.ts): the eve local agent's `report`, `ask_manager` and
 * `finish`. The agent works in the folder with its own tools; these are how
 * it talks back.
 *
 * The event is emitted when the call ARRIVES here, never sniffed from the
 * agent's output: under ACP a tool call carries a title and a kind, not a name
 * this adapter could rely on.
 *
 * `finish` takes an optional `pull_request`, with the same shape and limits as
 * our own agent's (../../tools/finish.ts): in an edit job the driver asks the
 * person on their Mac, at the end of the turn, with the launcher's own `push`
 * prompt (../../launcher/prompts.ts); in a read job there is nothing to push.
 */
import type { LocalAgentMode } from '../../lib/seatbelt.js'
import { managerText, type NormalizedEvent } from './protocol.js'

/** A pull request the agent asked for: what the `push` prompt shows (title 1–256 characters, body at most 60,000). */
export interface PullRequestAsk {
  readonly title: string
  readonly body?: string
}

export const PR_TITLE_MAX = 256
export const PR_BODY_MAX = 60_000

/** The MCP server's name, as the agent shows it (`mcp__ni__finish`). Not `workspace`: Claude Code reserves that name. */
export const MANAGER_SERVER = 'ni'

export interface ManagerToolDef {
  readonly name: 'report' | 'ask_manager' | 'finish'
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations: { readonly readOnlyHint: true; readonly openWorldHint: false }
}

export interface ManagerToolResult {
  readonly text: string
  readonly isError: boolean
}

const str = (description: string, maxLength: number) => ({ type: 'string', description, minLength: 1, maxLength })
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false })
const annotations = { readOnlyHint: true, openWorldHint: false } as const

export const MANAGER_TOOLS: readonly ManagerToolDef[] = [
  {
    name: 'report',
    description:
      'Report progress on the request: what you looked at, what you found, what you are about to do. ' +
      'Call it as you go, in a sentence or two. The person and the Native Intelligence agent see it.',
    inputSchema: object({ text: str('The progress note.', 4000) }, ['text']),
    annotations,
  },
  {
    name: 'ask_manager',
    description:
      'Ask the Native Intelligence agent (your manager) one question when you are blocked and cannot find the answer in the folder. ' +
      'Then end your turn and wait: the answer arrives as your next message.',
    inputSchema: object({ question: str('One clear question.', 2000) }, ['question']),
    annotations,
  },
  {
    name: 'finish',
    description:
      'Finish the request: give a summary of what you found or did, including anything that was blocked. ' +
      'Call it once the request is done, then end your turn. In a job that may change files, add pull_request only when the person or the request ' +
      'asked for a pull request: a title, and a description of what changed and why. The person is asked on their Mac before anything is pushed.',
    inputSchema: object(
      {
        summary: str('What you found or did, for the person and the Native Intelligence agent. In a job that changes files, its first line becomes the commit message.', 8000),
        pull_request: {
          type: 'object',
          description: 'Only when a pull request was asked for, and only in a job that may change files.',
          properties: {
            title: str('The pull request title.', PR_TITLE_MAX),
            body: { type: 'string', description: 'The pull request description, in Markdown: what changed and why.', maxLength: PR_BODY_MAX },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
      ['summary'],
    ),
    annotations,
  },
]

const FIELD = { report: 'text', ask_manager: 'question', finish: 'summary' } as const
const LIMIT = { report: 4000, ask_manager: 2000, finish: 8000 } as const
const REPLY = {
  report: 'Reported.',
  ask_manager: 'Question sent. End your turn now; the answer will arrive as your next message.',
  finish: 'Finished. End your turn now.',
} as const
const FINISH_WITH_PR = {
  edit: 'Finished. When your turn ends, the person is asked on their Mac whether to push the branch and open the pull request; the outcome arrives with your next message. End your turn now.',
  read: 'Finished. This job is read-only: nothing was changed and there is no branch to push, so no pull request will be opened. End your turn now.',
} as const

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/** `pull_request` checked as the push prompt will check it (prompts.ts normalizePrompt): the request, or why not. */
export function pullRequestFrom(v: unknown): { ask?: PullRequestAsk } | { error: string } {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) return { error: 'pull_request must be an object with a title' }
  const o = v as Record<string, unknown>
  const title = typeof o.title === 'string' ? o.title.replace(CONTROL_CHARS, '').trim() : ''
  if (title.length < 1 || title.length > PR_TITLE_MAX) return { error: `pull_request.title is 1–${PR_TITLE_MAX} characters` }
  if (o.body !== undefined && (typeof o.body !== 'string' || o.body.length > PR_BODY_MAX)) return { error: `pull_request.body is at most ${PR_BODY_MAX} characters` }
  return { ask: o.body === undefined ? { title } : { title, body: o.body as string } }
}

/**
 * The handlers. `emit` gets the `report` / `ask` / `finish` event for each
 * valid call; a bad call comes back as `isError` text the model can act on,
 * and emits nothing.
 */
export function createManagerTools(emit: (event: NormalizedEvent, pullRequest?: PullRequestAsk) => void, mode: LocalAgentMode = 'read') {
  return {
    async call(name: string, rawArgs: unknown, _signal: AbortSignal): Promise<ManagerToolResult> {
      if (name !== 'report' && name !== 'ask_manager' && name !== 'finish') return { text: `Unknown tool: ${name}`, isError: true }
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {}
      const field = FIELD[name]
      const v = args[field]
      if (typeof v !== 'string' || !v.trim()) return { text: `${field} is required`, isError: true }
      if (v.length > LIMIT[name]) return { text: `${field} is longer than ${LIMIT[name]} characters`, isError: true }
      const text = managerText(name, v)
      if (name !== 'finish') {
        emit(name === 'report' ? { kind: 'report', text } : { kind: 'ask', question: text })
        return { text: REPLY[name], isError: false }
      }
      const pr = pullRequestFrom(args.pull_request)
      if ('error' in pr) return { text: pr.error, isError: true }
      // A read job has nothing to push: a plain finish, and the agent is told so.
      const ask = mode === 'edit' ? pr.ask : undefined
      emit({ kind: 'finish', summary: text }, ask)
      return { text: pr.ask ? FINISH_WITH_PR[mode] : REPLY.finish, isError: false }
    },
  }
}

export type ManagerToolCall = ReturnType<typeof createManagerTools>['call']
