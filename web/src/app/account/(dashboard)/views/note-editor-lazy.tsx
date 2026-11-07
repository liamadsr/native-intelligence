'use client'

import dynamic from 'next/dynamic'
import { ThinkingOrb } from 'thinking-orbs'

import type { NoteEditorProps } from './note-editor'

/**
 * NoteEditor, loaded on demand.
 *
 * The editor pulls TipTap + ProseMirror — ~1MB of parsed JS in the client
 * bundle, measured on /account. Six detail panels import it, and those panels
 * are themselves reachable from `tab-content`, so a STATIC import put the whole
 * editor on the dashboard's first-load path: every visitor paid for it before
 * anything painted, whether or not they ever opened a document.
 *
 * Every one of those call sites renders the editor deep inside a panel that
 * only exists once a detail view is open, so nothing needs it during the first
 * paint. Import from here rather than from './note-editor' — the direct module
 * is still the right import for TYPES (`import type`), which cost nothing.
 */
export const NoteEditor = dynamic<NoteEditorProps>(
  () => import('./note-editor').then((m) => m.NoteEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-32 flex-1 items-center justify-center">
        <ThinkingOrb state="breathing" size={20} theme="auto" />
      </div>
    ),
  },
)
