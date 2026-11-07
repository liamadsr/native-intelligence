'use client'

/**
 * Landing demo of a finished capture document: the capture's notes with the
 * decisions the live agent auto-accepted (CaptureDemo's `notes` variant,
 * ./capture-demo.tsx, which draws the product's own proposal rows).
 */
import { CaptureDemo } from './capture-demo'

export function NotesDocDemo() {
  return <CaptureDemo variant="notes" />
}
