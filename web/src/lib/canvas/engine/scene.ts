/**
 * The scene: an immutable map of items, and the questions asked of it (what
 * is in front, what is in a group, where things are). Every edit makes a new
 * map and shares the items it did not touch, so "did this item change" is a
 * reference check.
 */
import type { CanvasItem, ConnectorItem, GroupItem } from '../types'
import { aabb, unionBoxes, type Box } from './geometry'
import { keyAfter, keysAfter, keysBetween } from './sort-key'

export type Items = Readonly<Record<string, CanvasItem>>
export interface Scene {
  readonly items: Items
}

export const EMPTY_SCENE: Scene = { items: {} }

export function sceneFromItems(list: readonly CanvasItem[]): Scene {
  const items: Record<string, CanvasItem> = {}
  for (const it of list) items[it.id] = it
  return { items }
}

const orderCache = new WeakMap<Items, CanvasItem[]>()

/** Every item, back to front. Ties on the key fall back to the id, so the order is total. */
export function ordered(scene: Scene): readonly CanvasItem[] {
  let list = orderCache.get(scene.items)
  if (!list) {
    list = Object.values(scene.items).sort((a, b) =>
      a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
    orderCache.set(scene.items, list)
  }
  return list
}

/** What is painted (everything but groups), back to front. */
export function painted(scene: Scene): readonly CanvasItem[] {
  return ordered(scene).filter((it) => it.kind !== 'group')
}

const childCache = new WeakMap<Items, Map<string, string[]>>()
function childMap(scene: Scene): Map<string, string[]> {
  let map = childCache.get(scene.items)
  if (!map) {
    map = new Map()
    for (const it of ordered(scene)) {
      if (it.parentId && scene.items[it.parentId]) {
        const list = map.get(it.parentId)
        if (list) list.push(it.id)
        else map.set(it.parentId, [it.id])
      }
    }
    childCache.set(scene.items, map)
  }
  return map
}

export const childrenOf = (scene: Scene, id: string): readonly string[] => childMap(scene).get(id) ?? []

/** Every item under these ids (not the ids themselves), groups included. */
export function descendants(scene: Scene, ids: Iterable<string>): string[] {
  const out: string[] = []
  const walk = (id: string) => {
    for (const child of childrenOf(scene, id)) {
      out.push(child)
      walk(child)
    }
  }
  for (const id of ids) walk(id)
  return out
}

/** The ids and everything under them, each once. */
export function withDescendants(scene: Scene, ids: Iterable<string>): string[] {
  const seen = new Set<string>()
  for (const id of ids) if (scene.items[id]) seen.add(id)
  for (const id of descendants(scene, [...seen])) seen.add(id)
  return [...seen]
}

/** The leaves (non-groups) under these ids, the ids themselves included when they are leaves. */
export function leavesOf(scene: Scene, ids: Iterable<string>): CanvasItem[] {
  return withDescendants(scene, ids)
    .map((id) => scene.items[id])
    .filter((it) => it && it.kind !== 'group')
}

/** The outermost group an item sits in, or the item itself. A parent that is gone counts as none. */
export function rootOf(scene: Scene, id: string): string {
  let cur = id
  for (let i = 0; i < 64; i++) {
    const parent = scene.items[cur]?.parentId
    if (!parent || !scene.items[parent]) return cur
    cur = parent
  }
  return cur
}

/** The ancestor of `id` that is a direct child of `within` (null: the canvas). */
export function childWithin(scene: Scene, id: string, within: string | null): string {
  let cur = id
  for (let i = 0; i < 64; i++) {
    const parent = scene.items[cur]?.parentId
    const real = parent && scene.items[parent] ? parent : null
    if (real === within || !real) return cur
    cur = real
  }
  return cur
}

/** Drop ids whose ancestor is also in the list: what a selection really names. */
export function selectionRoots(scene: Scene, ids: readonly string[]): string[] {
  const set = new Set(ids.filter((id) => scene.items[id]))
  return [...set].filter((id) => {
    let parent = scene.items[id]?.parentId
    for (let i = 0; parent && i < 64; i++) {
      if (set.has(parent)) return false
      parent = scene.items[parent]?.parentId
    }
    return true
  })
}

/** The upright box an item takes up. A group's is its leaves'. */
export function itemBounds(scene: Scene, id: string): Box | null {
  const it = scene.items[id]
  if (!it) return null
  if (it.kind !== 'group') return aabb(it)
  return unionBoxes(leavesOf(scene, [id]).map((leaf) => aabb(leaf)))
}

export function boundsOf(scene: Scene, ids: Iterable<string>): Box | null {
  const boxes: Box[] = []
  for (const leaf of leavesOf(scene, ids)) boxes.push(aabb(leaf))
  return unionBoxes(boxes)
}

export const sceneBounds = (scene: Scene): Box | null => unionBoxes(painted(scene).map((it) => aabb(it)))

/** A key in front of everything. */
export function frontKey(scene: Scene): string {
  const list = ordered(scene)
  return keyAfter(list.length ? list[list.length - 1].sortKey : null)
}
export function frontKeys(scene: Scene, n: number): string[] {
  const list = ordered(scene)
  return keysAfter(list.length ? list[list.length - 1].sortKey : null, n)
}
export function backKeys(scene: Scene, n: number): string[] {
  const list = ordered(scene)
  return keysBetween(null, list.length ? list[0].sortKey : null, n)
}

export function isConnector(it: CanvasItem | undefined): it is ConnectorItem {
  return it?.kind === 'connector'
}
export function isGroup(it: CanvasItem | undefined): it is GroupItem {
  return it?.kind === 'group'
}

/** Put items in (replacing same ids) and take ids out. Untouched items are shared. */
export function patchScene(scene: Scene, put: readonly CanvasItem[], remove: readonly string[] = []): Scene {
  if (!put.length && !remove.length) return scene
  const items: Record<string, CanvasItem> = { ...scene.items }
  for (const id of remove) delete items[id]
  for (const it of put) items[it.id] = it
  return { items }
}

let counter = 0
/** A new item id: short, unique across people (random), URL-safe. */
export function newId(): string {
  const bytes = new Uint8Array(9)
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  let s = ''
  const A = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  for (const b of bytes) s += A[b % A.length]
  counter = (counter + 1) % 1296
  return `i${s}${counter.toString(36)}`
}
