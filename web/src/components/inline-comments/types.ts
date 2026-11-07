export interface UnifiedComment {
  id: string
  content: string
  author_name: string
  author_avatar: string | null
  author_id: string | null
  author_email: string | null
  /** True when the commenter is an external user (auth user, not a workspace
   *  member). Surfaced so the UI can add a "Guest" badge. */
  is_guest?: boolean
  parent_id: string | null
  created_at: string
  edited_at: string | null
  anchor_text: string | null
  anchor_prefix: string | null
  anchor_suffix: string | null
  anchor_section: string | null
  anchor_occurrence: number | null
  is_resolved: boolean
}

export interface InlineComment extends UnifiedComment {
  anchor_text: string
  anchor_prefix: string
  anchor_suffix: string
  anchor_section: string
  anchor_occurrence: number
  replies: UnifiedComment[]
}

export interface SelectionState {
  text: string
  prefix: string
  suffix: string
  section: string
  occurrenceIndex: number
  rect: DOMRect
}

export type ContentSection = 'capture' | 'notes' | 'enhanced' | 'summary' | 'transcript' | 'decisions' | 'document'

export type CommentIdentity =
  | {
      mode: 'authenticated'
      /** Member id in the shared item's workspace, or null when the
       *  viewer is signed in but not a member (external commenter). */
      memberId: string | null
      displayName: string
      avatarUrl: string | null
    }
  | { mode: 'guest' }

export interface CommentAPI {
  postComment(body: Record<string, unknown>): Promise<UnifiedComment | null>
  resolveComment(commentId: string, resolved: boolean): Promise<boolean>
}
