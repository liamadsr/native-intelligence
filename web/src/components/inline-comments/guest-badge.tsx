/**
 * Small visual tag for comments whose author isn't a member of the viewing
 * workspace — i.e. someone who reached the capture via a share link and
 * created an account to leave a comment. The capture owner sees this badge
 * so they know who's in their workspace vs who's an external collaborator.
 */
export function GuestBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-dashed border-muted-foreground/30 bg-muted/40 px-1.5 py-0 text-[9px] font-medium uppercase tracking-wide text-muted-foreground ${className}`}
      title="This commenter isn't a member of your workspace"
    >
      Guest
    </span>
  )
}
