import { cn } from "@/lib/utils"
import { marked } from "marked"
import { memo, useId, useMemo, useRef, type ComponentProps } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { CodeBlock, CodeBlockCode } from "./code-block"
import { markdownTableComponents } from "./markdown-table"
import {
  MarkdownSectionsContext,
  SECTION_COMPONENTS,
  type MarkdownSections,
} from "./markdown-sections"
import { remarkSuggestionMarkers, SUGGESTION_ELEMENT } from "@/components/suggestions/remark-suggestion-markers"
import { SuggestionMarkerElement } from "@/components/suggestions/suggestion-marker-element"
import { EntityRefChip } from "@/components/entity-refs/entity-ref-chip"
import { remarkEntityRefs } from "@/components/entity-refs/remark-entity-refs"
import { EXTERNAL_LINK_PROPS, isExternalHref } from "@/lib/open-external"

/** Module-level and stable: the blocks are memoized on content alone, so the
 *  plugins and the always-merged components must never change identity. */
const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkSuggestionMarkers, remarkEntityRefs]

/**
 * Always merged under a consumer's components (docs/plans/suggestions-everywhere.md):
 *   • `<!-- proposal:ID -->` markers render as suggestion cards;
 *   • action identifiers (GEN-297, …) the `remarkEntityRefs` plugin marks render
 *     as live chips. Neither is an HTML tag, so they're cast in; react-markdown
 *     passes the node's properties through as props.
 */
const SUGGESTION_COMPONENTS = {
  [SUGGESTION_ELEMENT]: SuggestionMarkerElement,
  "entity-ref": EntityRefChip,
} as unknown as Partial<Components>

/**
 * A link in rendered markdown (a chat reply, a brief, a wiki page). A link to
 * another site opens in a new tab: on the web a plain one navigated the app's
 * own tab away, and on desktop it opens in the user's own browser. The app's
 * own links and mailto: are left as they are.
 */
function MarkdownLink({
  node: _node,
  href,
  children,
  ...props
}: ComponentProps<"a"> & { node?: unknown }) {
  return (
    <a href={href} {...props} {...(isExternalHref(href) ? EXTERNAL_LINK_PROPS : {})}>
      {children}
    </a>
  )
}

/** Always merged under a consumer's components, like SUGGESTION_COMPONENTS. */
const LINK_COMPONENTS: Partial<Components> = { a: MarkdownLink }

export type MarkdownProps = {
  children: string
  id?: string
  className?: string
  components?: Partial<Components>
  /** Read-aloud: a hover "play this section" button on headings and bold
   *  lead-ins (desktop only, see ./markdown-sections). On by default; pass
   *  false while the text is still streaming. */
  readAloudSections?: boolean
  /** The surface has its own button that reads all of this text (a chat
   *  reply's Read aloud): no section button for a section that is all of it. */
  readAloudSkipWhole?: boolean
}

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown)
  return tokens.map((token) => token.raw)
}

function extractLanguage(className?: string): string {
  if (!className) return "plaintext"
  const match = className.match(/language-(\w+)/)
  return match ? match[1] : "plaintext"
}

const INITIAL_COMPONENTS: Partial<Components> = {
  code: function CodeComponent({ className, children, ...props }) {
    const isInline =
      !props.node?.position?.start.line ||
      props.node?.position?.start.line === props.node?.position?.end.line

    if (isInline) {
      return (
        <span
          className={cn(
            "bg-primary-foreground rounded-sm px-1 font-mono text-sm",
            className
          )}
          {...props}
        >
          {children}
        </span>
      )
    }

    const language = extractLanguage(className)

    return (
      <CodeBlock className={className}>
        <CodeBlockCode code={children as string} language={language} />
      </CodeBlock>
    )
  },
  pre: function PreComponent({ children }) {
    return <>{children}</>
  },
  ...markdownTableComponents,
}

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    components = INITIAL_COMPONENTS,
  }: {
    content: string
    components?: Partial<Components>
  }) {
    return (
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={components}
      >
        {content}
      </ReactMarkdown>
    )
  },
  function propsAreEqual(prevProps, nextProps) {
    return prevProps.content === nextProps.content
  }
)

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock"

function MarkdownComponent({
  children,
  id,
  className,
  components = INITIAL_COMPONENTS,
  readAloudSections = true,
  readAloudSkipWhole = false,
}: MarkdownProps) {
  const generatedId = useId()
  const blockId = id ?? generatedId
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children])
  const rootRef = useRef<HTMLDivElement>(null)

  // The section overrides (h1–h4, p) are always merged, whatever
  // `readAloudSections` says: the blocks are memoized on their content alone,
  // so a reply finishing its stream must not need new components to show its
  // buttons. The overrides read the flags from context instead. A consumer's
  // own `components` still replace the defaults, and win on the same tag.
  const mergedComponents = useMemo(
    () => ({ ...SECTION_COMPONENTS, ...SUGGESTION_COMPONENTS, ...LINK_COMPONENTS, ...components }),
    [components]
  )
  const sections = useMemo<MarkdownSections>(
    () => ({
      rootRef,
      enabled: readAloudSections,
      skipWhole: readAloudSkipWhole,
    }),
    [readAloudSections, readAloudSkipWhole]
  )

  return (
    <MarkdownSectionsContext.Provider value={sections}>
      <div ref={rootRef} className={className}>
        {blocks.map((block, index) => (
          <MemoizedMarkdownBlock
            key={`${blockId}-block-${index}`}
            content={block}
            components={mergedComponents}
          />
        ))}
      </div>
    </MarkdownSectionsContext.Provider>
  )
}

const Markdown = memo(MarkdownComponent)
Markdown.displayName = "Markdown"

export { Markdown }
