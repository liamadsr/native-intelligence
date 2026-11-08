import { Suspense } from 'react'
import type { Metadata } from 'next'
import { adminEmailDomain } from '@/lib/admin-emails'
import { isGoogleSignInEnabled } from '@/lib/auth/google-sign-in'
import { LoginForm } from './login-form'

// Admin sign-in — a utility route with no SEO value; keep it out of the index.
export const metadata: Metadata = {
  title: 'Admin login',
  robots: { index: false, follow: false },
}

export default function AdminLoginPage() {
  return (
    <Suspense>
      <LoginForm googleOnDial8={isGoogleSignInEnabled()} adminDomain={adminEmailDomain()} />
    </Suspense>
  )
}
