'use client'

/**
 * Keeps the live agent's HUD (the detached `agent-hud` window, /hud/agent) up
 * for the WHOLE of a live capture on desktop, and relays the agent's
 * say_to_user nudges to it.
 *
 * Up for the whole call (Liam, 2026-10-10), not only while Native Intelligence is in the
 * background as it used to be: Voice ID lives in the HUD during a live capture
 * (components/capture/voice-id-hud-publisher.tsx), and the transcript and tool
 * calls are to follow, so the HUD has to be reachable while you're in Native Intelligence
 * too. It opens when the capture starts and closes (window destroyed, Rust
 * buffer cleared) when it ends — the effect cleanup.
 *
 * The main chat stays the AUTHORITATIVE surface for say_to_user: every heads-up
 * is written into the capture's chat conversation and delivered over Realtime
 * to the open panel (see conversation-writer / say_to_user tool). The HUD
 * mirrors them.
 *
 * DELIVERY — never drop. Every nudge is pushed to Rust, which buffers until the
 * HUD page has subscribed (`agent_hud_ready`), so one that lands before the
 * window is up still shows. The HUD dedupes by nudge id.
 *
 * KEPT UP. The HUD can go missing mid-call (the Owen call, 2026-10-19: it came
 * up after each restart, then vanished within minutes with nothing logged, and
 * only another restart brought it back). So the hook re-checks it — the
 * desktop's ensure_agent_hud rebuilds or restores it and leaves one that's up
 * alone — just before each nudge is pushed, whenever the user comes back to
 * the main window, and every HUD_HEARTBEAT_MS. A desktop build without the
 * command keeps the one show at the start.
 *
 * The Realtime subscription stays up for the WHOLE capture. It also
 * RESUBSCRIBES on CHANNEL_ERROR/TIMED_OUT/CLOSED with a capped backoff, so a
 * single mid-meeting channel failure doesn't silently kill HUD delivery for the
 * rest of the call.
 *
 * Desktop-only; a no-op in a plain browser.
 */

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { isDesktopApp } from '@/lib/platform'
import { trackHudEvent } from '@/lib/hud-telemetry'
import {
  nudgeChannelName,
  NUDGE_EVENT,
  type AgentNudge,
} from '@/lib/live-agent/nudge-channel'

/** How often a live call re-checks its HUD is up (see KEPT UP above). */
export const HUD_HEARTBEAT_MS = 30_000

/** What made the relay re-check the HUD (telemetry's `reason`). */
export type HudEnsureReason = 'nudge' | 'main-focus' | 'heartbeat'

/** A desktop build older than ensure_agent_hud refuses it like this. */
const MISSING_COMMAND = /not found|not allowed/i

