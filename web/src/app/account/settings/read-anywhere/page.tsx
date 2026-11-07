import { redirect } from 'next/navigation'

/** Read anywhere moved into Settings → Voice (2026-10-22); old links land there. */
export default function ReadAnywhereSettingsPage() {
  redirect('/account/settings/voice')
}
