'use client'

/**
 * The places the document panel shows its editor's extras
 * (docs/plans/doc-editor-extras.md): the find bar (stuck to the top of the
 * text as it scrolls), the outline column, and the header's find button.
 */
import type { Editor } from '@tiptap/core'
import { TextSearch } from 'lucide-react'
import { PreferenceActionButton } from '@/components/views/preference-action'
import { DocumentOutline } from './doc-outline'
import { FindReplaceBar } from './find-replace-bar'
import { WordCount } from './word-count'
import type { DocumentExtras } from './use-document-extras'

/** The find bar, over the top right of the text; takes no room in the page. */
export function DocumentFindSlot({ extras }: { extras: DocumentExtras }) {
  if (!extras.find || !extras.editor) return null
  return (
    <div className="sticky top-2 z-30 flex h-0 items-start justify-end overflow-visible">
      <FindReplaceBar
        editor={extras.editor}
        initialQuery={extras.find.query}
        openSignal={extras.find.signal}
        onClose={extras.closeFind}
      />
    </div>
  )
}

/** The outline, in a column left of the text, shown only when the card is wide enough for both. */
export function DocumentOutlineColumn({ editor }: { editor: Editor | null }) {
  return (
    <aside className="absolute inset-y-0 left-4 hidden w-48 @min-[1160px]:block">
      <div className="sticky top-6 max-h-[calc(100vh-8rem)] overflow-y-auto pt-6">
        <DocumentOutline editor={editor} />
      </div>
    </aside>
  )
}

/** The header's "Find in document" (also ⌘⇧F with the caret in it); the way in for a reader. */
export function DocumentFindButton({ extras }: { extras: DocumentExtras }) {
  if (!extras.editor) return null
  return (
    <PreferenceActionButton
      label="Find in document"
      variant="ghost"
      size="sm"
      className="h-7 w-7 p-0"
      aria-pressed={!!extras.find}
      title="Find in document (⌘⇧F)"
      onClick={() => (extras.find ? extras.closeFind() : extras.openFind())}
    >
      <TextSearch className="h-3.5 w-3.5" />
    </PreferenceActionButton>
  )
}

/** The live word and character count, under the text. */
export function DocumentCountLine({ editor }: { editor: Editor | null }) {
  return <WordCount editor={editor} className="mt-8 text-xs tabular-nums text-muted-foreground" />
}

/** The outline as a group of the properties column (beside the text, whatever the card's width). */
export function DocumentOutlineGroup({ editor }: { editor: Editor | null }) {
  return <DocumentOutline editor={editor} className="-mx-2" />
}
