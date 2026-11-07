/**
 * One decision observation from the native app's page + embedded frames.
 *
 * Desktop runtimes from controller v8 answer a task snapshot with
 * {main, frames, inputCapable}: the main document's observation, one
 * observation per placed child frame (with its framePath and origin), and
 * whether the tab can receive real input. Each document reports its child
 * frames' content boxes (`childFrames`), so a frame's controls can be placed
 * in the tab's viewport. Older runtimes answer with the main observation
 * alone, which passes through unchanged.
 *
 * A frame's controls join the observation with refs scoped by frame key
 * ("f0e5"), only where their point is inside every enclosing frame's visible
 * box. CAPTCHA, payment and sign-in frames are never operated: their controls
 * and text are left out entirely. So are frames from a site the user blocked
 * the agent from (a LinkedIn widget on an allowed page), and everything inside
 * them.
 */
import { blockedSiteForUrl } from './blocked-sites'

const MAX_ELEMENTS = 100
const MAX_TEXT = 12000
const MAX_FIELDS = 40
const FIELD_BYTES = 6500

type Json = Record<string, unknown>
const record = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Hosts whose frames the agent must never operate, matched by suffix. The
 * desktop runtime (agent_runtime.js RESTRICTED_FRAME_HOSTS) enforces the same
 * list inside each frame; keep the two in step. */
const RESTRICTED_FRAME_HOSTS = [
  // CAPTCHA and bot challenges: never solved or clicked by the agent.
  'recaptcha.net', 'hcaptcha.com', 'challenges.cloudflare.com', 'arkoselabs.com', 'funcaptcha.com',
  'geetest.com', 'captcha-delivery.com', 'perimeterx.net', 'px-cloud.net',
  // Payments.
  'stripe.com', 'stripe.network', 'paypal.com', 'paypalobjects.com', 'braintreegateway.com', 'braintree-api.com',
  'adyen.com', 'checkout.com', 'squareup.com', 'klarna.com', 'affirm.com', 'pay.google.com', 'shop.app',
  // Sign-in and social actions.
  'accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com', 'facebook.com',
  'auth0.com', 'okta.com', 'onelogin.com',
]

/** True for a frame the agent must never act in (by origin, or reCAPTCHA's Google path). */
export function restrictedFrame(origin: string, url = ''): boolean {
  let host = ''
  try { host = new URL(origin).hostname.toLowerCase() } catch { return true }
  if (!host || RESTRICTED_FRAME_HOSTS.some(suffix => host === suffix || host.endsWith('.' + suffix))) return true
  try {
    const parsed = new URL(url)
    if (/(^|\.)google\.com$/.test(parsed.hostname) && parsed.pathname.startsWith('/recaptcha')) return true
  } catch { /* an unparseable URL is judged by its origin alone */ }
  return false
}

type Box = { left: number; top: number; right: number; bottom: number }
const intersect = (a: Box, b: Box): Box => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) })

export type FrameMeta = { key: string; path: number[]; origin: string; url: string; documentId: string
  observationId: number; interactionEpoch: number; x: number; y: number }

