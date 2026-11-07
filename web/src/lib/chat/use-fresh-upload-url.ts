'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { freshUploadUrl, isStaleUpload, signedUploadOf } from './fresh-upload-url'

/**
 * The link to show for a file in a chat message (./fresh-upload-url.ts).
 *
 * `url`: the message's own link, as is, for anything that is not a chat
 * upload's signed link, or one that is still good. An expired one is swapped
 * for a fresh one: null while it's fetched (show a placeholder, not a broken
 * image), then the fresh link, or the old one if none could be had.
 *
 * `refresh`: a fresh link for the one shown (a tab left open past the hour),
 * for a click to open; null when none could be had.
 */
export function useFreshUploadUrl(url: string): { url: string | null; refresh: () => Promise<string | null> } {
  const upload = useMemo(() => signedUploadOf(url), [url])
  // Read once per link: a link that goes stale while shown is refreshed on click.
  const stale = useMemo(() => (upload ? isStaleUpload(upload) : false), [upload])
  const [fresh, setFresh] = useState<{ for: string; url: string } | null>(null)

  useEffect(() => {
    if (!upload || !stale) return
    let live = true
    void freshUploadUrl(upload.path).then((next) => {
      if (live) setFresh({ for: url, url: next ?? url })
    })
    return () => {
      live = false
    }
  }, [url, upload, stale])

  // A fresh link once there is one (fetched on mount, or by a click's refresh).
  const shown = fresh?.for === url ? fresh.url : stale ? null : url

  const refresh = useCallback(async () => {
    const current = shown ? signedUploadOf(shown) : null
    if (!current) return null
    const next = await freshUploadUrl(current.path)
    if (next) setFresh({ for: url, url: next })
    return next
  }, [shown, url])

  return { url: shown, refresh }
}
