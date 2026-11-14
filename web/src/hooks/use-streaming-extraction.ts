'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

/**
 * Consumes the Server-Sent Events stream from POST /api/ai/live-agent
 * (with `stream: true`) and exposes a live, Granola-style view of the model
 * working: prose typing in, plus the current tool activity.
 *
 * Contract with the server (route.ts streaming branch):
 *   data: {"type":"text","text":"..."}   incremental assistant prose
 *   data: {"type":"tool","tool":"..."}    a tool call started (activity hint)
 *   data: {"type":"done","payload":{...}} generation + all tool exec settled;
 *                                         payload === the non-stream JSON shape
 *   data: {"type":"error","error":"..."}  failure
 *
 * IMPORTANT: the streamed `text` is a PREVIEW only. The canonical summary and
 * proposals land via the tools' DB writes → Supabase Realtime, which the panel
 * already subscribes to. On `done` the caller reconciles to that canonical
 * state and discards the preview. We never persist the preview text.
 */

export type ExtractionDonePayload = {
  ok: boolean
  text: string
  tool_calls: number
  auto_applied: number
  [key: string]: unknown
}

type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: string }
  | { type: 'done'; payload: ExtractionDonePayload }
  | { type: 'error'; error: string }

// Human-readable activity labels for the tool hints. Anything not listed falls
// back to a generic "Working…" so a new tool never shows a raw snake_case name.
const TOOL_LABELS: Record<string, string> = {
  write_summary: 'Writing the summary',
  update_summary: 'Refining the summary',
  propose_change: 'Capturing an action item',
  record_commitment: 'Noting a commitment',
  propose_mcp_call: 'Preparing an integration',
  create_decision: 'Recording a decision',
}

export function toolLabel(tool: string | null): string {
  if (!tool) return 'Thinking'
  return TOOL_LABELS[tool] ?? 'Working'
}

export type StartExtractionArgs = {
  captureId: string
  mode: 'batch' | 'live'
  recipeId?: string
  recentChunks?: string[]
}

export type UseStreamingExtractionOptions = {
  /** Fired when the stream emits `done`, with the canonical JSON payload. */
  onDone?: (payload: ExtractionDonePayload) => void
  /** Fired on a stream-level error (network, or server `error` event). */
  onError?: (message: string) => void
}