/** The native task snapshot as one observation (see file header). */
export function mergeFrameObservations(raw: unknown, blockedSites: readonly string[] = []): unknown {
  if (!record(raw) || !('main' in raw)) return raw
  const main = raw.main
  // Errors and startup sentinels keep their exact shape for the executor.
  if (!record(main) || !Array.isArray(main.elements)) return main
  const trustedInput = raw.inputCapable === true
  const { childFrames: _childFrames, framePath: _framePath, origin: _origin, ...observation } = main
  const elements = [...main.elements as Json[]]
  let text = typeof main.text === 'string' ? main.text : ''
  let textTruncated = main.textTruncated === true
  const evidence = record(main.evidence) ? { ...main.evidence } : undefined
  const fields = Array.isArray(evidence?.currentFields) ? [...evidence.currentFields as Json[]] : undefined
  const frames: FrameMeta[] = []

  const byPath = new Map<string, Json>()
  for (const child of (Array.isArray(raw.frames) ? raw.frames : []).filter(record)) {
    const path = child.framePath
    if (Array.isArray(path) && path.length > 0 && path.length <= 4 && path.every(index => Number.isInteger(index) && index >= 0))
      byPath.set(path.join('.'), child)
  }
  const viewport = record(main.viewport) && finite(main.viewport.width) && finite(main.viewport.height)
    ? { left: 0, top: 0, right: main.viewport.width, bottom: main.viewport.height } : undefined

  // Parents before children, so a skipped frame also hides everything inside it.
  const placed = new Map<string, { box: Box; x: number; y: number }>()
  const order = [...byPath.keys()].sort((a, b) => a.split('.').length - b.split('.').length || a.localeCompare(b, 'en', { numeric: true }))
  for (const key of order) {
    const child = byPath.get(key)!
    const path = key.split('.').map(Number)
    const parentKey = path.slice(0, -1).join('.')
    const parent = parentKey ? byPath.get(parentKey) : main
    const parentPlace = parentKey ? placed.get(parentKey) : viewport && { box: viewport, x: 0, y: 0 }
    if (!parent || !parentPlace) continue
    const geometry = (Array.isArray(parent.childFrames) ? parent.childFrames : []).filter(record)
      .find(frame => frame.index === path.at(-1))
    if (!geometry || geometry.visible !== true || ![geometry.x, geometry.y, geometry.width, geometry.height].every(finite)) continue
    const origin = typeof child.origin === 'string' ? child.origin : ''
    const url = typeof child.url === 'string' ? child.url : ''
    if (restrictedFrame(origin, url) || blockedSiteForUrl(origin, blockedSites) || blockedSiteForUrl(url, blockedSites)) continue
    // Ad frames can carry URLs longer than the observation allows; the check
    // above already used the full URL.
    if (origin.length > 400) continue
    if (typeof child.documentId !== 'string' || !Number.isInteger(child.observationId) || !Number.isInteger(child.interactionEpoch)) continue
    const x = parentPlace.x + (geometry.x as number), y = parentPlace.y + (geometry.y as number)
    const box = intersect(parentPlace.box, { left: x, top: y, right: x + (geometry.width as number), bottom: y + (geometry.height as number) })
    if (box.right <= box.left || box.bottom <= box.top) continue
    placed.set(key, { box, x, y })
    const frameKey = `f${frames.length}`
    frames.push({ key: frameKey, path, origin, url: url.slice(0, 2000), documentId: child.documentId, observationId: child.observationId as number,
      interactionEpoch: child.interactionEpoch as number, x, y })

    for (const element of (Array.isArray(child.elements) ? child.elements : []).filter(record)) {
      if (elements.length >= MAX_ELEMENTS) { textTruncated = true; break }
      const point = record(element.point) && finite(element.point.x) && finite(element.point.y) ? element.point : null
      if (!point || typeof element.ref !== 'string') continue
      const absolute = { x: (point.x as number) + x, y: (point.y as number) + y }
      // Only where the frame itself is visible in the tab can a real click land.
      if (absolute.x < box.left || absolute.x >= box.right || absolute.y < box.top || absolute.y >= box.bottom) continue
      elements.push({ ...element, ref: frameKey + element.ref, frame: frameKey, point: absolute })
    }
    const frameText = typeof child.text === 'string' ? child.text.trim() : ''
    if (frameText) {
      const section = `\n[Embedded frame ${origin}]\n${frameText}`
      const room = MAX_TEXT - text.length
      if (room > 0) text += section.slice(0, room)
      if (section.length > room) textTruncated = true
    }
    const childFields = record(child.evidence) && Array.isArray(child.evidence.currentFields) ? child.evidence.currentFields : []
    if (fields && evidence) {
      for (const field of childFields) {
        if (fields.length >= MAX_FIELDS || new TextEncoder().encode(JSON.stringify([...fields, field])).length > FIELD_BYTES) {
          evidence.currentFieldsTruncated = true
          break
        }
        fields.push(field as Json)
      }
    }
  }
  return {
    ...observation, elements, text, textTruncated, trustedInput,
    ...(evidence ? { evidence: { ...evidence, ...(fields ? { currentFields: fields } : {}) } } : {}),
    ...(frames.length ? { frames } : {}),
  }
}
