'use client'

import {
  VisibilityControl,
  canOfferVisibilityControl,
  useVisibilityViewer,
  type Visibility,
} from './visibility-control'

/**
 * The capture face of the shared scope control (visibility-control.tsx), which
 * documents use too (migration 369). Captures look and behave as they always
 * have: same pill, same copy, same PATCH route.
 */
export type CaptureVisibility = Visibility

export { canOfferVisibilityControl }

/**
 * The viewer's auth user id + workspace member count. `captures.user_id` is a
 * uid, so that is the id the capture gate compares.
 */
export function useCaptureVisibilityViewer(workspaceId: string | null | undefined) {
  const { userId, memberCount } = useVisibilityViewer(workspaceId)
  return { userId, memberCount }
}

interface CaptureVisibilityControlProps {
  captureId: string
  visibility: CaptureVisibility
  /** Applied optimistically by the parent; called again with the old value on failure. */
  onVisibilityChange: (visibility: CaptureVisibility) => void
}

/** Scope control for a capture. Render it only for the capture's creator (the route enforces that too, with a 403). */
export function CaptureVisibilityControl({
  captureId,
  visibility,
  onVisibilityChange,
}: CaptureVisibilityControlProps) {
  return (
    <VisibilityControl
      noun="capture"
      endpoint={`/api/account/captures/${captureId}/visibility`}
      visibility={visibility}
      onVisibilityChange={onVisibilityChange}
    />
  )
}
