import { vi } from 'vitest'
import type { CdpParams, CdpTransport } from '../connection'

/** A CDP connection whose answers a test scripts: `answer(method, params, sessionId)`; an Error answer rejects. */
export function fakeCdp(answer: (method: string, params: CdpParams, sessionId?: string) => unknown = () => ({})) {
  const calls: { method: string; params: CdpParams; sessionId?: string }[] = []
  const listeners = new Map<string, Set<(params: CdpParams, sessionId: string | undefined) => void>>()
  const fake = {
    calls,
    send: vi.fn(async (method: string, params: CdpParams = {}, sessionId?: string) => {
      calls.push({ method, params, sessionId })
      const result = await answer(method, params, sessionId)
      if (result instanceof Error) throw result
      return result ?? {}
    }),
    on: (method: string, listener: (params: CdpParams, sessionId: string | undefined) => void) => {
      let set = listeners.get(method)
      if (!set) listeners.set(method, (set = new Set()))
      set.add(listener)
      return () => { set.delete(listener) }
    },
    close: vi.fn(),
    emit(method: string, params: CdpParams, sessionId?: string) {
      for (const listener of listeners.get(method) ?? []) listener(params, sessionId)
    },
    methods: (sessionId?: string) => calls.filter(call => sessionId === undefined || call.sessionId === sessionId).map(call => call.method),
  }
  return fake as typeof fake & CdpTransport
}

export const flush = () => new Promise(resolve => setTimeout(resolve, 0))
