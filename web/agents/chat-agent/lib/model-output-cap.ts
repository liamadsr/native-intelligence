/**
 * The most of one workspace tool result the chat's model reads.
 *
 * Every model call of a turn re-reads every earlier tool result of the turn,
 * so one oversized result (a long page's text, a broad list, a big document)
 * is paid for on each later step and pushes the conversation toward
 * compaction (lib/compaction-window.ts). The display copy is already bounded
 * (src/lib/chat/eve/tool-output-truncation.ts, at the transport), but that
 * never reached the model: the model read every result whole. eve trims older
 * tool results only once it compacts (to 2K characters,
 * harness/compaction/engine.js toolResultCapHeuristic).
 *
 * The cap is generous: a transcript page (src/lib/ai/tools/captures.ts
 * TRANSCRIPT_PAGE_CHARS, 80K) and its JSON fit whole, so a tool that pages
 * keeps working. Past it, the model reads the head and the tail around a note
 * that says what was cut and how to get the rest. Only the model's copy is
 * cut: hooks and the channel still get the full `action.result`. An image
 * result (`content`) and an error pass through.
 */
import { toolOutput, type ToolModelOutput } from 'eve/tools'

/** A projected result past this many characters is cut (~30K tokens). */
export const TOOL_RESULT_MODEL_MAX_CHARS = 120_000
/** How much of the start a cut result keeps. */
export const TOOL_RESULT_MODEL_HEAD_CHARS = 100_000
/** How much of the end a cut result keeps. */
export const TOOL_RESULT_MODEL_TAIL_CHARS = 10_000

/** `s` cut to `n` UTF-16 units without splitting a surrogate pair at the end. */
function headOf(s: string, n: number): string {
  const cut = s.slice(0, n)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** The last `n` UTF-16 units without starting on the low half of a surrogate pair. */
function tailOf(s: string, n: number): string {
  const cut = s.slice(-n)
  const first = cut.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? cut.slice(1) : cut
}

/**
 * The model's copy of a projected result, cut to TOOL_RESULT_MODEL_MAX_CHARS
 * when it is longer: the same object when it fits (or is not text or JSON),
 * else a text result of its head, a note, and its tail.
 */
export function capToolModelOutput(projected: ToolModelOutput): ToolModelOutput {
  let text: string
  if (projected.type === 'text') text = projected.value
  else if (projected.type === 'json') {
    try {
      const s = JSON.stringify(projected.value ?? null)
      if (typeof s !== 'string') return projected
      text = s
    } catch {
      return projected
    }
  } else return projected
  if (text.length <= TOOL_RESULT_MODEL_MAX_CHARS) return projected
  const note =
    `\n\n[Dial8 cut this result to keep the conversation small: it was ${text.length} characters, ` +
    `and the middle ${text.length - TOOL_RESULT_MODEL_HEAD_CHARS - TOOL_RESULT_MODEL_TAIL_CHARS} were left out. ` +
    'If you need what was cut, call the tool again for a narrower page, filter or range.]\n\n'
  return toolOutput.text(headOf(text, TOOL_RESULT_MODEL_HEAD_CHARS) + note + tailOf(text, TOOL_RESULT_MODEL_TAIL_CHARS))
}
