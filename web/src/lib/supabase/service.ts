import { createStatelessClient } from '@/lib/supabase/stateless'

export function getServiceClient() {
  return createStatelessClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}
