import { ForgotPasswordForm } from './forgot-password-form'

export const metadata = {
  title: 'Forgot Password',
  robots: { index: false, follow: false },
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />
}
