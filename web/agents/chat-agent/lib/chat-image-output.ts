/**
 * What the model sees of a photo a tool reads back: read_chat_file on an image
 * the person uploaded in chat.
 *
 * The chat's photos never ride the user's message: an eve file part makes the
 * framework provision a sandbox (harness/attachment-staging.js), and this agent
 * is sandbox-free. The message names each photo with its storage_path, and the
 * model calls read_chat_file, whose JSON carries the scaled image under
 * `__imageBase64` / `__imageMimeType` (src/lib/ai/tools/tool-image.ts). This
 * proxy `toModelOutput` takes the base64 out of the JSON and attaches it as an
 * image part for a model that reads one (an Anthropic model: see
 * screenshot-output.ts for the probe); every other model gets a note instead
 * of ~70K tokens of base64 it would describe wrongly. In the cloud this agent
 * has no sandbox, so an attached image costs no sandbox either. The Mac body
 * has one (the person's folder), and eve stages a tool result's media into it,
 * so there the image is never attached (tools/workspace_tools.ts) and the
 * model gets the Mac's note.
 */
import { toolOutput, toolOutputPart } from 'eve/tools'
import type { ReadFileToolOutput } from 'eve/tools/read_file'
import { isMacHost } from './host.js'

/** The tools whose result can carry a photo for the model. */
export const CHAT_IMAGE_TOOL_NAMES: ReadonlySet<string> = new Set(['read_chat_file'])

/** The note a model that can't read the image gets in its place. */
export const CHAT_IMAGE_NOT_SHOWN =
  "This model can't view images, so the photo isn't shown. Tell the person, and that switching the chat to a Claude model lets you look at it."

/** The Mac body's note: photos are never shown there (see the header). */
export const MAC_CHAT_IMAGE_NOT_SHOWN =
  "Photos aren't shown to you on the Mac. If you need what's in it, say so: the person, or the Dial8 agent in the cloud, can look at it."

/**
 * The Mac body's `read_file` description: eve's, without its line that images
 * and PDFs are shown as files (they never are on the Mac).
 */
export const MAC_READ_FILE_DESCRIPTION = [
  'Read a file in /workspace, the folder the person shared. If the path does not exist, an error is returned.',
  '',
  'Usage:',
  '- The filePath parameter must be an absolute path, such as /workspace/src/index.ts.',
  '- By default, this tool returns up to 2000 lines from the start of the file.',
  '- The offset parameter is the line number to start from (1-indexed). To read later sections, call this tool again with a larger offset.',
  '- Contents are returned with each line prefixed by its line number as `<line>: <content>`.',
  '- Any line longer than 2000 characters is truncated.',
  "- Images and PDFs are not shown to you here: you get a note instead of their contents.",
  '- Call this tool in parallel when you know there are multiple files you want to read. Avoid tiny repeated slices; read a larger window.',
].join('\n')

/** The Mac body's note for an image or PDF read from the folder (eve's read_file). */
export const MAC_FILE_NOT_SHOWN =
  "Images and PDFs aren't shown to you on the Mac, so this file's contents aren't attached. Work from text files, or say what you need from it."

/**
 * The Mac body's `read_file` model output (tools/read_file.ts): eve's own
 * attaches an image or PDF as a file part, which eve stages into the sandbox
 * (see the header). This one never does: a file becomes its text and the
 * Mac's note; everything else is the output as JSON, as eve's.
 */
export function macReadFileModelOutput(output: ReadFileToolOutput) {
  if (output.file === undefined) return toolOutput.json(output)
  return toolOutput.json({ ...output, content: `${output.content} ${MAC_FILE_NOT_SHOWN}` })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The model's view of a read_chat_file result. A result without an image
 * passes through unchanged. With one, the base64 never reaches the model as
 * text: `images` attaches it as an image part, otherwise a note replaces it.
 */
export function chatImageModelOutput(output: unknown, images: boolean) {
  const base64 = isRecord(output) ? output.__imageBase64 : undefined
  if (!isRecord(output) || typeof base64 !== 'string' || base64.length === 0) {
    return toolOutput.json(output ?? null)
  }
  const { __imageBase64: _base64, __imageMimeType: mediaType, ...rest } = output
  const summary = { ...rest, image: images ? 'attached as an image' : isMacHost() ? MAC_CHAT_IMAGE_NOT_SHOWN : CHAT_IMAGE_NOT_SHOWN }
  if (!images) return toolOutput.json(summary)
  return toolOutput.content([
    toolOutputPart.text(JSON.stringify(summary)),
    toolOutputPart.file(base64, { mediaType: typeof mediaType === 'string' && mediaType ? mediaType : 'image/jpeg' }),
  ])
}
