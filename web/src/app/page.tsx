import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
// The root landing page: Native Intelligence as one workspace for the whole
// company (./workspace-page.tsx). It replaced the sales pitch and the PostHog
// A/B switch (`landing-page-variant`) that served it on 2026-11-14; the flag
// is no longer read anywhere.
import WorkspacePage from './workspace-page'
import { HOME_DESCRIPTION, HOME_TITLE } from './home-meta'
import { HomeRoadmapSlot } from '@/components/roadmap/home-roadmap'
import {
  StructuredData,
  organizationSchema,
  websiteSchema,
  softwareApplicationSchema,
} from '@/components/structured-data'

// The homepage's own title and description (./home-meta.ts), the same
// sentence the site defaults in layout.tsx use. `absolute` keeps the layout's
// "%s - Native Intelligence" template off a title that already names us.
export const metadata: Metadata = {
  title: { absolute: HOME_TITLE },
  description: HOME_DESCRIPTION,
}

export default async function Home() {
  // Signed-in visitors land straight in the app instead of the marketing
  // page. The check runs server-side so the redirect happens before any
  // landing-page HTML ships — no flash. Signed-out visitors fall through to
  // the marketing landing page below.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    redirect('/account')
  }

  return (
    <>
      <StructuredData
        data={[organizationSchema, websiteSchema, softwareApplicationSchema]}
      />
      {/* The roadmap section is a server component: GitHub is read here, on
          the server and through its five-minute cache, never from the
          browser. It streams in behind its own Suspense boundary, so the
          page never waits on it. */}
      <WorkspacePage roadmap={<HomeRoadmapSlot />} />
    </>
  )
}
