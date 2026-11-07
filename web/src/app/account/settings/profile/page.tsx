import { ProfileView } from './profile-view'

export const metadata = {
  title: 'Profile – Settings – Dial8',
}

export default function ProfilePage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <h1 className="text-lg font-semibold">Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your personal profile and workspace access.
        </p>
        <div className="mt-8">
          <ProfileView />
        </div>
      </div>
    </div>
  )
}
