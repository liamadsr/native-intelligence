/**
 * Words in a video that can be someone else's, as the agent reads them and as it writes them back.
 *
 *   fenced(text, kind)   a read: a layer's words (a caption can be what someone in an imported clip said), a media
 *                        file's name (a file brought in from a link is named by whoever made it), the transcript of
 *                        placed footage. Inside the untrusted-content marker (src/lib/email/untrusted.ts), so the
 *                        agent reads them as data (get_studio_video, list_studio_assets).
 *   unfenceArgs(value)   a write: the agent copying a value it read back into a command (update_layer's text with
 *                        the words it read, unchanged) gets the words, never the marker. A value that is a whole
 *                        fence is taken out of it; any other marker left in a value refuses the write, so no marker
 *                        ever lands in a layer, a beat or a script. Defused markers inside the words (the fence's own
 *                        "(quoted)" forms) are words and stay.
 *
 * Pure.
 */
import { untrustedPrefix, UNTRUSTED_EMAIL_SUFFIX, wrapUntrusted, type UntrustedKind } from '@/lib/email/untrusted'
import { StudioError } from '@/lib/studio/server/errors'

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A whole fence, as wrapUntrusted writes it, of any kind: its words in group 1. */
const WHOLE = new RegExp(`^${escape(untrustedPrefix('KIND' as UntrustedKind)).replace('KIND', '[A-Z]+')}([\\s\\S]*)${escape(UNTRUSTED_EMAIL_SUFFIX)}$`)
/** An opening or an end marker however it is spelled (the shapes untrusted.ts defuses). */
const OPEN = /[[［【][\s_-]*untrusted[\s_-]+(?:[a-z]+[\s_-]+)?content(?![a-z])/i
const END = /[[［【][\s_-]*end[\s_-]+(?:of[\s_-]+)?(?:the[\s_-]+)?untrusted[\s_-]+(?:[a-z]+[\s_-]+)?content[\s_-]*[\]］】]/i

/** Text that can be someone else's, fenced as data; an empty text stays empty. Pure. */
export function fenced(text: string, kind: UntrustedKind): string {
  return text ? (wrapUntrusted(text, kind) ?? text) : text
}

/** The words of a value the agent wrote: out of a whole fence, and refused with a marker anywhere else. Pure. */
export function unfenced(value: string): string {
  const words = WHOLE.exec(value)?.[1] ?? value
  if (OPEN.test(words) || END.test(words))
    throw new StudioError('A value holds the untrusted-content marker: write only the words inside it (they are what the video has), never the marker itself.')
  return words
}

/** Every string in a command's arguments, unfenced (unfenced). Pure. */
export function unfenceArgs<T>(value: T): T {
  if (typeof value === 'string') return unfenced(value) as T
  if (Array.isArray(value)) return value.map((v) => unfenceArgs(v)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unfenceArgs(v)])) as T
  return value
}
