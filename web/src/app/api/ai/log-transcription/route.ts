import { authenticateUser, logUsage } from '@/lib/ai/auth'
import { trackServerEvent } from '@/lib/posthog'
import { NextResponse } from 'next/server'

/**
 * POST /api/ai/log-transcription
 *
 * Records a completed transcription session in ai_usage_logs. Used for
 * duration-priced STT providers (Deepgram, Whisper) where audio never
 * touches our server — the client (desktop or web) streams PCM directly
 * to the provider and then reports elapsed seconds back to us after
 * stop().
 *
 * Body: { durationSeconds: number, provider: 'deepgram' | 'groq', model: string, feature?: string }
 *
 * Cost is computed server-side from ai_model_costs.cost_per_audio_minute
 * via the log_ai_usage RPC — clients never send cost themselves.
 */
export async function POST(req: Request) {
  try {
    const { user } = await authenticateUser(req)

    const body = await req.json()
    const {
      durationSeconds,
      provider,
      model,
      feature = 'live_transcription',
    } = body as {
      durationSeconds?: number
      provider?: string
      model?: string
      feature?: string
    }

    if (!provider || !model) {
      return NextResponse.json(
        { error: 'provider and model are required' },
        { status: 400 },
      )
    }

    const seconds = Math.max(0, Math.round(Number(durationSeconds) || 0))
    if (seconds === 0) {
      // Nothing to charge — bail out without creating a row.
      return NextResponse.json({ ok: true, skipped: true, reason: 'zero_duration' })
    }

    await logUsage(user.id, {
      provider,
      model,
      feature,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: seconds * 1000,
      audioSeconds: seconds,
    })

    // Web product transcription completion — distinct from the legacy macOS
    // `transcription_completed` (posthog-ios). Carries `platform: web` via the
    // helper so the dashboard separates the two app generations.
    trackServerEvent('transcription_completed', { userId: user.id, email: user.email }, {
      audio_seconds: seconds,
      provider,
      model,
      feature,
    })

    return NextResponse.json({ ok: true, audio_seconds: seconds })
  } catch (error) {
    if (error instanceof Response) return error
    console.error('[log-transcription] error:', error)
    return NextResponse.json(
      { error: 'Failed to log transcription' },
      { status: 500 },
    )
  }
}
