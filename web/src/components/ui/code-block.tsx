"use client"

import { cn } from "@/lib/utils"
import React, { useEffect, useState } from "react"
import type * as Shiki from "shiki"

// shiki is fetched the first time a code block mounts, not with the page. This
// component sits under the chat, which is on the dashboard's first-load path,
// and a static import put shiki's ~180 KB chunk there for every visitor — while
// only a reply that actually contains a fenced code block needs it. Until it
// arrives the block shows its plain-text fallback below, as it already did
// while a highlight was in flight. The full bundle (not `shiki/bundle/web`) is
// kept on purpose: fence languages come from model output, and the web bundle
// drops common ones (rust, go, …) to the plain-text fallback.
let shikiModule: Promise<typeof Shiki> | null = null
function loadShiki() {
  shikiModule ??= import("shiki").catch((error: unknown) => {
    // Don't cache a failed fetch — the next highlight retries it.
    shikiModule = null
    throw error
  })
  return shikiModule
}

const codeToHtml: typeof Shiki.codeToHtml = async (code, options) =>
  (await loadShiki()).codeToHtml(code, options)

export type CodeBlockProps = {
  children?: React.ReactNode
  className?: string
} & React.HTMLProps<HTMLDivElement>

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <div
      // Never read aloud (the read-aloud sections, @/lib/read-aloud/sections).
      data-read-aloud-skip=""
      className={cn(
        "not-prose flex w-full flex-col overflow-clip border",
        "border-border bg-card text-card-foreground rounded-xl",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export type CodeBlockCodeProps = {
  code: string
  language?: string
  theme?: string
  className?: string
} & React.HTMLProps<HTMLDivElement>

function CodeBlockCode({
  code,
  language = "tsx",
  theme = "github-light",
  className,
  ...props
}: CodeBlockCodeProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null)

  useEffect(() => {
    async function highlight() {
      if (!code) {
        setHighlightedHtml("<pre><code></code></pre>")
        return
      }

      try {
        const html = await codeToHtml(code, { lang: language, theme })
        setHighlightedHtml(html)
      } catch {
        // Fall back to plain text if the language is not supported (e.g. malformed AI-generated code blocks)
        try {
          const html = await codeToHtml(code, { lang: "text", theme })
          setHighlightedHtml(html)
        } catch {
          setHighlightedHtml(`<pre><code>${code.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></pre>`)
        }
      }
    }
    highlight()
  }, [code, language, theme])

  const classNames = cn(
    "w-full overflow-x-auto text-[13px] [&>pre]:px-4 [&>pre]:py-4",
    className
  )

  // SSR fallback: render plain code if not hydrated yet
  return highlightedHtml ? (
    <div
      className={classNames}
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      {...props}
    />
  ) : (
    <div className={classNames} {...props}>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>

function CodeBlockGroup({
  children,
  className,
  ...props
}: CodeBlockGroupProps) {
  return (
    <div
      className={cn("flex items-center justify-between", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export { CodeBlockGroup, CodeBlockCode, CodeBlock }
