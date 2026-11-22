/**
 * Undo and redo, as changes to single items. A step holds, for each item it
 * touched, what the item was and what it became. Undoing puts back only
 * those items, so what other people changed elsewhere in the meantime stays.
 */
import type { CanvasItem } from '../types'
import { settleConnectors } from './connectors'
import { patchScene, type Scene } from './scene'

export interface Change {
  id: string
  before: CanvasItem | null
  after: CanvasItem | null
}
export type Step = Change[]

/** What differs between two scenes, item by item (by reference: untouched items are shared). */
export function diffScenes(before: Scene, after: Scene): Step {
  const step: Step = []
  if (before.items === after.items) return step
  for (const id in after.items) {
    const a = after.items[id]
    const b = before.items[id]
    if (a !== b) step.push({ id, before: b ?? null, after: a })
  }
  for (const id in before.items) {
    if (!(id in after.items)) step.push({ id, before: before.items[id], after: null })
  }
  return step
}

function apply(scene: Scene, step: Step, direction: 'undo' | 'redo'): Scene {
  const put: CanvasItem[] = []
  const remove: string[] = []
  for (const ch of step) {
    const to = direction === 'undo' ? ch.before : ch.after
    if (to) put.push(to)
    else remove.push(ch.id)
  }
  return settleConnectors(patchScene(scene, put, remove), new Set(step.map((c) => c.id)))
}

export interface History {
  past: Step[]
  future: Step[]
}
export const EMPTY_HISTORY: History = { past: [], future: [] }
const DEPTH = 300

export function record(history: History, step: Step): History {
  if (!step.length) return history
  const past = history.past.length >= DEPTH ? history.past.slice(1) : history.past
  return { past: [...past, step], future: [] }
}

export function undo(history: History, scene: Scene): { history: History; scene: Scene; step: Step | null } {
  const step = history.past[history.past.length - 1]
  if (!step) return { history, scene, step: null }
  return { history: { past: history.past.slice(0, -1), future: [...history.future, step] }, scene: apply(scene, step, 'undo'), step }
}

export function redo(history: History, scene: Scene): { history: History; scene: Scene; step: Step | null } {
  const step = history.future[history.future.length - 1]
  if (!step) return { history, scene, step: null }
  return { history: { past: [...history.past, step], future: history.future.slice(0, -1) }, scene: apply(scene, step, 'redo'), step }
}
