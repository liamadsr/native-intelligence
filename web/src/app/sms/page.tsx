import type { Metadata } from 'next'
import SmsProgram from './client'

export const metadata: Metadata = {
  // Held as Dial8 with the rest of this page until the 10DLC campaign names the new brand (docs/plans/native-intelligence-rename.md).
  title: { absolute: 'Text Messaging (SMS) - Dial8' },
  description: 'How Dial8 account holders opt in to text their AI assistant, what we send, and how to opt out.',
  alternates: { canonical: '/sms' },
  openGraph: {
    title: 'Text Messaging (SMS) – Dial8',
    description: 'How Dial8 account holders opt in to text their AI assistant, what we send, and how to opt out.',
    url: 'https://dial8.ai/sms',
    type: 'website',
  },
}

export default function SmsPage() {
  return <SmsProgram />
}
