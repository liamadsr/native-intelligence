'use client'

import { Link } from '@/components/link'
import { Logo } from '@/components/logo'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { RequestResetLinkForm } from './request-reset-link-form'

export function ForgotPasswordForm() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-foreground lg:p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex justify-center">
            <Link href="/" title="Home">
              <Logo className="h-9" />
            </Link>
          </div>
          <CardTitle className="mt-4">Reset your password</CardTitle>
          <CardDescription>
            Enter the email associated with your account. We&apos;ll send you a
            link to set a new password.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <RequestResetLinkForm submitLabel="Send reset link" />

          <div className="text-center text-sm text-muted-foreground">
            <Link href="/login" className="hover:text-foreground">
              Back to sign in
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