export function useStreamingExtraction(opts: UseStreamingExtractionOptions = {}) {
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [activeTool, setActiveTool] = useState<string | null>(null)

  // Keep callbacks in refs so `start` stays identity-stable.
  const onDoneRef = useRef(opts.onDone)
  const onErrorRef = useRef(opts.onError)
  onDoneRef.current = opts.onDone
  onErrorRef.current = opts.onError

  // Lets us abort an in-flight stream (e.g. on unmount or a new start).
  const abortRef = useRef<AbortController | null>(null)
  // Guards against a late chunk writing state after we've torn down.
  const activeRef = useRef(false)

  // The streamed text, complete as of the last token. `streamingText` (state)
  // catches up with it at most once per animation frame — a state update per
  // token re-rendered the whole consumer panel for every one — and
  // synchronously on done / error / stop. A consumer reading the text per
  // frame (the typewriter) reads this ref and is never behind the stream.
  const streamingTextRef = useRef('')
  const flushRafRef = useRef<number | null>(null)

  const cancelTextFlush = useCallback(() => {
    if (flushRafRef.current != null) {
      cancelAnimationFrame(flushRafRef.current)
      flushRafRef.current = null
    }
  }, [])

  // Bring `streamingText` level with the ref now.
  const flushText = useCallback(() => {
    cancelTextFlush()
    setStreamingText(streamingTextRef.current)
  }, [cancelTextFlush])

  // Bring `streamingText` level with the ref on the next frame.
  const scheduleTextFlush = useCallback(() => {
    if (flushRafRef.current != null) return
    flushRafRef.current = requestAnimationFrame(() => {
      flushRafRef.current = null
      setStreamingText(streamingTextRef.current)
    })
  }, [])

  const stop = useCallback(() => {
    activeRef.current = false
    abortRef.current?.abort()
    abortRef.current = null
    flushText()
    setIsStreaming(false)
    setActiveTool(null)
  }, [flushText])

  const start = useCallback(async (args: StartExtractionArgs) => {
    // A new run supersedes any prior one.
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    activeRef.current = true

    cancelTextFlush()
    streamingTextRef.current = ''
    setStreamingText('')
    setActiveTool(null)
    setIsStreaming(true)

    try {
      let authHeaders: Record<string, string> = {}
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.access_token) {
          authHeaders['Authorization'] = `Bearer ${session.access_token}`
        }
      } catch { /* cookies fallback */ }

      const res = await fetch('/api/ai/live-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        signal: controller.signal,
        body: JSON.stringify({
          capture_id: args.captureId,
          mode: args.mode,
          stream: true,
          recipe_id: args.recipeId || undefined,
          recent_chunks: args.recentChunks || undefined,
        }),
      })

      if (!res.ok || !res.body) {
        // 403 (not owner), 5xx, etc. — surface and bail. The capture is
        // unchanged; the caller can fall back / toast.
        let message = 'Extraction failed. Please try again.'
        if (res.status === 403) message = 'Only the capture owner can process this meeting.'
        // A call still taking notes (the server writes them live): the route says so, plainly.
        if (res.status === 409) {
          const body = (await res.json().catch(() => null)) as { code?: string; error?: string } | null
          if (body?.code === 'CALL_NOTES_LIVE' && body.error) message = body.error
        }
        throw new Error(message)
      }

      // The server sometimes responds with plain JSON instead of an SSE stream:
      // the empty-transcript skip (`{ skipped: 'empty_transcript' }`) returns
      // before the streaming branch. Detect that by content-type and treat it as
      // an immediate completion so the UI doesn't sit parsing a non-stream body.
      const contentType = res.headers.get('content-type') || ''
      if (!contentType.includes('text/event-stream')) {
        const data = await res.json().catch(() => null) as ExtractionDonePayload | null
        activeRef.current = false
        setIsStreaming(false)
        setActiveTool(null)
        onDoneRef.current?.(data ?? { ok: true, text: '', tool_calls: 0, auto_applied: 0 })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      // SSE frames are delimited by a blank line; chunks may split a frame, so
      // we buffer and only consume complete `\n\n`-terminated frames.
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!activeRef.current) break

        buffer += decoder.decode(value, { stream: true })

        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)

          // A frame is one or more `data: ...` lines (we only emit one).
          const line = frame.split('\n').find((l) => l.startsWith('data:'))
          if (!line) continue
          const json = line.slice(line.indexOf(':') + 1).trim()
          if (!json) continue

          let event: StreamEvent
          try {
            event = JSON.parse(json) as StreamEvent
          } catch {
            continue // skip a malformed frame rather than killing the stream
          }

          if (event.type === 'text') {
            streamingTextRef.current += event.text
            scheduleTextFlush()
          } else if (event.type === 'tool') {
            setActiveTool(event.tool)
          } else if (event.type === 'done') {
            activeRef.current = false
            flushText()
            setIsStreaming(false)
            setActiveTool(null)
            onDoneRef.current?.(event.payload)
            return
          } else if (event.type === 'error') {
            throw new Error(event.error || 'Extraction failed.')
          }
        }
      }

      // Stream closed without an explicit `done` (e.g. connection cut after
      // text). Treat as completion so the UI doesn't hang; the canonical state
      // is in the DB and Realtime/refetch will reconcile it.
      if (activeRef.current) {
        activeRef.current = false
        flushText()
        setIsStreaming(false)
        setActiveTool(null)
        onDoneRef.current?.({ ok: true, text: streamingTextRef.current, tool_calls: 0, auto_applied: 0 })
      }
    } catch (err) {
      if (controller.signal.aborted) return // intentional supersede/unmount
      activeRef.current = false
      flushText()
      setIsStreaming(false)
      setActiveTool(null)
      const message = err instanceof Error ? err.message : 'Extraction failed.'
      onErrorRef.current?.(message)
    }
  }, [cancelTextFlush, flushText, scheduleTextFlush])

  // Abort any in-flight stream (and drop a scheduled text flush) on unmount.
  useEffect(() => stop, [stop])

  return {
    streamingText,
    // Read-only for consumers: the live text, never behind `streamingText`.
    streamingTextRef: streamingTextRef as { readonly current: string },
    isStreaming,
    activeTool,
    start,
    stop,
  }
}
