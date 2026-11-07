'use client'

import { useEffect, useState } from 'react'
import { Container } from '@/components/container'
import { Navbar } from '@/components/navbar'
import { Heading } from '@/components/text'

export default function Welcome() {
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>(
    'processing',
  )
  const [callbackUrl, setCallbackUrl] = useState<string | null>(null)
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    // Detect iOS / mobile
    const ua = navigator.userAgent
    const mobile = /iPhone|iPad|iPod|Android/i.test(ua)
    setIsMobile(mobile)

    // Debug logging
    console.log('Welcome page - Full URL:', window.location.href)
    console.log('Welcome page - Hash:', window.location.hash)
    console.log('Welcome page - Search:', window.location.search)
    console.log('Welcome page - Mobile:', mobile)

    // Check for PKCE code in query params (e.g., ?code=xxx)
    const urlParams = new URLSearchParams(window.location.search)
    const code = urlParams.get('code')

    // Also check for tokens in hash (e.g., #access_token=xxx)
    const hash = window.location.hash.substring(1)

    let constructedUrl: string | null = null

    if (code) {
      // PKCE flow - pass code and all query params to the app
      try {
        const params = new URLSearchParams(window.location.search)
        constructedUrl = `dial8://auth-callback?${params.toString()}`
        console.log('Welcome page - Detected PKCE flow')
        console.log('Welcome page - Callback URL:', constructedUrl)
      } catch (error) {
        console.error('Error constructing callback URL:', error)
        setTimeout(() => setStatus('error'), 0)
        return
      }
    } else if (hash) {
      // Parse hash parameters to check for password reset
      try {
        const params = new URLSearchParams(hash)
        const type = params.get('type')
        const accessToken = params.get('access_token')
        const refreshToken = params.get('refresh_token')

        console.log('Welcome page - Parsed hash params:', {
          type,
          accessToken: accessToken ? 'present' : 'missing',
          refreshToken: refreshToken ? 'present' : 'missing',
        })

        if (type === 'recovery' && accessToken) {
          // Password reset flow
          constructedUrl = `dial8://auth-callback#access_token=${accessToken}&refresh_token=${refreshToken || ''}&type=recovery`
          console.log('Welcome page - Detected hash password reset')
        } else {
          // Regular OAuth flow
          constructedUrl = `dial8://auth-callback#${hash}`
          console.log('Welcome page - Detected regular hash OAuth')
        }
      } catch (error) {
        console.error('Error constructing callback URL:', error)
        setTimeout(() => setStatus('error'), 0)
        return
      }
    } else {
      // No code or hash, just show success message
      setTimeout(() => setStatus('success'), 0)
      return
    }

    if (!constructedUrl) {
      setTimeout(() => setStatus('success'), 0)
      return
    }

    // Save the callback URL for the mobile button
    setCallbackUrl(constructedUrl)

    if (mobile) {
      // On mobile: attempt auto-redirect but show button as fallback
      // iOS Safari may block automatic custom scheme redirects
      console.log('Welcome page - Mobile: attempting redirect + showing button')
      try {
        window.location.href = constructedUrl
      } catch {
        // Ignore - the button is the fallback
      }
      // Show success state with the "Open in Dial8" button after a brief delay
      setTimeout(() => setStatus('success'), 500)
    } else {
      // On desktop: auto-redirect works reliably
      console.log('Welcome page - Desktop: redirecting to:', constructedUrl)
      window.location.href = constructedUrl

      setTimeout(() => {
        setStatus('success')
        setTimeout(() => {
          window.close()
        }, 2000)
      }, 0)
    }
  }, [])

  const handleOpenApp = () => {
    if (callbackUrl) {
      window.location.href = callbackUrl
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-black">
      <Navbar />
      <Container className="flex flex-1 items-center justify-center pb-24">
        <div className="mx-auto max-w-2xl text-center">
          <div className="mb-8 flex justify-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-500/10 ring-8 ring-green-500/20">
              {status === 'processing' ? (
                <svg
                  className="h-10 w-10 animate-spin text-green-500"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              ) : status === 'error' ? (
                <svg
                  className="h-10 w-10 text-red-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={3}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              ) : (
                <svg
                  className="h-10 w-10 text-green-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={3}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              )}
            </div>
          </div>

          <Heading as="h1" className="text-white">
            {status === 'processing'
              ? 'Redirecting to Dial8...'
              : status === 'error'
                ? 'Redirect Failed'
                : 'Sign In Successful'}
          </Heading>

          <p className="mt-6 text-xl/8 text-gray-400">
            {status === 'processing'
              ? 'Please wait while we redirect you back to the Dial8 app...'
              : status === 'error'
                ? 'Unable to redirect to the app. Please try signing in again.'
                : isMobile && callbackUrl
                  ? 'Tap the button below to return to the Dial8 app.'
                  : "You've been successfully authenticated. You can now close this window and return to the Dial8 app."}
          </p>

          {/* Mobile: show prominent "Open in Dial8" button */}
          {isMobile && callbackUrl && status === 'success' && (
            <div className="mt-8">
              <button
                onClick={handleOpenApp}
                className="inline-flex items-center gap-2 rounded-xl bg-green-500 px-8 py-4 text-lg font-semibold text-black transition-colors hover:bg-green-400 active:bg-green-600"
              >
                <svg
                  className="h-6 w-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
                Open in Dial8
              </button>
            </div>
          )}

          <div className="mt-12 rounded-2xl border border-gray-800 bg-black p-6">
            <p className="text-sm text-gray-500">
              {isMobile
                ? "If the app doesn't open automatically, tap the button above."
                : 'This window will close automatically, or you can safely close it manually.'}
            </p>
          </div>
        </div>
      </Container>
    </main>
  )
}
