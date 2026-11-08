import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
// The root landing page is the sales pitch (see ./sales-page.tsx), rendered
// through ./landing-variant-switch.tsx: a PostHog A/B split (flag:
// `landing-page-variant`) whose other arms — meeting-notes, company-brain, and
// the original landing page — the dashboard holds at 0%. Sales is also what
// every unresolved state renders (SSR, flag not loaded, unknown key).
import { LandingVariantSwitch } from './landing-variant-switch'
import { HomeRoadmapSlot } from '@/components/roadmap/home-roadmap'
import {
  StructuredData,
  organizationSchema,
  websiteSchema,
  softwareApplicationSchema,
} from '@/components/structured-data'

// The homepage's own title/description, overriding the site defaults in
// layout.tsx. This is the sales positioning that used to live on the /sales
// route — that route is now a redirect here, so the metadata came with it.
// The root title carries no "for Sales Teams" qualifier: at `/` the pitch is
// the whole company's, not a segment page.
export const metadata: Metadata = {
  title: 'Dial8 — the end-to-end AI sales platform',
  description:
    'Dial8 turns everything your sales team knows — playbooks, product knowledge, competitors, deal history — into intelligence every rep can use live on every call.',
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
      <LandingVariantSwitch roadmap={<HomeRoadmapSlot />} />
    </>
  )
}
