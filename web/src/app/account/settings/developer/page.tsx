import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { DevSettingsView } from './dev-settings-view'

export const metadata = {
  title: 'Developer – Settings',
}

export default async function DevSettingsPage() {
  // Hard block: never render in production
  if (process.env.NODE_ENV === 'production') {
    redirect('/account/settings')
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-10">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Developer</h1>
          <span className="rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            Dev only
          </span>
        </div>
        <p className="mt-1 text-muted-foreground">
          Tools for local development and testing. This page is not available in
          production.
        </p>
        <div className="mt-8">
          <DevSettingsView />
        </div>
      </div>
    </div>
  )
}
