/**
 * A browser profile's identity: a UUIDv5 over `${userId}:${workspaceId}`.
 *
 * Every (user, workspace) has its own browser, with its own logins, cookies and
 * site storage, and this id names it. The desktop's WebKit data store used it
 * first (src/components/browser/browser-profiles.ts, which re-exports these until
 * the WebKit browser is retired); the cloud browser names its sandbox from it
 * (docs/plans/cloud-browser.md, C0). Changing the namespace or the name format
 * orphans every existing profile.
 */

/** Fixed namespace for profile ids (UUIDv5 over `${userId}:${workspaceId}`). */
export const PROFILE_NAMESPACE = '3f6f8d2e-5b1c-4a7e-9d40-6c2b1e8a9f17'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** SHA-1 (sync: the desktop's tab creation is synchronous up to the native call). */
function sha1(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const dv = new DataView(padded.buffer)
  const bits = bytes.length * 8
  dv.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000))
  dv.setUint32(padded.length - 4, bits >>> 0)
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = (x << 1) | (x >>> 31)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0
      e = d
      d = c
      c = ((b << 30) | (b >>> 2)) >>> 0
      b = a
      a = t
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  const out = new Uint8Array(20)
  const odv = new DataView(out.buffer)
  ;[h0, h1, h2, h3, h4].forEach((h, i) => odv.setUint32(i * 4, h))
  return out
}

/** RFC 4122 version-5 UUID of `name` in `namespace` (lowercase, hyphenated). */
export function uuidV5(name: string, namespace: string): string {
  const ns = namespace.toLowerCase()
  if (!UUID_RE.test(ns)) throw new Error('invalid namespace UUID')
  const nsBytes = new Uint8Array(16)
  const hex = ns.replace(/-/g, '')
  for (let i = 0; i < 16; i++) nsBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  const nameBytes = new TextEncoder().encode(name)
  const input = new Uint8Array(16 + nameBytes.length)
  input.set(nsBytes)
  input.set(nameBytes, 16)
  const h = sha1(input)
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const s = Array.from(h.subarray(0, 16), (x) => x.toString(16).padStart(2, '0')).join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

/** The browser profile of `userId` in `workspaceId` (stable, opaque). */
export function profileIdFor(userId: string, workspaceId: string): string {
  return uuidV5(`${userId}:${workspaceId}`, PROFILE_NAMESPACE)
}

export function isProfileId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

/** Every cloud browser sandbox of one database starts with this. */
export function cloudBrowserNamePrefix(namespace: string): string {
  return `browser-${namespace}-`
}

/**
 * The cloud browser's sandbox name for `userId` in `workspaceId`. `namespace`
 * names the database whose rows own it (config.ts, cloudBrowserNamespace).
 */
export function cloudBrowserSandboxName(userId: string, workspaceId: string, namespace: string): string {
  return `${cloudBrowserNamePrefix(namespace)}${profileIdFor(userId, workspaceId)}`
}
