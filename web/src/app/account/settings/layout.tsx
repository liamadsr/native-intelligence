import { SettingsShell } from './settings-shell'

export const metadata = {
  title: 'Settings',
}

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Auth is already enforced by middleware for all /account/* routes
  return <SettingsShell>{children}</SettingsShell>
}
