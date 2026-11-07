import { AccountProviders } from './account-providers'

export default function AccountLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Next.js renders every layout beside its segment's asset links, so a
  // layout's root always sits in a forked slot. A client component there is
  // exposed to React's hydration replay bug: if its chunk lands a moment after
  // hydration reaches it, the replay drops the fork from every useId below it
  // (see (dashboard)/layout.tsx). A host element takes the slot instead —
  // `display: contents`, so it adds no box to any account page's layout.
  // Pinned by src/app/__tests__/client-fork-hydration.test.tsx.
  return (
    <div className="contents">
      <AccountProviders>{children}</AccountProviders>
    </div>
  )
}
