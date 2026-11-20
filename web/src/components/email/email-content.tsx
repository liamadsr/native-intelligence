'use client'

import { useEffect, useRef, useCallback } from 'react'
import { prepareEmailForDisplay } from './email-sanitize'
import { adaptEmailColors } from './email-colors'
import { isOpenableUrl, openExternalUrl, openInSystemBrowser } from '@/lib/open-external'

interface EmailContentProps {
  html: string
  senderEmail?: string
}

/**
 * Put an email on the page: sanitized, drawn on its own canvas or on the
 * theme (email-colors' two modes), and in the second case re-coloured against
 * the theme's background now that its styles can be computed. Always from the
 * original HTML, so a theme switch never compounds an earlier re-colouring.
 */
function renderEmail(root: ShadowRoot, html: string, dark: boolean) {
  const display = prepareEmailForDisplay(html, dark)
  root.innerHTML = display.html
  ;(root.host as HTMLElement).dataset.emailMode = display.mode
  if (display.mode === 'adapt') adaptEmailColors(root, display.pageBackground)
}

/**
 * Renders email HTML inside a Shadow DOM to fully isolate email styles
 * from the app. Handles dark mode, quoted text collapsing, link interception,
 * and image error handling.
 */
export function EmailContent({ html, senderEmail }: EmailContentProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const shadowRootRef = useRef<ShadowRoot | null>(null)

  const isDarkMode = useCallback(() => {
    return document.documentElement.classList.contains('dark')
  }, [])

  // Create shadow root once
  useEffect(() => {
    if (!hostRef.current || shadowRootRef.current) return
    shadowRootRef.current = hostRef.current.attachShadow({ mode: 'open' })
  }, [])

  // Render processed HTML into shadow DOM
  useEffect(() => {
    if (!shadowRootRef.current || !html) return

    const root = shadowRootRef.current
    renderEmail(root, html, isDarkMode())

    // Intercept link clicks: a web link opens in the user's own browser. On
    // desktop, window.open is dropped, so a web link must go through
    // openExternalUrl.
    const handleClick = (e: Event) => {
      const target = e.target as HTMLElement
      const anchor = target.closest('a')
      if (!anchor) return

      const href = anchor.getAttribute('href')
      if (!href) return

      e.preventDefault()
      e.stopPropagation()

      const click = e as MouseEvent
      if (href.startsWith('mailto:')) {
        window.location.href = href
      } else if (isOpenableUrl(href)) {
        void (click.shiftKey || click.altKey
          ? openInSystemBrowser(href)
          : openExternalUrl(href, { background: click.metaKey }))
      } else {
        window.open(href, '_blank', 'noopener,noreferrer')
      }
    }
    root.addEventListener('click', handleClick)

    // Hide broken images
    const handleError = (e: Event) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'IMG') {
        ;(target as HTMLImageElement).style.display = 'none'
      }
    }
    root.addEventListener('error', handleError, true)

    return () => {
      root.removeEventListener('click', handleClick)
      root.removeEventListener('error', handleError, true)
    }
  }, [html, isDarkMode])

  // Listen for dark mode changes and re-render
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (!shadowRootRef.current || !html) return
      renderEmail(shadowRootRef.current, html, isDarkMode())
    })

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })

    return () => observer.disconnect()
  }, [html, isDarkMode])

  return <div ref={hostRef} className="w-full" />
}
