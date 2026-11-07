import { cn } from "@/lib/utils"
import type { Components } from "react-markdown"

/**
 * Styled renderers for GFM tables produced by `remark-gfm`.
 *
 * `react-markdown` emits raw `<table>`/`<thead>`/`<tr>`/`<th>`/`<td>` elements
 * for pipe tables, which render unstyled (and, when `@tailwindcss/typography`
 * isn't loaded, with no spacing at all). These components give tables a border,
 * a muted header row, and horizontal scrolling on overflow — matching the
 * shadcn `Table` look used elsewhere in the app.
 *
 * Spread into any `<ReactMarkdown components={...} />` consumer.
 */
export const markdownTableComponents: Partial<Components> = {
  table: function TableComponent({ children, className, ...props }) {
    return (
      // Never read aloud (the read-aloud sections, @/lib/read-aloud/sections).
      <div className="my-4 w-full overflow-x-auto" data-read-aloud-skip="">
        <table
          className={cn(
            "w-full border-collapse text-sm",
            className
          )}
          {...props}
        >
          {children}
        </table>
      </div>
    )
  },
  thead: function TheadComponent({ children, ...props }) {
    return (
      <thead className="border-b border-border" {...props}>
        {children}
      </thead>
    )
  },
  tbody: function TbodyComponent({ children, ...props }) {
    return (
      <tbody className="[&_tr:last-child]:border-0" {...props}>
        {children}
      </tbody>
    )
  },
  tr: function TrComponent({ children, ...props }) {
    return (
      <tr
        className="border-b border-border transition-colors hover:bg-muted/40"
        {...props}
      >
        {children}
      </tr>
    )
  },
  th: function ThComponent({ children, style, ...props }) {
    return (
      <th
        className="border border-border bg-muted/50 px-3 py-2 text-left align-top font-medium"
        style={style}
        {...props}
      >
        {children}
      </th>
    )
  },
  td: function TdComponent({ children, style, ...props }) {
    return (
      <td
        className="border border-border px-3 py-2 align-top"
        style={style}
        {...props}
      >
        {children}
      </td>
    )
  },
}
