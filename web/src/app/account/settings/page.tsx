import { PreferencesView } from './preferences-view'

export const metadata = {
  title: 'Preferences – Settings – Dial8',
}

export default function SettingsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <h1 className="text-lg font-semibold">Preferences</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your account preferences and settings.
        </p>
        <div className="mt-8">
          <PreferencesView />
        </div>
      </div>
    </div>
  )
}
