import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { VoiceEnrollmentFlow } from './voice-enrollment-flow'

export const metadata = {
  title: { absolute: 'Teach Native Intelligence your voice' },
}

export default async function VoiceEnrollmentPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return <VoiceEnrollmentFlow />
}
