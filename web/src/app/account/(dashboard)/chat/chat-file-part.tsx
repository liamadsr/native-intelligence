'use client'

import type { MouseEvent } from 'react'
import { FileIcon, ImageIcon } from 'lucide-react'
import { SYSTEM_BROWSER_ATTR, SYSTEM_BROWSER_PROPS, hideTarget, openExternalUrl, openInSystemBrowser } from '@/lib/open-external'
import { useFreshUploadUrl } from '@/lib/chat/use-fresh-upload-url'
import { isStaleUpload, signedUploadOf } from '@/lib/chat/fresh-upload-url'

export interface ChatFilePartData {
  type: 'file'
  mediaType: string
  url: string
  filename?: string
}

/** A plain chip: no link to open or preview. */
function FileChip({ part }: { part: ChatFilePartData }) {
  return (
    <span
      data-file-chip=""
      className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs"
    >
      {part.mediaType.startsWith('image/') ? (
        <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
      ) : (
        <FileIcon className="h-3.5 w-3.5 text-muted-foreground" />
      )}
      <span className="max-w-[200px] truncate">{part.filename || 'File'}</span>
    </span>
  )
}

/**
 * A file in a chat message: an image inline, anything else as a badge. A chat
 * upload's link dies an hour after the upload, so an expired one is swapped
 * for a fresh one first (useFreshUploadUrl), showing the plain chip meanwhile,
 * and a click on a link that went stale in a tab left open fetches a fresh
 * one and opens that instead.
 */
export function ChatFilePart({ part }: { part: ChatFilePartData }) {
  const { url, refresh } = useFreshUploadUrl(part.url)

  // A run chat's replay names the files that went with a message, never their
  // links: a plain chip. So is a link still being refreshed.
  if (!part.url || !url) return <FileChip part={part} />

  // A plain click on a link that went stale while shown opens a fresh one in
  // its place. In the capture phase, so it runs before the desktop shell
  // plugin's script on <body>, which opens any target=_blank link whatever
  // preventDefault says: the target is hidden for this click, as the link
  // router hides it (link-router.tsx), and the fresh link is opened here, where
  // the link would have gone (the in-app browser can take a photo; a file
  // marked for the user's browser goes there). Any other click is left alone.
  const openFresh = (event: MouseEvent<HTMLAnchorElement>) => {
    const shown = signedUploadOf(url)
    if (!shown || !isStaleUpload(shown)) return
    if (event.button !== 0 || event.defaultPrevented || event.shiftKey || event.altKey || event.ctrlKey) return
    const el = event.currentTarget
    const restore = hideTarget(el)
    if (!restore) return
    event.preventDefault()
    setTimeout(restore, 0)
    const toSystemBrowser = el.hasAttribute(SYSTEM_BROWSER_ATTR)
    const background = event.metaKey
    void refresh().then((next) => {
      // No fresh one to be had: open what it has.
      const link = next ?? url
      void (toSystemBrowser ? openInSystemBrowser(link) : openExternalUrl(link, { background }))
    })
  }

  if (part.mediaType.startsWith('image/')) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClickCapture={openFresh}
        className="block overflow-hidden rounded-lg border border-border/50"
      >
        <img src={url} alt={part.filename || 'Uploaded image'} className="max-h-48 max-w-full object-contain" />
      </a>
    )
  }
  // The in-app browser shows a PDF but can't download other files: those
  // keep opening in the user's browser.
  const inAppBrowserCanShow = part.mediaType === 'application/pdf'
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClickCapture={openFresh}
      {...(inAppBrowserCanShow ? {} : SYSTEM_BROWSER_PROPS)}
      className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs transition-colors hover:bg-muted/50"
    >
      <FileIcon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="max-w-[200px] truncate">{part.filename || 'File'}</span>
    </a>
  )
}
