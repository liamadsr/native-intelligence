"use client"

import { cn } from "@/lib/utils"
import { StickToBottom, type StickToBottomInstance } from "use-stick-to-bottom"

export type ChatContainerRootProps = {
  children: React.ReactNode
  className?: string
  /** Scroll behavior when content resizes. Defaults to "smooth". */
  resize?: "smooth" | "instant"
  /** Optional externally-owned stick-to-bottom instance. Pass this when a parent
   *  (outside the provider) needs to drive `scrollToBottom()` directly — e.g. to
   *  force a snap to the bottom when the user sends a message. When omitted the
   *  component owns its own instance as before. */
  instance?: StickToBottomInstance
} & React.HTMLAttributes<HTMLDivElement>

export type ChatContainerContentProps = {
  children: React.ReactNode
  className?: string
} & React.HTMLAttributes<HTMLDivElement>

export type ChatContainerScrollAnchorProps = {
  className?: string
  ref?: React.RefObject<HTMLDivElement>
} & React.HTMLAttributes<HTMLDivElement>

function ChatContainerRoot({
  children,
  className,
  resize = "smooth",
  instance,
  ...props
}: ChatContainerRootProps) {
  return (
    <StickToBottom
      className={cn("flex overflow-y-auto", className)}
      resize={resize}
      initial="instant"
      role="log"
      {...(instance ? { instance } : {})}
      {...props}
    >
      {children}
    </StickToBottom>
  )
}

function ChatContainerContent({
  children,
  className,
  ...props
}: ChatContainerContentProps) {
  return (
    <StickToBottom.Content
      className={cn("flex w-full flex-col", className)}
      {...props}
    >
      {children}
    </StickToBottom.Content>
  )
}

function ChatContainerScrollAnchor({
  className,
  ...props
}: ChatContainerScrollAnchorProps) {
  return (
    <div
      className={cn("h-px w-full shrink-0 scroll-mt-4", className)}
      aria-hidden="true"
      {...props}
    />
  )
}

export { ChatContainerRoot, ChatContainerContent, ChatContainerScrollAnchor }
