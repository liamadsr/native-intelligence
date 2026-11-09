import { createClient } from '@/lib/supabase/server'
import { getAdminEnv, getAdminServiceClient, hasAdminAssurance, isAuthorizedAdmin } from '@/lib/admin'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { AdminSidebar } from './admin-sidebar'

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user || !isAuthorizedAdmin(user.email) || !(await hasAdminAssurance(supabase))) {
    redirect('/admin/login')
  }

  const adminEnv = await getAdminEnv()
  const cookieStore = await cookies()
  const defaultOpen = cookieStore.get('sidebar_state')?.value !== 'false'

  // Fetch campaigns for sidebar nav
  const serviceClient = await getAdminServiceClient()
  const { data: campaigns } = await serviceClient
    .from('campaigns')
    .select('id, title')
    .eq('is_active', true)
    .order('created_at', { ascending: true })

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AdminSidebar
        email={user.email ?? ''}
        adminEnv={adminEnv}
        campaigns={campaigns ?? []}
      />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4 text-foreground">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <span className="text-sm font-medium">Native Intelligence Admin</span>
        </header>
        <div className="mx-auto w-full max-w-6xl px-6 py-8">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
