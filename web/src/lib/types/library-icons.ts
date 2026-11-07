/**
 * Canonical icons for the library categories — ONE source of truth so the type
 * picker, the ⌘K palette, and tab labels can never drift apart again (they
 * shipped with three different agent icons once).
 *
 * Deliberate choices (Liam, 2026-07-12):
 *   - agent → Boxes ("the three boxes") — matches the Agents & Skills nav icon.
 *   - skill → ScrollText — document-family (a skill is a playbook) but a
 *     clearly different silhouette from the docs page's FileText, so the two
 *     never read as the same thing.
 *
 * Lives apart from types/library.ts because that module is imported by API
 * routes, and icon VALUES would drag React components into route bundles.
 */
import { Boxes, ScrollText, type LucideIcon } from 'lucide-react'
import type { LibraryCategory } from './library'

export const LIBRARY_CATEGORY_ICONS: Record<LibraryCategory, LucideIcon> = {
  agent: Boxes,
  skill: ScrollText,
}
