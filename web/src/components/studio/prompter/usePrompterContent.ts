'use client'
// The script and checklist for the next take, kept on the Studio (lib/studio/server/prompter.ts): for a take recorded
// into an open video, that video's (every retake reuses it); otherwise the person's own. Loaded once, saved a moment
// after each change.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrompterContent } from '@/lib/studio/prompter/content'
import { STUDIO_API } from '../studio-env'
import { put, request } from '../ui/client'

export const SAVE_AFTER_MS = 800
const EMPTY: PrompterContent = { script: '', items: [] }

export type PrompterStore = {
  content: PrompterContent
  loaded: boolean
  /** Not saved: a sentence to show, or null. */
  error: string | null
  change: (next: PrompterContent) => void
}

let ids = 0
/** An id for a new checklist item. */
export const newItemId = () => `i${Date.now().toString(36)}${(ids++).toString(36)}`

export function usePrompterContent(videoId: string | null | undefined): PrompterStore {
  const key = videoId || 'mine'
  const [content, setContent] = useState<PrompterContent>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<PrompterContent | null>(null)

  useEffect(() => {
    let alive = true
    setLoaded(false)
    request<{ prompter: PrompterContent | null }>(`${STUDIO_API}/prompter/${encodeURIComponent(key)}`)
      .then((answer) => { if (alive) setContent(answer.prompter ?? EMPTY) })
      .catch(() => { if (alive) setContent(EMPTY) })
      .finally(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [key])

  const flush = useCallback(async () => {
    const next = pending.current
    pending.current = null
    if (!next) return
    try { await put(`${STUDIO_API}/prompter/${encodeURIComponent(key)}`, next); setError(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Not saved.') }
  }, [key])

  // Saved when the dialog closes too.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); void flush() }, [flush])

  const change = useCallback((next: PrompterContent) => {
    setContent(next)
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = null; void flush() }, SAVE_AFTER_MS)
  }, [flush])

  return { content, loaded, error, change }
}
