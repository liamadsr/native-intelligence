// Ids made from names: the same name always gives the same UUID (a video's version for a platform is one video,
// made again in place when asked again).
import { sha256Hex } from './stable'

/** A UUID (version 8, name-based) fixed by `name`. */
export function uuidFor(name: string): string {
  const hex = sha256Hex(`studio:${name}`).slice(0, 32).split('')
  hex[12] = '8'
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  const h = hex.join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}
