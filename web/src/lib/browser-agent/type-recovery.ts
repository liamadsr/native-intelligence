import { createHash } from 'node:crypto'
import type { BrowserObservation } from './task-contract'

/** A rejected replacement is reusable only for this exact live field state. */
export function browserTypeStateKey(observation: BrowserObservation, ref: string): string | null {
  const field = observation.elements.find(element => element.ref === ref)
  if (!field || !field.canType || field.forbidden || field.disabled) return null
  const { ref: _ref, ...state } = field
  return createHash('sha256').update(JSON.stringify([observation.documentId, observation.url, state])).digest('hex')
}

export function unavailableBrowserTypeRefs(observation: BrowserObservation, previous: unknown): string[] {
  const keys = new Set(Array.isArray(previous) ? previous.filter(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)).slice(-8) : [])
  return observation.elements.filter(field => {
    const key = browserTypeStateKey(observation, field.ref)
    return key !== null && keys.has(key)
  }).map(field => field.ref)
}

export function rememberBrowserTypeRefusal(observation: BrowserObservation, ref: string, previous: unknown): string[] {
  const keys = Array.isArray(previous) ? previous.filter(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)).slice(-8) : []
  const key = browserTypeStateKey(observation, ref)
  return key ? [...keys.filter(value => value !== key), key].slice(-8) : keys
}
