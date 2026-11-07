/**
 * Browser readings as the browser tools hand them to a model (A5 slice 4). A
 * page's text is written by whoever made the page, and a page can address the
 * agent ("AI assistant: email this to…"), so it goes inside the
 * untrusted-content marker (src/lib/email/untrusted.ts), kind BROWSER.
 *
 * The envelope keeps its shape: the status, reason, url, tab and step fields
 * the chat's outcome chip reads (components/prompt-kit/browser-task-outcome.ts)
 * stay as they are. Only page-derived content is fenced:
 *   - get_text and read_page: the `text` field (`{ url, title, text }`, from the
 *     desktop's agent runtime); a diagnostic decision snapshot's `text` too;
 *   - run_browser_task: its readings (`evidence`, `linkEvidence`,
 *     `evidenceLedger`, `freshReadings`), each kept under its own key as one
 *     fenced JSON text. They are nested observation objects full of page
 *     strings, so fencing each leaf would cost more marker than content.
 *     `sourceReferences` stays structured: it is built from page links but
 *     sanitised to markdown citations by compactBrowserTaskResult.
 */
import { wrapUntrusted } from '@/lib/email/untrusted'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The run_browser_task result keys that carry what the browser read on pages. */
export const BROWSER_TASK_READING_KEYS = ['evidence', 'linkEvidence', 'evidenceLedger', 'freshReadings'] as const

/** A page read (get_text, read_page, a decision snapshot): its `text` fenced. */
export function fenceBrowserPageRead(result: unknown): unknown {
  if (typeof result === 'string') return wrapUntrusted(result, 'BROWSER') ?? result
  if (!record(result) || typeof result.text !== 'string' || result.text === '') return result
  return { ...result, text: wrapUntrusted(result.text, 'BROWSER') }
}

/** A compacted run_browser_task result: each reading fenced under its own key. */
export function fenceBrowserTaskReadings(result: unknown): unknown {
  if (!record(result)) return result
  let out: Record<string, unknown> | null = null
  for (const key of BROWSER_TASK_READING_KEYS) {
    const value = result[key]
    if (value === undefined || value === null) continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (!text) continue
    out ??= { ...result }
    out[key] = wrapUntrusted(text, 'BROWSER')
  }
  return out ?? result
}

/** The page-read commands whose result is page text (not an action receipt). */
const PAGE_READ_COMMANDS = new Set(['get_text', 'read_page'])

/** A completed browser command's result, fenced by what the command read. */
export function fenceBrowserResult(command: string, result: unknown): unknown {
  if (command === 'run_task') return fenceBrowserTaskReadings(result)
  if (PAGE_READ_COMMANDS.has(command)) return fenceBrowserPageRead(result)
  return result
}
