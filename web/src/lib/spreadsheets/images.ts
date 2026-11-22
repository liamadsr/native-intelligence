/**
 * Reading an image a person drops in: what kind it is (from its magic bytes,
 * never its name, since an .svg can carry script) and a content hash so two
 * copies of the same picture are stored once. Pure.
 */

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp'

export const IMAGE_MIME: Record<ImageKind, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** The kind of image the bytes are, by their signature, or null (SVG and anything else are refused). */
export function sniffImageType(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'gif'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  ) {
    return 'webp'
  }
  return null
}

/**
 * A stable content hash for dedup (not a cryptographic one): two 32-bit FNV-1a
 * passes, one forward and one with a different offset, joined as hex.
 */
export function hashBytes(bytes: Uint8Array): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < bytes.length; i++) {
    a ^= bytes[i]
    a = Math.imul(a, 0x01000193)
    b = Math.imul(b ^ bytes[i], 0x85ebca77)
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0')
  return `${hex(a)}${hex(b)}${bytes.length.toString(16)}`
}