export function useAgentNudgeRelay(captureId: string | null, liveModeEnabled: boolean) {
  useEffect(() => {
    // Only relay during a live-agent meeting, on desktop (the HUD is a Tauri
    // window). Off-desktop or between meetings: nothing to do.
    if (!captureId || !liveModeEnabled || !isDesktopApp()) return

    let cancelled = false
    let cleanupChannel: (() => void) | undefined

    // Serialize the HUD calls (open, then each push) so their async imports
    // can't land out of order.
    let opChain: Promise<unknown> = Promise.resolve()
    const enqueue = (op: () => Promise<unknown>) => {
      opChain = opChain.then(op, op)
      return opChain
    }

    let bridge: typeof import('@/lib/tauri-bridge').tauriBridge | null = null
    const getBridge = async () => {
      if (!bridge) bridge = (await import('@/lib/tauri-bridge')).tauriBridge
      return bridge
    }

    // Up for the whole call: open it now. Telemetry (lib/hud-telemetry.ts)
    // records the ask, so a HUD that never came up after a restart shows as a
    // missing open. `ipc_ok` is only that the desktop took the call (its
    // show_agent_hud returns nothing, even when the window fails to build):
    // the HUD's own live_hud_loaded / live_hud_shown say it came up.
    void enqueue(async () => {
      if (cancelled) return
      const b = await getBridge()
      await b.showAgentHud().then(
        () => trackHudEvent('live_hud_open_requested', { capture_id: captureId, ipc_ok: true }),
        (e: unknown) =>
          trackHudEvent('live_hud_open_requested', { capture_id: captureId, ipc_ok: false, error: String(e) }),
      )
    })

    // Put the HUD back if it went missing (KEPT UP above). In the queue, so a
    // nudge's check lands before its push. Logged only when the desktop had
    // to act (or failed): a HUD that's up says nothing, every 30s. A desktop
    // without the command is asked once: no more heartbeats, and no failed
    // round trip ahead of every nudge.
    let ensureSupported = true
    const ensureHud = (reason: HudEnsureReason) =>
      enqueue(async () => {
        if (cancelled || !ensureSupported) return
        const b = await getBridge()
        let result: string
        try {
          result = await b.ensureAgentHud(reason, captureId)
        } catch (e) {
          const error = String(e)
          if (MISSING_COMMAND.test(error)) {
            ensureSupported = false
            clearInterval(heartbeat)
          } else {
            trackHudEvent('live_hud_ensured', { capture_id: captureId, reason, result: 'error', error })
          }
          return
        }
        if (result !== 'visible') {
          trackHudEvent('live_hud_ensured', { capture_id: captureId, reason, result })
        }
      })
    const heartbeat = setInterval(() => void ensureHud('heartbeat'), HUD_HEARTBEAT_MS)
    // Back to Native Intelligence is where the user looks for a HUD that went missing.
    let unlistenFocus: (() => void) | undefined
    void enqueue(async () => {
      if (cancelled) return
      const b = await getBridge()
      const off = await b.onMainFocusChanged((focused) => {
        if (focused) void ensureHud('main-focus')
      })
      if (cancelled) off()
      else unlistenFocus = off
    })

    void (async () => {
      const supabase = createClient()
      // Authorize this client for PRIVATE Realtime channels: setAuth attaches the
      // user's JWT so the realtime.messages RLS policy can gate the subscription
      // to members of this capture's workspace. Without a private channel the
      // topic name (a capture UUID) would be the only secret, letting any client
      // with the anon key eavesdrop on — or spoof nudges into — another meeting.
      await supabase.realtime.setAuth().catch(() => {})
      if (cancelled) return

      // RESUBSCRIBE ON FAILURE. A private channel can be RLS-rejected, time out,
      // or drop (CLOSED) mid-meeting — e.g. the WebView's websocket dies silently
      // after a macOS sleep. The old handler only LOGGED that, so a single
      // failure permanently killed HUD delivery for the rest of the call while
      // the chat surface kept working (masking it). We now tear the failed
      // channel down and recreate it with a capped exponential backoff.
      //
      // The active channel is tracked so a retry can remove the OLD one before
      // creating a NEW one (never two concurrent subscriptions on the same
      // topic), and so cleanup removes whatever is current. `retryTimer` and the
      // `cancelled` guard ensure NO resubscribe survives effect teardown — the
      // cleanup below clears the pending timer and the guards short-circuit any
      // in-flight retry. Channel construction is factored into `subscribeOnce` so
      // the initial subscribe and every retry share identical config + handlers
      // (and reuse the one authorized `supabase` client from the setAuth above).
      let activeChannel: ReturnType<typeof supabase.channel> | null = null
      let retryTimer: ReturnType<typeof setTimeout> | null = null
      // 1s → 2s → 4s … capped at 30s; reset to 1s on a clean SUBSCRIBED.
      let backoffMs = 1000
      const BACKOFF_CAP_MS = 30_000

      const scheduleResubscribe = () => {
        if (cancelled || retryTimer !== null) return
        const delay = backoffMs
        backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS)
        retryTimer = setTimeout(() => {
          retryTimer = null
          if (cancelled) return
          // Drop the dead channel BEFORE creating its replacement so we never
          // hold two subscriptions to the same topic.
          const dead = activeChannel
          activeChannel = null
          if (dead) void supabase.removeChannel(dead).catch(() => {})
          // RE-AUTH before every resubscribe, not just at mount. A drop after an
          // overnight sleep almost always coincides with an EXPIRED access token;
          // the mount-time setAuth() (line ~191) cached that now-stale JWT, so a
          // bare resubscribe would be RLS-rejected in an endless CHANNEL_ERROR
          // loop on this PRIVATE channel. setAuth() (no-arg) re-resolves a fresh
          // token via the client's access-token callback — force-refreshing it
          // if expired — then joins with a valid JWT. Await it so the join push
          // carries the fresh token; a failed refresh still falls through to a
          // subscribe attempt (its own CHANNEL_ERROR reschedules).
          void supabase.realtime
            .setAuth()
            .catch(() => {})
            .finally(() => {
              if (cancelled) return
              subscribeOnce()
            })
        }, delay)
      }

      const subscribeOnce = () => {
        if (cancelled) return
        const channel = supabase
          .channel(nudgeChannelName(captureId), {
            config: { private: true, broadcast: { self: false } },
          })
          .on('broadcast', { event: NUDGE_EVENT }, (msg) => {
            // Stale-channel guard (see the matching guard in the status
            // callback): a replaced channel should not deliver either.
            if (channel !== activeChannel) return
            const nudge = msg.payload as AgentNudge
            if (!nudge?.message) return
            // The HUD has to be up to show it: bring it back first if it went
            // missing. Rust buffers until the HUD page is ready, so nothing is
            // dropped.
            void ensureHud('nudge')
            enqueue(async () => {
              const b = await getBridge()
              const ipcOk = await b
                .pushAgentNudge({
                  id: nudge.id,
                  message: nudge.message,
                  kind: nudge.kind,
                  captureId: nudge.captureId,
                  ts: nudge.ts,
                })
                .then(
                  () => true,
                  () => false,
                )
              // The first hop of "did it show?": the HUD's own events
              // (arrived, displayed) carry the same nudge_id. `ipc_ok` is only
              // that Rust took the push (it buffers, without saying, for a HUD
              // not ready); arrived is the delivery. `latency_ms` is this
              // machine's clock less the server's stamp, skew and all (left
              // unclamped, so a negative shows the skew).
              trackHudEvent('live_hud_nudge_received', {
                capture_id: captureId,
                nudge_id: nudge.id ?? null,
                nudge_kind: nudge.kind ?? null,
                ipc_ok: ipcOk,
                latency_ms: typeof nudge.ts === 'number' ? Date.now() - nudge.ts : null,
              })
            })
          })
        // Mark active BEFORE subscribing so the stale-channel guards hold even
        // if a status callback fires synchronously (test harnesses do; the real
        // client replies async — this makes the ordering safe either way).
        activeChannel = channel
        channel.subscribe((status) => {
            // STALE-CHANNEL GUARD. realtime-js fires the subscribe callback
            // with CLOSED on ANY close — including our own removeChannel
            // (RealtimeChannel.subscribe wires `_onClose(() => callback('CLOSED'))`
            // and unsubscribe triggers that close event). Both teardown AND the
            // retry path itself remove a channel, and the retry's removal would
            // otherwise re-enter scheduleResubscribe: dead channel's CLOSED →
            // schedule → later tear down the HEALTHY replacement → its CLOSED →
            // schedule … perpetual churn, dropping broadcasts in every rejoin
            // window. Every removal first detaches the channel from
            // `activeChannel`, so "no longer the active channel" precisely
            // identifies a close WE caused — ignore everything it reports.
            if (channel !== activeChannel) return
            if (status === 'SUBSCRIBED') {
              // Clean subscribe — reset the backoff so a LATER failure starts
              // its own 1s→2s→… schedule rather than inheriting a stale cap.
              backoffMs = 1000
              return
            }
            // CLOSED is included because a mid-meeting socket drop reports as
            // CLOSED, not only CHANNEL_ERROR/TIMED_OUT. A CLOSED from our own
            // removals never reaches here (stale guard above).
            if (
              status === 'CHANNEL_ERROR' ||
              status === 'TIMED_OUT' ||
              status === 'CLOSED'
            ) {
              console.warn(
                `agent-nudge relay: channel ${status} for capture ${captureId}` +
                  (cancelled ? ' (torn down)' : ` — resubscribing in ${backoffMs}ms`),
              )
              scheduleResubscribe()
            }
          })

        // Teardown race: the effect cleanup may have run while we were awaiting
        // setAuth. If so, cleanupChannel wasn't assigned and cleanup already
        // fired — remove this just-created channel now so its websocket
        // subscription doesn't leak for the page's lifetime.
        if (cancelled) {
          activeChannel = null
          void supabase.removeChannel(channel).catch(() => {})
        }
      }

      subscribeOnce()

      if (cancelled) return
      cleanupChannel = () => {
        // Stop any pending retry, then remove whatever channel is current.
        if (retryTimer !== null) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
        const ch = activeChannel
        activeChannel = null
        if (ch) void supabase.removeChannel(ch).catch(() => {})
      }
    })()

    return () => {
      cancelled = true
      clearInterval(heartbeat)
      unlistenFocus?.()
      cleanupChannel?.()
      trackHudEvent('live_hud_close_requested', { capture_id: captureId })
      // Meeting end: fully close the HUD (destroy window + clear the Rust
      // buffer). Lazy import so a non-desktop build never pulls the bridge.
      void import('@/lib/tauri-bridge')
        .then(({ tauriBridge }) => tauriBridge.hideAgentHud().catch(() => {}))
        .catch(() => {})
    }
  }, [captureId, liveModeEnabled])
}
