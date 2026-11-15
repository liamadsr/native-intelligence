// /replace-apps: what the workspace stands in for, and what that costs a team
// today. The page is components/site/replace-apps-view.tsx; the apps and
// their published prices are data (lib/marketing/replace-apps.ts).
import type { Metadata } from 'next'
import { ReplaceAppsView } from '@/components/site/replace-apps-view'
import { appUrl } from '@/lib/app-url'

const TITLE = 'Replace your apps with one workspace'
const DESCRIPTION =
  'Add up what your team pays for chat, tasks, docs, meeting notes, scheduling and a CRM, and compare it with one workspace that does all of it.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/replace-apps' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: `${appUrl()}/replace-apps`, type: 'website' },
}

export default function ReplaceAppsPage() {
  return <ReplaceAppsView />
}
