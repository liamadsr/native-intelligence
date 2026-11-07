/**
 * The look of the section play button, shared by rendered markdown
 * (components/ui/markdown-sections.tsx: React, lucide icons) and the note
 * editor (components/editor/read-aloud-sections-extension.ts: plain DOM with
 * the same lucide paths), so both surfaces show the same button.
 *
 * Three kinds, named for what a click does: `play` (from the top), `pause`
 * (while its section is read) and `resume` (a section paused before: from the
 * sentence it stopped in, ./resume-points). Play and Resume share the play
 * icon; only the label tells them apart.
 */

export type SectionButtonKind = 'play' | 'pause' | 'resume'

export const SECTION_PLAY_LABEL = 'Play this section'
export const SECTION_PAUSE_LABEL = 'Pause reading'
export const SECTION_RESUME_LABEL = 'Resume this section'

export const SECTION_BUTTON_LABELS: Record<SectionButtonKind, string> = {
  play: SECTION_PLAY_LABEL,
  pause: SECTION_PAUSE_LABEL,
  resume: SECTION_RESUME_LABEL,
}

/** Marks the button (its SectionButtonKind), for tests and styling. */
export const SECTION_BUTTON_ATTR = 'data-read-aloud-section'

/**
 * A 20px round ghost button right after the anchor's text. Its margins cancel
 * out (6px + 20px − 26px = 0), so it takes no room on the line and a heading
 * never re-wraps when it appears.
 */
export const SECTION_BUTTON_CLASS =
  'ml-1.5 -mr-[26px] inline-flex size-5 shrink-0 select-none items-center justify-center rounded-full align-middle text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

export const SECTION_PLAY_ICON_CLASS = 'size-[11px] fill-current'
export const SECTION_PAUSE_ICON_CLASS = 'size-[10px] fill-current'
