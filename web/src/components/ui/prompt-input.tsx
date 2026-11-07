"use client"

import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

type PromptInputContextType = {
  isLoading: boolean
  value: string
  setValue: (value: string) => void
  maxHeight: number | string
  onSubmit?: () => void
  disabled?: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

const PromptInputContext = createContext<PromptInputContextType>({
  isLoading: false,
  value: "",
  setValue: () => {},
  maxHeight: 240,
  onSubmit: undefined,
  disabled: false,
  textareaRef: React.createRef<HTMLTextAreaElement>(),
})

function usePromptInput() {
  return useContext(PromptInputContext)
}

export type PromptInputProps = {
  isLoading?: boolean
  value?: string
  onValueChange?: (value: string) => void
  maxHeight?: number | string
  onSubmit?: () => void
  children: React.ReactNode
  className?: string
  disabled?: boolean
} & React.ComponentProps<"div">

function PromptInput({
  className,
  isLoading = false,
  maxHeight = 240,
  value,
  onValueChange,
  onSubmit,
  children,
  disabled = false,
  onClick,
  ...props
}: PromptInputProps) {
  const [internalValue, setInternalValue] = useState(value || "")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleChange = useCallback(
    (newValue: string) => {
      setInternalValue(newValue)
      onValueChange?.(newValue)
    },
    [onValueChange]
  )

  const handleClick: React.MouseEventHandler<HTMLDivElement> = (e) => {
    if (!disabled) textareaRef.current?.focus()
    onClick?.(e)
  }

  // Memoized so a PromptInput re-render with unchanged inputs doesn't hand the
  // textarea / action consumers a fresh context object (and re-render them).
  const currentValue = value ?? internalValue
  const setValue = onValueChange ?? handleChange
  const contextValue = useMemo<PromptInputContextType>(
    () => ({
      isLoading,
      value: currentValue,
      setValue,
      maxHeight,
      onSubmit,
      disabled,
      textareaRef,
    }),
    [isLoading, currentValue, setValue, maxHeight, onSubmit, disabled]
  )

  return (
    <TooltipProvider>
      <PromptInputContext.Provider value={contextValue}>
        <div
          onClick={handleClick}
          className={cn(
            "border-input bg-background cursor-text rounded-3xl border p-2 shadow-xs",
            disabled && "cursor-not-allowed opacity-60",
            className
          )}
          {...props}
        >
          {children}
        </div>
      </PromptInputContext.Provider>
    </TooltipProvider>
  )
}

/**
 * The browser sizes the field to its text by itself (`field-sizing: content`,
 * the `textarea[data-autosize]` rule in tailwind.css): WebKit, the desktop
 * app's web view, and Chromium. Then nothing here measures.
 *
 * Measuring (height auto, then scrollHeight) makes the browser settle every
 * pending style and layout change in the whole page right then, inside the
 * keystroke. In a long desktop session that came to ~100 ms a key, paid three
 * times over (the change handler and two layout effects each measured), and
 * typing in the chat box went "slow motion".
 */
function browserSizesField(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content")
}

export type PromptInputTextareaProps = {
  disableAutosize?: boolean
  /** Hide the placeholder when the field is narrower than this (px). Keeps a
   *  cramped input from showing clipped/awkward placeholder text. */
  hidePlaceholderBelow?: number
} & React.ComponentProps<typeof Textarea>

function PromptInputTextarea({
  className,
  onKeyDown,
  disableAutosize = false,
  hidePlaceholderBelow = 220,
  placeholder,
  style,
  ...props
}: PromptInputTextareaProps) {
  const { value, setValue, maxHeight, onSubmit, disabled, textareaRef } =
    usePromptInput()

  // Drop the placeholder entirely when the field gets too narrow to show it
  // cleanly (e.g. a shrunken chat panel). Tracked via ResizeObserver on the
  // textarea itself.
  const [placeholderHidden, setPlaceholderHidden] = useState(false)
  useEffect(() => {
    const el = textareaRef.current
    if (!el || !hidePlaceholderBelow) return
    const update = () => setPlaceholderHidden(el.clientWidth < hidePlaceholderBelow)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [hidePlaceholderBelow, textareaRef])

  const effectivePlaceholder = placeholderHidden ? "" : placeholder

  const adjustHeight = (el: HTMLTextAreaElement | null) => {
    if (!el || disableAutosize) return
    if (browserSizesField()) {
      if (el.style.height) el.style.height = ""
      return
    }

    el.style.height = "auto"

    // The placeholder can wrap to multiple lines in a narrow field, which would
    // inflate scrollHeight and grow an *empty* input. Measure against the value
    // only: when there's no value, blank the placeholder so it never counts
    // toward the autosized height (so the box stays one row when empty).
    const placeholder = el.placeholder
    if (!el.value) el.placeholder = ""

    if (typeof maxHeight === "number") {
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    } else {
      el.style.height = `min(${el.scrollHeight}px, ${maxHeight})`
    }

    if (!el.value) el.placeholder = placeholder
  }

  // Stable callback ref: an inline one is a new function every render, so React
  // detached (ref(null)) and re-attached it on EVERY commit. It only records the
  // element now; the per-commit re-measure it used to do on each re-attach is
  // the explicit layout effect below.
  const handleRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      textareaRef.current = el
    },
    [textareaRef]
  )

  // Re-measure on every commit this component renders in — the exact cadence
  // the inline ref's re-attach gave. Kept on purpose: an incidental re-render
  // is what corrects the height after a width change (the field re-wraps)
  // with no value change, and consumers of this shared input may rely on that.
  // It is also the ONE measure a keystroke gets: a value change re-renders
  // this, and this runs before paint, so the change handler doesn't measure
  // too, and nothing measures again after it in the same commit.
  useLayoutEffect(() => {
    adjustHeight(textareaRef.current)
  })

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
  }

  // The consumer's handler first: a key it takes (preventDefault — a menu open
  // over the field picking with Enter) doesn't send as well.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented) return
    // Mid IME composition, Enter picks the candidate: it never sends.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      onSubmit?.()
    }
  }

  return (
    <Textarea
      ref={handleRef}
      value={value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      placeholder={effectivePlaceholder}
      className={cn(
        "text-primary min-h-[44px] w-full resize-none border-none bg-transparent shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0",
        className
      )}
      // The browser's own sizing where it has it (browserSizesField), capped
      // where the measure caps it.
      data-autosize={disableAutosize ? undefined : ""}
      style={disableAutosize ? style : { maxHeight: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight, ...style }}
      rows={1}
      disabled={disabled}
      {...props}
    />
  )
}

export type PromptInputActionsProps = React.HTMLAttributes<HTMLDivElement>

function PromptInputActions({
  children,
  className,
  ...props
}: PromptInputActionsProps) {
  return (
    <div className={cn("flex items-center gap-2", className)} {...props}>
      {children}
    </div>
  )
}

export type PromptInputActionProps = {
  className?: string
  tooltip: React.ReactNode
  children: React.ReactNode
  side?: "top" | "bottom" | "left" | "right"
} & React.ComponentProps<typeof Tooltip>

function PromptInputAction({
  tooltip,
  children,
  className,
  side = "top",
  ...props
}: PromptInputActionProps) {
  const { disabled } = usePromptInput()

  return (
    <Tooltip {...props}>
      <TooltipTrigger
        asChild
        disabled={disabled}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} className={className}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
  PromptInputAction,
}
