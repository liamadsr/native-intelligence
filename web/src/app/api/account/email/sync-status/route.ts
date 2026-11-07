import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = getServiceClient()
  const { data: syncStates } = await admin
    .from('email_sync_state')
    .select('*')
    .eq('user_id', user.id)

  return NextResponse.json({ syncStates: syncStates || [] })
}
