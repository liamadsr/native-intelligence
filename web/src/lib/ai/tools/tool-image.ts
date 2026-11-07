/**
 * Images a tool hands back to the model (get_attachment_content, read_chat_file).
 *
 * A tool's execute returns the image under two internal keys,
 * `__imageBase64` and `__imageMimeType`, beside its JSON. Who sees it:
 *   - the main chat's agent: its proxy's toModelOutput attaches the image for
 *     a model that reads one and says so to one that can't
 *     (agents/chat-agent/lib/chat-image-output.ts);
 *   - every other agent (runs, skill runs, the live agent): their tool routes
 *     strip it (withoutToolImage), since base64 handed to a model as text is
 *     ~70K tokens it then describes wrongly.
 *
 * A photo never rides a user message to an eve agent: eve stages a message's
 * file parts into a sandbox it provisions first (harness/attachment-staging.js),
 * and the agents are sandbox-free. A tool result is never staged.
 */

/** The internal keys an image rides back from a tool's execute. */
export const TOOL_IMAGE_BASE64 = '__imageBase64'
export const TOOL_IMAGE_MIME_TYPE = '__imageMimeType'

/** Said in place of an image the route stripped. */
export const TOOL_IMAGE_NOT_SHOWN = 'An image, not shown here: this agent does not view images.'

/**
 * A tool output without its image, with `note` saying so in `image` when it
 * had one. Anything else comes back as it was.
 */
export function withoutToolImage(output: unknown, note: string = TOOL_IMAGE_NOT_SHOWN): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output
  const o = output as Record<string, unknown>
  if (!(TOOL_IMAGE_BASE64 in o) && !(TOOL_IMAGE_MIME_TYPE in o)) return output
  const { [TOOL_IMAGE_BASE64]: _base64, [TOOL_IMAGE_MIME_TYPE]: _mimeType, ...rest } = o
  return { ...rest, image: note }
}

/** The longest edge a photo is shown at: what Anthropic models scale to anyway. */
export const MODEL_IMAGE_MAX_EDGE = 1568

/** An image as a model is shown it. */
export interface ModelImage {
  base64: string
  mediaType: string
  width: number
  height: number
}

/**
 * A photo as a model is shown it: turned upright, scaled to fit
 * MODEL_IMAGE_MAX_EDGE and re-encoded as a JPEG (on white, for a transparent
 * one), which is a few hundred KB where a phone photo is several MB. Null
 * when sharp can't read it. Never the original bytes: an image a provider
 * refuses (too large, a format it can't read) would stay in the session's
 * history and fail every later step, so only what sharp produced is shown.
 * sharp is loaded on first use (a native module), and its own pixel limit
 * refuses a decompression bomb.
 */
export async function imageForModel(bytes: Buffer): Promise<ModelImage | null> {
  try {
    const { default: sharp } = await import('sharp')
    const { data, info } = await sharp(bytes, { failOn: 'error' })
      .rotate()
      .resize({ width: MODEL_IMAGE_MAX_EDGE, height: MODEL_IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80 })
      .toBuffer({ resolveWithObject: true })
    return { base64: data.toString('base64'), mediaType: 'image/jpeg', width: info.width, height: info.height }
  } catch {
    return null
  }
}
