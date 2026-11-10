import { ResetPasswordForm } from './reset-password-form'

export const metadata = {
  title: 'Set New Password',
  robots: { index: false, follow: false },
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>
}) {
  // A reset link that failed lands here with ?error= (src/app/auth/confirm,
  // or the desktop app's deep-link handler).
  const { error } = await searchParams
  return <ResetPasswordForm linkError={error === undefined ? undefined : [error].flat()[0] ?? ''} />
}
