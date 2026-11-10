'use client'                                                                                                                                                                              

import { useCallback, useEffect, useRef } from 'react'
import { isDesktopApp } from '@/lib/platform'
import { getThisWebviewLabel, tauriBridge } from '@/lib/tauri-bridge'
import { listenScoped } from '@/lib/tauri-unlisten'
import { useRecordingStable } from '@/hooks/recording-context'
import { toast } from 'sonner'
import { registerReloadBlocker } from '@/lib/deploy-reload'

const VERSION_CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes                                                                                                                                 

/**                                                                                                                                                                                       
 * Unified desktop app updater.                                    
 *
 * Handles two types of updates as a single experience:
 * 1. Binary (Tauri) updates — new .app bundle, requires restart
 * 2. Web (Next.js) updates — new deployment, just needs a page reload                                                                                                                    
 *
 * On launch: checks both silently. Downloads binary update in background.                                                                                                                
 * Mid-session: polls for web updates every 5 minutes.             
 * Manual: tray "Check for Updates" checks both and shows result.                                                                                                                         
 *
 * Priority: binary update > web update (restart covers both).                                                                                                                            
 */                                                                
export function AppUpdater() {
  const checking = useRef(false)
  const knownBuildId = useRef<string | null>(null)
  // The binary version already downloaded and installed this session. The
  // updater compares against the RUNNING binary, which only changes on
  // relaunch, so until then every poll reports the same update available.
  const installedBinaryVersion = useRef<string | null>(null)
  /** A version this build's install refused: scheduled polls don't download it again. */
  const refusedBinaryVersion = useRef<string | null>(null)

  // A restart (binary) or reload (web) mid-recording cuts the recording off:
  // the relaunch stops the capture, and on 2026-09-28 tearing one down while
  // the new process started helped wedge macOS's audio daemon. Read at click
  // time, so it's a ref.
  const { isRecording, isStarting } = useRecordingStable()
  const recordingRef = useRef(false)
  useEffect(() => {
    recordingRef.current = isRecording || isStarting
  }, [isRecording, isStarting])
  // New deploy → reload when idle (lib/deploy-reload.ts, every surface, web
  // too): never mid-recording, for the same reason.
  useEffect(() => registerReloadBlocker(() => recordingRef.current), [])

  /** While recording: keep the update toast up, say why, and return true. */
  const holdForRecording = useCallback((event?: { preventDefault(): void }) => {
    if (!recordingRef.current) return false
    event?.preventDefault()
    toast.info('Finish your recording first', {
      id: 'app-update-held',
      description: 'Updating now would cut your recording off. Update after you stop it.',
      duration: 5000,
    })
    return true
  }, [])

  /** Fetch the current web app build ID from /api/version */
  const fetchBuildId = useCallback(async (): Promise<string | null> => {                                                                                                                  
    try {                                                          
      const res = await fetch('/api/version', { cache: 'no-store' })
      if (!res.ok) return null                                                                                                                                                            
      const { buildId } = await res.json()
      return buildId ?? null                                                                                                                                                              
    } catch {                                                      
      return null
    }
  }, [])

  /**
   * Check for updates. `binary` splits the two halves along how each is
   * actually remediated:
   *  • BINARY (tauri updater) is app-wide — one download, one restart prompt.
   *    Only the elected window may run it, or a pop-out duplicates the download.
   *  • WEB (build id vs /api/version) is PER-WEBVIEW: each window holds its own
   *    JS chunks and the only remedy is that window reloading ITSELF. Every
   *    window runs it, so a pop-out never sits on stale chunks against a new
   *    server.
   */                                                                                                                                        
  const checkForUpdates = useCallback(async (manual = false, binary = true) => {
    if (checking.current) return                                                                                                                                                          
    checking.current = true                                        

    try {
      // Check both in parallel
      // Note: Tauri's check() can reject with "no update available" — that's not an error
      const [binaryUpdate, currentBuildId] = await Promise.all([
        binary
          ? tauriBridge.checkForUpdate().catch((err) => {
            // Tauri updater throws when there's no update or endpoint returns 204
            // This is expected behavior, not an error
            console.debug('[updater] binary check:', err instanceof Error ? err.message : String(err))
            return null
          })
          : Promise.resolve(null),
        fetchBuildId(),
      ])                                                                                                                                                                                  

      // Track the build ID on first check and persist for cache-buster script
      if (knownBuildId.current === null && currentBuildId) {
        knownBuildId.current = currentBuildId                                                                                                                                             
        try { localStorage.setItem('ni_build_id', currentBuildId) } catch {}
      }                                                                                                                                                                                   

      const hasWebUpdate = knownBuildId.current !== null                                                                                                                                  
        && currentBuildId !== null
        && currentBuildId !== knownBuildId.current                                                                                                                                        

      // Binary update takes priority — restart covers both
      if (binaryUpdate) {
        if (refusedBinaryVersion.current === binaryUpdate.version && !manual) {
          // Refused before (a bundle that isn't what it says, say): a poll
          // doesn't download it again. A manual check still retries.
          return
        }
        if (installedBinaryVersion.current === binaryUpdate.version) {
          // Already installed, waiting on a restart: no second download. A
          // scheduled poll leaves the restart toast as it is.
          if (!manual) return
        } else {
          if (manual) {
            toast.loading('Downloading update...', { id: 'app-update' })
          }

          try {
            await binaryUpdate.install()
          } catch (dlErr) {
            const message = dlErr instanceof Error ? dlErr.message : String(dlErr)
            if (binaryUpdate.via === 'rust') {
              // This build's install refused or failed: nothing was installed
              // (a downgrade, a bundle whose own version isn't the manifest's, a
              // bad signature). No restart is waiting, so don't prompt one.
              console.warn('[updater] install failed:', message)
              refusedBinaryVersion.current = binaryUpdate.version
              if (manual) toast.error('Update failed', { id: 'app-update', description: message, duration: 6000 })
              return
            }
            // An older build's plugin: signature verification errors are
            // non-fatal there — the native updater still downloads and installs
            // despite the JS promise rejecting. Show the restart toast anyway.
            console.warn('[updater] downloadAndInstall threw (update may still succeed):', message)
          }
          installedBinaryVersion.current = binaryUpdate.version
        }

        toast.success(`Update ${binaryUpdate.version} ready`, {
          id: 'app-update',
          description: 'Restart to apply the update.',
          duration: Infinity,
          action: {
            label: 'Restart now',
            onClick: (event) => {
              if (holdForRecording(event)) return
              // Rust's install path applies through Rust (Windows runs the
              // staged installer here); an older build's plugin path restarts.
              const restart = binaryUpdate.via === 'rust' ? tauriBridge.applyUpdate() : tauriBridge.relaunch()
              Promise.resolve(restart).catch((err: unknown) => {
                // Nothing applied: the next check installs (or re-stages) it
                // again rather than taking it as waiting on a restart.
                installedBinaryVersion.current = null
                const message = err instanceof Error ? err.message : String(err)
                toast.error('Update failed', { id: 'app-update', description: message, duration: 6000 })
              })
            },
          },
        })
        return
      }

      // Web-only update — reload to get fresh assets                                                                                                                                     
      if (hasWebUpdate) {
        knownBuildId.current = currentBuildId                                                                                                                                             
        try { localStorage.setItem('ni_build_id', currentBuildId!) } catch {}
        if (manual && !recordingRef.current) {
          toast.loading('Applying update...', { id: 'app-update', duration: 2000 })
          setTimeout(() => window.location.reload(), 1000)
        } else {
          // Silent (or recording): show a gentle toast
          toast.success('App updated', {
            id: 'app-update',
            description: 'A new version is available.',
            duration: Infinity,
            action: {
              label: 'Refresh',
              onClick: (event) => {
                if (holdForRecording(event)) return
                window.location.reload()
              },
            },
          })
        }
        return                                                                                                                                                                            
      }

      // No updates                                                
      if (manual) {
        toast.success('You\'re up to date', {
          description: 'Native Intelligence is running the latest version.',
          duration: 3000,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)                                                                                                                    
      console.error('[updater] check failed:', message)
      if (manual) {                                                                                                                                                                       
        toast.error('Update check failed', {                       
          description: message,
          duration: 6000,
        })                                                                                                                                                                                
      }
    } finally {                                                                                                                                                                           
      checking.current = false                                     
    }
  }, [fetchBuildId, holdForRecording])

  useEffect(() => {
    if (!isDesktopApp()) return

    // Main-window election, scoped to the BINARY half only. AppUpdater mounts
    // once per dashboard window; with a workspace pop-out open, every window
    // running the tauri updater means duplicate downloads and duplicate restart
    // prompts, and the tray 'check-for-updates' broadcast (old shells can't
    // target it) would toast once per window. The main window is always the
    // elected one; close-to-tray hides it but never destroys it, so an intent
    // is never dropped. label === null (plain web, no shell) keeps the
    // single-context behavior.
    //
    // The WEB half is deliberately NOT elected: JS chunks are per-webview, so a
    // pop-out that never polls runs the old bundle against a new server for as
    // long as it stays open — and worse, main advancing the shared
    // `ni_build_id` key makes the pop-out's CacheBusterScript compute
    // needsReload === false, so even a manual reload skips the hard reload.
    // Each window polls for itself and reloads only itself.
    const elected = getThisWebviewLabel().then(
      (label) => label === null || label === 'main',
    )

    let launchTimer: ReturnType<typeof setTimeout> | undefined
    let pollInterval: ReturnType<typeof setInterval> | undefined
    let disposed = false

    // `binary` is resolved per invocation rather than captured, so the timers
    // can arm immediately (no async hop) while the expensive half still waits
    // on the election. The checking ref serializes both halves against each
    // other, so an elected window never runs two overlapping checks.
    const runScheduledCheck = () => {
      void elected.then((isElected) => {
        if (disposed) return
        checkForUpdates(false, isElected)
      })
    }

    // Auto-check on launch (silent, after a short delay)
    launchTimer = setTimeout(runScheduledCheck, 5000)
    // Poll for web updates every 5 minutes
    pollInterval = setInterval(runScheduledCheck, VERSION_CHECK_INTERVAL)

    // Tray "Check for Updates": register immediately (deferring registration
    // behind the label lookup could lose a click delivered at startup — Tauri
    // does not replay events); the handler awaits election instead. Manual
    // checks stay fully elected — the broadcast reaches every window, and one
    // click must produce exactly one visible result, not one per window.
    const stopTray = listenScoped((gate) => tauriBridge.onCheckForUpdates(gate(() => {
      void elected.then((isElected) => {
        if (isElected && !disposed) checkForUpdates(true)
      })
    })))

    return () => {
      disposed = true
      if (launchTimer) clearTimeout(launchTimer)
      if (pollInterval) clearInterval(pollInterval)
      stopTray()
    }
  }, [checkForUpdates])

  return null
}