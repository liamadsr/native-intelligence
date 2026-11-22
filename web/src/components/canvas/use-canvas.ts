'use client'

import * as React from 'react'
import type { Camera } from '@/lib/canvas/engine/camera'
import type { CanvasState, CanvasStore } from './store'

export const CanvasContext = React.createContext<CanvasStore | null>(null)

export function useCanvasStore(): CanvasStore {
  const store = React.useContext(CanvasContext)
  if (!store) throw new Error('No canvas here')
  return store
}

/** Read a slice of the canvas state; re-render when that slice is a different value. */
export function useCanvas<T>(selector: (state: CanvasState) => T): T {
  const store = useCanvasStore()
  const get = React.useCallback(() => selector(store.getState()), [store, selector])
  return React.useSyncExternalStore(store.subscribe, get, get)
}

/** The camera, re-rendering on every pan and zoom. Only small things should use this. */
export function useCamera(): Camera {
  const store = useCanvasStore()
  const get = React.useCallback(() => store.camera, [store])
  return React.useSyncExternalStore(store.subscribeCamera, get, get)
}

/** The zoom alone, as a whole percent: re-renders only when the number shown changes. */
export function useZoomPercent(): number {
  const store = useCanvasStore()
  const get = React.useCallback(() => Math.round(store.camera.scale * 100), [store])
  return React.useSyncExternalStore(store.subscribeCamera, get, get)
}
