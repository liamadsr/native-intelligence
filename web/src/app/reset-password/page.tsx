import { ResetPasswordForm } from './reset-password-form'

export const metadata = {
  title: 'Set New Password – Dial8',
  robots: { index: false, follow: false },
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>
}) {
  // A reset link that failed lands here with ?error= (src/app/auth/confirm).
  const { error } = await searchParams
  return <ResetPasswordForm linkFailed={error !== undefined} />
}
