/**
 * What the model sees of an in-app browser screenshot.
 *
 * `screenshot_browser` (and `wait_for_browser_command`, when the command it
 * waits on was a screenshot) returns the JPEG as base64 inside its JSON result.
 * Handed to the model as-is, that is ~100K–830K characters of text on every
 * later call in the session. So the proxy's `toModelOutput` strips the base64
 * out of the JSON, and attaches the image as a real image part only for a model
 * that reads one.
 *
 * Only Anthropic models read an image in a tool result through the AI Gateway.
 * Probed 2026-09-30 with a 76 KB JPEG: Claude Haiku 4.5 answered correctly on
 * 1.4K input tokens; DeepSeek V4 Flash (alibaba) and Kimi K2.6/K3 (moonshotai)
 * got it as ~70K tokens of base64 text and described a page that wasn't there;
 * DeepSeek V4 Pro (deepseek) dropped it. Every other model gets a note instead.
 *
 * A mirror of agents/chat-agent/lib/screenshot-output.ts (also in
 * agents/work-agent/lib): the eve bundler can't share code across agents, and
 * agents/chat-agent/lib/__tests__/screenshot-output-drift.test.ts keeps the
 * copies identical. This agent picks its model once per session, so the
 * answer never changes mid-run.
 */
import { toolOutput, toolOutputPart } from 'eve/tools'

/** The browser tools whose result can carry a screenshot (src/lib/ai/tools/browser.ts). */
export const SCREENSHOT_TOOL_NAMES: ReadonlySet<string> = new Set(['screenshot_browser', 'wait_for_browser_command'])

/** The note a model that can't read the image gets in its place. */
export const SCREENSHOT_NOT_SHOWN =
  'Screenshot taken, but this model cannot view images. Use read_browser_page or get_browser_text to inspect the page.'

/** Whether a model reads an image in a tool result. A bare model id is an Anthropic one, as the model resolver treats it. */
export function modelReadsToolImages(model: string | null | undefined): boolean {
  if (typeof model !== 'string' || model.length === 0) return false
  return !model.includes('/') || model.startsWith('anthropic/')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The model's view of a browser tool result. A result without a screenshot
 * passes through unchanged. With one, the base64 never reaches the model as
 * text: `images` attaches it as an image part, otherwise a note replaces it.
 */
export function screenshotModelOutput(output: unknown, images: boolean) {
  const result = isRecord(output) ? output.result : undefined
  const base64 = isRecord(result) ? result.screenshotBase64 : undefined
  if (!isRecord(output) || !isRecord(result) || typeof base64 !== 'string' || base64.length === 0) {
    return toolOutput.json(output ?? null)
  }
  const { screenshotBase64: _base64, mediaType, ...rest } = result
  const summary = {
    ...output,
    result: { ...rest, screenshot: images ? 'attached as an image' : SCREENSHOT_NOT_SHOWN },
  }
  if (!images) return toolOutput.json(summary)
  return toolOutput.content([
    toolOutputPart.text(JSON.stringify(summary)),
    toolOutputPart.file(base64, { mediaType: typeof mediaType === 'string' && mediaType ? mediaType : 'image/jpeg' }),
  ])
}
