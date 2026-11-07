'use client'

/**
 * Live state for one desktop local module (e.g. `local-stt`, on-device
 * transcription) plus the three actions a settings row needs. The desktop owns
 * the truth — download, verify, warm-up, the device-local enabled flag — and
 * reports it through `modules_list` and `module://status`; this hook mirrors it.
 *
 * Capability probe: `supported` is true only inside the desktop app AND when
 * `modules_list` includes this module. A browser, or a desktop build that
 * predates Local Modules (no `modules_list` → []), reads as unsupported and the
 * caller renders nothing.
 *
 * Every command answers with the module's fresh info, and `module://status`
 * streams progress in between (Downloading x% → Verifying → Warming up →
 * Ready). A command that rejects keeps the last known info and surfaces the
 * message as `actionError` (the row offers retry).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { isDesktopApp } from '@/lib/platform'
import { listLocalModules } from '@/lib/local-modules'
import { tauriBridge, type LocalModuleInfo, type LocalModuleState } from '@/lib/tauri-bridge'
import { listenScoped } from '@/lib/tauri-unlisten'

export interface LocalModuleHandle {
  /** Probe finished (false while the first modules_list is in flight). */
  loaded: boolean
  /** Desktop app AND the desktop reports this module. */
  supported: boolean
  info: LocalModuleInfo | null
  state: LocalModuleState | null
  /** 0..1 while downloading, else null. */
  progress: number | null
  enabled: boolean
  /** A command is in flight. */
  busy: boolean
  /** The module's own error, or the last failed command's message. */
  error: string | null
  enable: () => Promise<void>
  disable: () => Promise<void>
  removeAssets: () => Promise<void>
}

export function useLocalModule(id: string): LocalModuleHandle {
  const [loaded, setLoaded] = useState(false)
  const [info, setInfo] = useState<LocalModuleInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    if (!isDesktopApp()) {
      setLoaded(true)
      return () => { mountedRef.current = false }
    }

    let cancelled = false
    // A status event is newer than any list answer still in flight.
    let sawEvent = false

    void listLocalModules().then((list) => {
      if (cancelled) return
      if (!sawEvent) setInfo(list.find((m) => m.id === id) ?? null)
      setLoaded(true)
    })

    // Live progress. A build without the event simply never fires it; a build
    // whose listen() rejects is treated the same (the list above still rules).
    const stopStatus = listenScoped((gate) => tauriBridge.onModuleStatus(gate((next) => {
      if (next?.id !== id) return
      sawEvent = true
      setInfo(next)
    })))

    return () => {
      cancelled = true
      mountedRef.current = false
      stopStatus()
    }
  }, [id])

  const run = useCallback(
    async (command: (moduleId: string) => Promise<LocalModuleInfo>) => {
      setBusy(true)
      setActionError(null)
      try {
        const next = await command(id)
        if (mountedRef.current && next && next.id === id) setInfo(next)
      } catch (err) {
        if (mountedRef.current) setActionError(err instanceof Error ? err.message : String(err))
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    },
    [id],
  )

  const enable = useCallback(() => run((m) => tauriBridge.moduleEnable(m)), [run])
  const disable = useCallback(() => run((m) => tauriBridge.moduleDisable(m)), [run])
  const removeAssets = useCallback(() => run((m) => tauriBridge.moduleRemoveAssets(m)), [run])

  return {
    loaded,
    supported: info !== null,
    info,
    state: info?.state ?? null,
    progress: info?.progress ?? null,
    enabled: info?.enabled ?? false,
    busy,
    error: actionError ?? info?.error ?? null,
    enable,
    disable,
    removeAssets,
  }
}
