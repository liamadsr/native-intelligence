/**
 * Deepgram real-time streaming transcription service.
 *
 * Opens two persistent WebSocket connections to Deepgram (mic + system audio),
 * receives raw PCM from Tauri events, forwards it to Deepgram, and merges
 * the two transcript streams into a single chronological output.
 *
 * Audio format: 16kHz 16-bit mono PCM (linear16).
 */

import { correctFinalSegment } from '@/lib/vocabulary/client';
import { safeUnlisten, toSafeUnlisten } from "./tauri-unlisten";
import type { TranscriptionEngine } from "./tauri-bridge";

// ── Types ────────────────────────────────────────────────────────

export interface TranscriptWord {
  word: string;
  start: number; // seconds from Deepgram (relative to stream start)
  end: number;
  confidence: number;
  speaker?: number;
}

export interface TranscriptSegment {
  /** Unique id for React keys */
  id: string;
  /** The transcribed text */
  text: string;
  /** Which audio stream this came from */
  stream: "mic" | "system";
  /** Speaker label: "local_1", "remote_1", etc. */
  speaker: string;
  /** Absolute offset in seconds from session start */
  startTime: number;
  /** Absolute end time in seconds from session start */
  endTime: number;
  /** Whether this is a final (non-interim) result */
  isFinal: boolean;
  /** Word-level detail */
  words: TranscriptWord[];
}

export type OnSegmentCallback = (segment: TranscriptSegment) => void;

/**
 * Parse a persisted transcript (plain text, one `[speaker] text` line per
 * segment — see RecordingProvider.saveTranscript) back into TranscriptSegments
 * so the Live Agent transcript tab can display it after a recording has stopped.
 *
 * Lines without a `[speaker]` prefix are treated as continuations of the
 * previous segment (e.g. text that itself spanned multiple lines).
 */
export function parseTranscriptText(text: string | null | undefined): TranscriptSegment[] {
  if (!text) return [];

  const segments: TranscriptSegment[] = [];
  const lineRe = /^\s*\[([^\]]+)\]\s?(.*)$/;

  for (const line of text.split("\n")) {
    const match = line.match(lineRe);
    if (match) {
      segments.push({
        id: `persisted-${segments.length}`,
        text: match[2],
        stream: "mic",
        speaker: match[1],
        startTime: 0,
        endTime: 0,
        isFinal: true,
        words: [],
      });
    } else if (segments.length > 0 && line.trim()) {
      // Continuation of the previous segment's text
      segments[segments.length - 1].text += "\n" + line;
    } else if (line.trim()) {
      // No speaker prefix and no prior segment — keep the content anyway
      segments.push({
        id: `persisted-${segments.length}`,
        text: line.trim(),
        stream: "mic",
        speaker: "unknown",
        startTime: 0,
        endTime: 0,
        isFinal: true,
        words: [],
      });
    }
  }

  return segments;
}

/** VAD event types from Deepgram */
export type VadEvent = 'speech_started' | 'utterance_end';
export type OnVadCallback = (event: VadEvent, stream: 'mic' | 'system') => void;

/** Connection health status for a single Deepgram stream */
export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';
export type OnConnectionStatusCallback = (status: ConnectionStatus, stream: 'mic' | 'system') => void;

// ── Deepgram message parser ─────────────────────────────────────
// Shared by the Deepgram WebSocket (DeepgramConnection) and the desktop's
// on-device engine (LocalTranscriptionService in local-transcription.ts), which
// emits Deepgram-shaped JSON over `stt://message` precisely so this one parser
// serves both. Pure: no callbacks, no connection state.

/** The subset of a Deepgram live message the parser reads. */
interface DeepgramMessage {
  type?: unknown;
  start?: number;
  duration?: number;
  is_final?: unknown;
  channel?: {
    start?: number;
    duration?: number;
    alternatives?: Array<{
      transcript?: unknown;
      words?: Array<{
        word: string;
        start: number;
        end: number;
        confidence: number;
        speaker?: number;
      }>;
    }>;
  };
}

/** What one message turns into: a VAD event, a transcript segment, or nothing. */
export type ParsedDeepgramMessage =
  | { kind: 'vad'; event: VadEvent }
  | { kind: 'segment'; segment: TranscriptSegment }
  | null;

/**
 * Segment id minter for one stream: `${stream}-${n}-${Date.now()}-${rand}`,
 * with `n` counting only the segments actually produced (the format
 * DeepgramConnection has always used for React keys).
 */
export function createSegmentIdFactory(stream: "mic" | "system"): () => string {
  let counter = 0;
  return () => {
    counter++;
    return `${stream}-${counter}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  };
}

/**
 * Turn one Deepgram live message into a VAD event or a TranscriptSegment.
 *
 * `SpeechStarted` / `UtteranceEnd` → VAD. `Results` with a non-empty transcript
 * → a segment whose speaker is `${local|remote}_${speaker + 1}` from the first
 * word's diarization tag (0 when absent). Everything else (Metadata, empty
 * interims, non-objects) → null. `nextSegmentId` is called only when a segment
 * is produced.
 */
export function parseDeepgramMessage(
  data: unknown,
  stream: "mic" | "system",
  nextSegmentId: () => string,
): ParsedDeepgramMessage {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as DeepgramMessage;

  if (msg.type === "SpeechStarted") return { kind: 'vad', event: 'speech_started' };
  if (msg.type === "UtteranceEnd") return { kind: 'vad', event: 'utterance_end' };

  // Only process transcript results
  if (msg.type !== "Results") return null;

  const channel = msg.channel;
  if (!channel?.alternatives?.[0]) return null;

  const alt = channel.alternatives[0];
  const transcript = alt.transcript;
  if (typeof transcript !== "string" || transcript.trim() === "") return null;

  const words: TranscriptWord[] = (alt.words || []).map((w) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    confidence: w.confidence,
    speaker: w.speaker,
  }));

  // Determine speaker from diarization
  const speakerNum =
    words.length > 0 && words[0].speaker !== undefined
      ? words[0].speaker
      : 0;
  const speaker = `${stream === "mic" ? "local" : "remote"}_${speakerNum + 1}`;

  const startTime = msg.start ?? channel.start ?? 0;
  const endTime = startTime + (msg.duration ?? channel.duration ?? 0);

  return {
    kind: 'segment',
    segment: {
      id: nextSegmentId(),
      text: transcript,
      stream,
      speaker,
      startTime,
      endTime,
      isFinal: msg.is_final === true,
      words,
    },
  };
}

/**
 * Parse one message and fire the matching callbacks, in the order
 * DeepgramConnection always has: VAD → onVad; a segment → onSegment, then
 * onFinalSegment when it is final (Voice ID speaker matching).
 */
export function dispatchDeepgramMessage(
  data: unknown,
  stream: "mic" | "system",
  nextSegmentId: () => string,
  handlers: { onSegment: OnSegmentCallback; onFinalSegment?: OnSegmentCallback; onVad?: OnVadCallback },
): void {
  const parsed = parseDeepgramMessage(data, stream, nextSegmentId);
  if (!parsed) return;
  if (parsed.kind === 'vad') {
    handlers.onVad?.(parsed.event, stream);
    return;
  }
  // Custom vocabulary (docs/plans/custom-vocabulary.md §10): a finished
  // segment is corrected by sound before anything downstream (the live
  // transcript, the saved transcript, Voice ID, the live agent) sees it.
  // A pass-through until the vocabulary has loaded; interims stay as heard.
  const segment = parsed.segment.isFinal ? correctFinalSegment(parsed.segment, { surface: 'meeting' }) : parsed.segment;
  handlers.onSegment(segment);
  if (segment.isFinal && handlers.onFinalSegment) {
    handlers.onFinalSegment(segment);
  }
}

// ── Deepgram WebSocket URL builder ──────────────────────────────

function buildDeepgramWsUrl(): string {
  const params = new URLSearchParams({
    model: "nova-3",
    language: "en",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    smart_format: "true",
    diarize: "true",
    interim_results: "true",
    utterance_end_ms: "2000",
    vad_events: "true",
    endpointing: "300",
    punctuate: "true",
  });

  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

// ── Single stream connection ────────────────────────────────────

// Exported for unit testing (zombie-socket detection). Not part of the public
// API — consumers use DeepgramStreamingService.
export class DeepgramConnection {
  private ws: WebSocket | null = null;
  /** Fallback main-thread keep-alive timer (used only if the worker fails). */
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  /** Throttle-proof keep-alive driver — a worker whose timers aren't clamped
   *  when the page is hidden/occluded. Preferred over keepAliveInterval. */
  private keepAliveWorker: Worker | null = null;
  private stream: "mic" | "system";
  private onSegment: OnSegmentCallback;
  private onFinalSegment?: OnSegmentCallback;
  private onVad?: OnVadCallback;
  private onConnectionStatus?: OnConnectionStatusCallback;
  /** Optional async callback to fetch a fresh API key before reconnecting */
  private refreshApiKey?: () => Promise<string>;
  /** Mints this stream's segment ids (counter survives reconnects). */
  private nextSegmentId: () => string;

  // Reconnect state
  private apiKey: string = "";
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** The reconnect attempt between its timer firing and its socket being
   *  opened (the key refresh awaits the network). One at a time: a second
   *  timer (online / wake) firing meanwhile must not open a second socket. */
  private reconnectInFlight: Promise<void> | null = null;
  private gaveUp = false; // true once MAX_RECONNECT_ATTEMPTS exhausted
  /** True once the FIRST connect attempt has resolved or rejected. While false,
   *  connectInternal's resolve/reject settle the initial connect() promise;
   *  after it, a failed attempt is a reconnect (fire-and-forget) and feeds the
   *  bounded scheduleReconnect path instead of surfacing to the caller. */
  private initialConnectSettled = false;
  private onlineHandler: (() => void) | null = null;
  private wakeHandler: (() => void) | null = null;
  private static MAX_RECONNECT_ATTEMPTS = 10;
  private static RECONNECT_BASE_MS = 500; // 500ms, 1s, 2s, 4s...

  // ── Liveness / zombie-socket detection ──────────────────────────
  // After a long app-background or system sleep, the WKWebView's JS is
  // suspended: timers freeze and the WebSocket stalls. On wake the socket can
  // come back as a *zombie* — readyState still reads OPEN, so sendAudio() keeps
  // shoveling PCM into a dead pipe and `onclose` never fires, so the normal
  // reconnect path never triggers. Audio keeps "recording" (Rust capture is on
  // a separate native thread) while transcription is silently dead forever.
  //
  // We defend against this with liveness tracking: record when we last sent
  // audio and when we last heard ANYTHING back from Deepgram. A watchdog (and a
  // wake-triggered checkHealth()) force-reconnects a socket that has been fed
  // audio but has gone quiet for too long.
  private lastMessageAt = 0; // last time Deepgram sent us any frame
  private lastAudioSentAt = 0; // last time we forwarded PCM to this socket
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;
  /** How long a fed-but-silent socket may stay quiet before we treat it as dead. */
  private static STALE_THRESHOLD_MS = 12_000;
  /** Watchdog tick cadence. */
  private static WATCHDOG_INTERVAL_MS = 5_000;
  /** Keep-alive cadence. Must stay well under Deepgram's ~10-12s idle timeout. */
  private static KEEPALIVE_INTERVAL_MS = 5_000;

  constructor(
    stream: "mic" | "system",
    onSegment: OnSegmentCallback,
    onFinalSegment?: OnSegmentCallback,
    onVad?: OnVadCallback,
    onConnectionStatus?: OnConnectionStatusCallback,
  ) {
    this.stream = stream;
    this.nextSegmentId = createSegmentIdFactory(stream);
    this.onSegment = onSegment;
    this.onFinalSegment = onFinalSegment;
    this.onVad = onVad;
    this.onConnectionStatus = onConnectionStatus;
  }

  connect(apiKey: string, refreshApiKey?: () => Promise<string>): Promise<void> {
    this.apiKey = apiKey;
    this.refreshApiKey = refreshApiKey;
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    this.gaveUp = false;
    this.initialConnectSettled = false;

    // Listen for network recovery (e.g. after sleep) — reset attempts and retry
    if (typeof window !== "undefined" && !this.onlineHandler) {
      this.onlineHandler = () => {
        if (this.intentionallyClosed) return;
        if (!this.gaveUp && this.reconnectAttempts === 0) return; // already connected

        console.log(`[Deepgram/${this.stream}] Network back online — resetting reconnect`);
        this.reconnectAttempts = 0;
        this.gaveUp = false;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.scheduleReconnect();
      };
      window.addEventListener("online", this.onlineHandler);
    }

    // Listen for app-wake (return from background / system sleep). The socket
    // may have survived as a zombie (OPEN but dead) with no close frame, so the
    // online handler above never fires. Proactively health-check the moment the
    // user returns instead of waiting for the watchdog tick. We also re-seed
    // lastMessageAt-relative timing implicitly via checkHealth's audio gate.
    if (typeof document !== "undefined" && !this.wakeHandler) {
      this.wakeHandler = () => {
        if (this.intentionallyClosed) return;
        if (document.visibilityState !== "visible") return;
        this.checkHealth();
      };
      document.addEventListener("visibilitychange", this.wakeHandler);
      window.addEventListener("focus", this.wakeHandler);
    }

    return this.connectInternal();
  }

  private connectInternal(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Snapshot whether THIS attempt is the caller-facing initial connect. Only
      // the first attempt settles connect()'s promise; later attempts (scheduled
      // reconnects, incl. those triggered by an initial failure) are
      // fire-and-forget and must never call resolve/reject a second time.
      const isInitialAttempt = !this.initialConnectSettled;
      let settled = false;
      const ws = new WebSocket(buildDeepgramWsUrl(), ["token", this.apiKey]);
      this.ws = ws;
      ws.binaryType = "arraybuffer";

      const timeout = setTimeout(() => {
        // Connect timed out. CRITICAL: tear down this in-flight socket so it
        // can't OPEN ~seconds later and start keep-alives / fire the status
        // callback on a connection the caller already gave up on (the leak that
        // caused the 386s zero-transcript incident). cleanupSocket() nulls the
        // handlers and closes the still-CONNECTING socket.
        if (this.ws === ws) this.cleanupSocket();
        else { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
        // Re-enter the reconnect machinery for BOTH initial AND scheduled-
        // reconnect timeouts. cleanupSocket() just nulled onclose, so without
        // this the reconnect chain would die after one timed-out reconnect.
        this.onConnectAttemptFailed(isInitialAttempt);
        if (isInitialAttempt && !settled) {
          settled = true;
          reject(new Error(`Deepgram ${this.stream} WebSocket connection timeout`));
        }
      }, 10000);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.initialConnectSettled = true;
        if (this.reconnectAttempts > 0) {
          console.log(`[Deepgram/${this.stream}] WebSocket reconnected (attempt ${this.reconnectAttempts})`);
        } else {
          console.log(`[Deepgram/${this.stream}] WebSocket connected`);
        }
        this.reconnectAttempts = 0;
        // A fresh connection is alive — seed liveness so the watchdog doesn't
        // immediately flag a stream that simply hasn't been spoken into yet.
        this.lastMessageAt = Date.now();
        this.onConnectionStatus?.('connected', this.stream);

        // Keep the stream warm so Deepgram doesn't close it as idle. Driven by a
        // worker (throttle-proof) so it keeps firing even when the page is
        // occluded/hidden — which is exactly when the main-thread timer would be
        // clamped and the stream would otherwise die.
        this.startKeepAlive();

        // Watchdog: catch zombie sockets that survive a suspend/wake as OPEN
        // but no longer carry data. Runs independently of keep-alive.
        this.startWatchdog();

        if (isInitialAttempt && !settled) {
          settled = true;
          resolve();
        }
      };

      ws.onmessage = (event) => {
        // Any frame from Deepgram proves the socket is alive (Results, Metadata,
        // VAD, etc.) — refresh liveness before parsing.
        this.lastMessageAt = Date.now();
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch {
          // Ignore non-JSON messages
        }
      };

      ws.onerror = (event) => {
        console.error(`[Deepgram/${this.stream}] WebSocket error:`, event);
        clearTimeout(timeout);
        // An error before open (initial attempt) both surfaces to the caller AND
        // feeds the reconnect path so the initial connect is retryable — a
        // transient error is no longer a permanent one-shot failure. If onclose
        // follows (it usually does) its scheduleReconnect is a no-op re-entry
        // (reconnectTimer already armed). Clean the socket so a late open can't
        // fire callbacks.
        if (isInitialAttempt) {
          if (this.ws === ws) this.cleanupSocket();
          this.onConnectAttemptFailed(isInitialAttempt);
          if (!settled) {
            settled = true;
            reject(new Error(`Deepgram ${this.stream} WebSocket error`));
          }
        }
        // A NON-initial pre-open error leaves this attempt's handlers wired (we
        // do NOT cleanupSocket here), so the browser's onclose fires next and its
        // scheduleReconnect keeps the chain alive — verified by the "reconnect
        // chain survives repeated timeouts / errors" test. Post-open errors are
        // likewise handled by onclose → scheduleReconnect.
      };

      ws.onclose = (event) => {
        console.log(
          `[Deepgram/${this.stream}] WebSocket closed: code=${event.code} reason=${event.reason}`,
        );
        // A superseded socket closing must not tear down the live one or
        // schedule a reconnect on its behalf.
        if (this.ws !== ws) return;
        this.cleanupSocket();

        // Auto-reconnect if not intentionally closed
        if (!this.intentionallyClosed) {
          this.scheduleReconnect();
        }
      };
    });
  }

  /**
   * Feed a failed connect ATTEMPT (timeout or pre-open error) back into the
   * bounded reconnect machinery, for BOTH the initial connect and scheduled
   * reconnects. This is the linchpin of retryability: the timeout handler
   * cleanupSocket()s the dead socket, which nulls its onclose — so the natural
   * onclose→scheduleReconnect chain would be severed and the reconnect loop would
   * die after a SINGLE timed-out reconnect (well short of MAX_RECONNECT_ATTEMPTS,
   * status stuck at 'reconnecting' forever). We therefore re-arm scheduleReconnect
   * here directly, respecting intentionallyClosed / gaveUp (the give-up branch
   * lives inside scheduleReconnect via MAX_RECONNECT_ATTEMPTS) and the
   * already-armed guard so we never stack two pending reconnects.
   *
   * Only the initialConnectSettled marking is initial-specific — once set, later
   * attempts are fire-and-forget (they never resolve/reject connect()'s promise).
   */
  private onConnectAttemptFailed(isInitialAttempt: boolean) {
    if (isInitialAttempt) this.initialConnectSettled = true;
    if (this.intentionallyClosed) return;
    if (this.gaveUp) return; // already exhausted MAX_RECONNECT_ATTEMPTS
    if (this.reconnectTimer) return; // a reconnect is already scheduled
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= DeepgramConnection.MAX_RECONNECT_ATTEMPTS) {
      console.error(`[Deepgram/${this.stream}] Max reconnect attempts (${DeepgramConnection.MAX_RECONNECT_ATTEMPTS}) reached — giving up (will retry on network recovery)`);
      this.gaveUp = true;
      this.onConnectionStatus?.('disconnected', this.stream);
      return;
    }

    this.reconnectAttempts++;
    if (this.reconnectAttempts === 1) {
      this.onConnectionStatus?.('reconnecting', this.stream);
    }
    const delayMs = Math.min(
      DeepgramConnection.RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      30000, // cap at 30s
    );

    console.log(`[Deepgram/${this.stream}] Reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempts}/${DeepgramConnection.MAX_RECONNECT_ATTEMPTS})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // An attempt already refreshing its key will open the socket; this one
      // stands down (if that attempt fails, its failure schedules the next).
      if (this.reconnectInFlight) return;
      const attempt = this.runReconnectAttempt();
      this.reconnectInFlight = attempt;
      void attempt.finally(() => {
        if (this.reconnectInFlight === attempt) this.reconnectInFlight = null;
      });
    }, delayMs);
  }

  private async runReconnectAttempt(): Promise<void> {
    // Refresh the API key before reconnecting — tokens expire during downtime
    if (this.refreshApiKey) {
      try {
        this.apiKey = await this.refreshApiKey();
        console.log(`[Deepgram/${this.stream}] Refreshed API key for reconnect`);
      } catch (err) {
        console.warn(`[Deepgram/${this.stream}] Failed to refresh API key, using existing:`, err);
      }
      // The refresh awaited the network: close() may have run meanwhile, or
      // another reconnect (online / wake) may have been armed. Either way this
      // attempt no longer owns the connection — opening a socket now would
      // leak it.
      if (this.intentionallyClosed || this.reconnectTimer) return;
    }
    this.connectInternal().catch((err) => {
      console.error(`[Deepgram/${this.stream}] Reconnect failed:`, err);
      // onclose will fire and trigger another scheduleReconnect
    });
  }

  /** Send a single KeepAlive frame if the socket is open. */
  private sendKeepAlive() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "KeepAlive" }));
    }
  }

  /**
   * Start the keep-alive heartbeat. Prefers a Web Worker whose timers are
   * immune to the page-visibility/occlusion throttling that clamps main-thread
   * timers (and was killing the stream when another window covered the app).
   * Falls back to a plain setInterval when a worker can't be created (SSR,
   * tests, or a worker-load failure) — better a throttle-prone heartbeat than
   * none.
   */
  private startKeepAlive() {
    this.stopKeepAlive();

    // Try the worker first.
    try {
      if (typeof Worker !== "undefined") {
        const worker = new Worker(
          new URL("../workers/heartbeat-worker.ts", import.meta.url),
          { type: "module" },
        );
        worker.onmessage = (e: MessageEvent<{ type: string }>) => {
          if (e.data?.type === "tick") this.sendKeepAlive();
        };
        worker.onerror = () => {
          // Worker died — fall back to a main-thread timer so we still keep-alive.
          console.warn(`[Deepgram/${this.stream}] Keep-alive worker errored — falling back to setInterval`);
          this.stopKeepAlive();
          this.startKeepAliveFallback();
        };
        worker.postMessage({ type: "start", intervalMs: DeepgramConnection.KEEPALIVE_INTERVAL_MS });
        this.keepAliveWorker = worker;
        return;
      }
    } catch {
      // Bundler/worker construction failed — use the fallback below.
    }

    this.startKeepAliveFallback();
  }

  /** Main-thread keep-alive (throttle-prone) used when the worker is unavailable. */
  private startKeepAliveFallback() {
    this.keepAliveInterval = setInterval(() => {
      this.sendKeepAlive();
    }, DeepgramConnection.KEEPALIVE_INTERVAL_MS);
  }

  /** Tear down whichever keep-alive driver is active. */
  private stopKeepAlive() {
    if (this.keepAliveWorker) {
      try {
        this.keepAliveWorker.postMessage({ type: "stop" });
        this.keepAliveWorker.terminate();
      } catch { /* ignore */ }
      this.keepAliveWorker = null;
    }
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  /** Start the zombie-socket watchdog (cleared by cleanupSocket). */
  private startWatchdog() {
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    this.watchdogInterval = setInterval(() => {
      this.checkHealth();
    }, DeepgramConnection.WATCHDOG_INTERVAL_MS);
  }

  /**
   * Check whether the socket is a zombie and force a reconnect if so.
   *
   * Called periodically by the watchdog AND on-demand when the app wakes from
   * a background/suspend (visibilitychange / focus / online). The wake path is
   * what actually saves the user: it repairs the stream the instant they return
   * instead of waiting up to STALE_THRESHOLD for the watchdog.
   *
   * "Zombie" = the socket reads OPEN, we ARE still feeding it audio, yet
   * Deepgram has sent us nothing for STALE_THRESHOLD_MS. A genuinely-idle but
   * healthy stream (no one is speaking) is NOT flagged, because we only judge
   * staleness relative to the last time we actually forwarded PCM.
   *
   * Returns true if it triggered a reconnect.
   */
  checkHealth(): boolean {
    if (this.intentionallyClosed) return false;
    // Nothing to repair unless the socket claims to be open.
    if (this.ws?.readyState !== WebSocket.OPEN) return false;

    const now = Date.now();
    // Only meaningful once we've actually started forwarding audio. If we
    // haven't sent PCM recently, silence from Deepgram is expected, not a fault.
    if (this.lastAudioSentAt === 0) return false;
    const sinceAudio = now - this.lastAudioSentAt;
    if (sinceAudio > DeepgramConnection.STALE_THRESHOLD_MS) return false;

    const sinceMessage = now - this.lastMessageAt;
    if (sinceMessage > DeepgramConnection.STALE_THRESHOLD_MS) {
      console.warn(
        `[Deepgram/${this.stream}] Zombie socket detected — fed audio ${sinceAudio}ms ago but silent for ${sinceMessage}ms. Forcing reconnect.`,
      );
      this.forceReconnect();
      return true;
    }
    return false;
  }

  /**
   * Tear down a (possibly half-open) socket and reconnect from scratch. Unlike
   * relying on onclose, this works even when the OS never delivers a close
   * frame after a suspend. Resets backoff so recovery is immediate.
   */
  private forceReconnect() {
    if (this.intentionallyClosed) return;
    this.onConnectionStatus?.('reconnecting', this.stream);
    // Drop the dead socket without marking intentionallyClosed (we WANT a
    // reconnect). cleanupSocket nulls the handlers so its onclose won't also
    // fire scheduleReconnect and race us.
    this.cleanupSocket();
    this.reconnectAttempts = 0;
    this.gaveUp = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.scheduleReconnect();
  }

  /** Send raw PCM audio bytes to Deepgram */
  sendAudio(pcmBytes: ArrayBuffer | Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcmBytes);
      this.lastAudioSentAt = Date.now();
    }
  }

  /**
   * Timestamp (ms since epoch) of the last PCM frame this connection forwarded,
   * or 0 if none ever. `lastAudioSentAt` is set only when sendAudio() actually
   * pushes bytes into an OPEN socket, so it truly means native/browser audio
   * for this stream reached us. The mic-recovery coordinator in use-recording.ts
   * compares this against its last recover_mic time to tell whether a rebuild
   * brought the device back (audio newer than the recovery → episode over).
   */
  getLastAudioAt(): number {
    return this.lastAudioSentAt;
  }

  /**
   * Has this connection ever forwarded PCM? Convenience over getLastAudioAt()
   * for the mic first-frame watchdog, which only cares whether a stream that
   * opened is being starved of frames (see use-recording.ts).
   */
  hasReceivedAudio(): boolean {
    return this.lastAudioSentAt > 0;
  }

  /** Gracefully close the connection — no reconnect */
  close() {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.onlineHandler) {
      window.removeEventListener("online", this.onlineHandler);
      this.onlineHandler = null;
    }
    if (this.wakeHandler) {
      document.removeEventListener("visibilitychange", this.wakeHandler);
      window.removeEventListener("focus", this.wakeHandler);
      this.wakeHandler = null;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
    }
    this.cleanupSocket();
  }

  /** Clean up the WebSocket and keep-alive without affecting reconnect state */
  private cleanupSocket() {
    this.stopKeepAlive();
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  private handleMessage(data: unknown) {
    // VAD events, then segments (+ Voice ID's final-segment hook) — see
    // parseDeepgramMessage / dispatchDeepgramMessage above.
    dispatchDeepgramMessage(data, this.stream, this.nextSegmentId, {
      onSegment: this.onSegment,
      onFinalSegment: this.onFinalSegment,
      onVad: this.onVad,
    });
  }
}

// ── Main service: manages both connections ──────────────────────

/** Aggregate transcription status: worst-of both streams */
export type TranscriptionStatus = 'connected' | 'reconnecting' | 'disconnected';

/**
 * The engine-agnostic surface the recording pipeline drives once a
 * transcription service is running: DeepgramStreamingService (cloud, below) or
 * LocalTranscriptionService (the desktop's on-device engine, see
 * local-transcription.ts). Both take the same `(onSegment, onFinalSegment?,
 * onVad?)` constructor callbacks and emit identical TranscriptSegments.
 *
 * Starting is deliberately NOT part of it — it is engine-specific: Deepgram
 * needs a minted token (`start(apiKey, source)`), while the local engine must
 * subscribe to `stt://` events BEFORE `start_recording` (`attach()`), then be
 * confirmed by its answer (`start()`). Deepgram-only knobs (refreshApiKey,
 * getUsageAuthHeader, sendMicAudio for the browser) stay on its class.
 */
export interface TranscriptionService {
  readonly engine: TranscriptionEngine;
  /** Raw PCM per stream as it arrives (Voice ID ring buffers). */
  onAudioData?: (stream: "mic" | "system", bytes: Uint8Array) => void;
  /** Aggregate transcription health. */
  onTranscriptionStatus?: (status: TranscriptionStatus) => void;
  /** ms timestamp of the last PCM frame seen for `stream`, 0 if none. */
  getLastAudioAt(stream: "mic" | "system"): number;
  /** Has `stream` seen any PCM yet? (mic first-frame watchdog) */
  hasReceivedAudio(stream: "mic" | "system"): boolean;
  /** Tear down. Deepgram stops synchronously; the local engine returns a
   *  promise that settles once the transcript tail has drained. */
  stop(): void | Promise<void>;
}

export class DeepgramStreamingService implements TranscriptionService {
  readonly engine = 'deepgram' as const;
  private micConnection: DeepgramConnection | null = null;
  private systemConnection: DeepgramConnection | null = null;
  private unlistenMic: (() => void) | null = null;
  private unlistenSystem: (() => void) | null = null;
  /** Bumped by stop(). start() captures it before its awaits, so audio
   *  listeners that resolve after a stop are unlistened at once and their
   *  handlers stay silent instead of feeding a stopped service. */
  private stopGeneration = 0;
  private onSegment: OnSegmentCallback;
  private onFinalSegment?: OnSegmentCallback;
  private onVad?: OnVadCallback;
  /** Optional callback to receive raw PCM bytes (for Voice ID ring buffers) */
  onAudioData?: (stream: "mic" | "system", bytes: Uint8Array) => void;
  /** Optional callback for aggregate transcription connection health */
  onTranscriptionStatus?: (status: TranscriptionStatus) => void;
  /**
   * Optional callback that returns an Authorization header value (e.g.
   * "Bearer <jwt>") for usage logging. When provided, stop() will POST
   * the session duration to /api/ai/log-transcription so Deepgram usage
   * shows up in the admin AI usage dashboard.
   */
  getUsageAuthHeader?: () => Promise<string | null>;
  /** Timestamp (ms) captured when both streams connected in start() */
  private sessionStartMs: number | null = null;

  // Track per-stream status to compute aggregate
  private streamStatus: { mic: ConnectionStatus; system: ConnectionStatus } = {
    mic: 'connected',
    system: 'connected',
  };

  constructor(onSegment: OnSegmentCallback, onFinalSegment?: OnSegmentCallback, onVad?: OnVadCallback) {
    this.onSegment = onSegment;
    this.onFinalSegment = onFinalSegment;
    this.onVad = onVad;
  }

  private handleConnectionStatus = (status: ConnectionStatus, stream: 'mic' | 'system') => {
    this.streamStatus[stream] = status;
    // Aggregate: worst-of-both — disconnected > reconnecting > connected
    let aggregate: TranscriptionStatus = 'connected';
    const statuses = Object.values(this.streamStatus);
    if (statuses.includes('disconnected')) aggregate = 'disconnected';
    else if (statuses.includes('reconnecting')) aggregate = 'reconnecting';
    this.onTranscriptionStatus?.(aggregate);
  };

  /**
   * Start streaming. Opens WebSocket connection(s) to Deepgram.
   *
   * - `source: 'tauri'` (default): opens BOTH mic + system connections and wires
   *   them to the desktop app's Tauri audio events (`audio://mic` / `audio://system`).
   * - `source: 'web'`: opens ONLY the mic connection. The browser has no
   *   system-audio tap, so there's no system stream; the caller pushes mic PCM
   *   in via `sendMicAudio()` (fed by WebAudioCapture). Only `local_*` speakers
   *   appear, which is correct for a mic-only recording.
   *
   * The API key is passed directly via the WebSocket URL's token param. On
   * desktop this never leaves the machine; on web it's a short-lived (60s)
   * disposable key minted by /api/deepgram-token.
   */
  /** Optional callback to fetch a fresh Deepgram token (used on reconnect after token expiry) */
  refreshApiKey?: () => Promise<string>;

  async start(apiKey: string, source: "tauri" | "web" = "tauri"): Promise<void> {
    const refresher = this.refreshApiKey;
    const generation = this.stopGeneration;

    // Web is mic-only: open just the mic connection and skip the Tauri wiring.
    if (source === "web") {
      this.streamStatus = { mic: 'connected', system: 'connected' };
      const micConnection = new DeepgramConnection("mic", this.onSegment, this.onFinalSegment, this.onVad, this.handleConnectionStatus);
      this.micConnection = micConnection;
      try {
        await micConnection.connect(apiKey, refresher);
      } catch (err) {
        // The only leg failed. Close it so no in-flight/late-opening socket leaks
        // (connect() armed a reconnect on failure — close() stops it), then
        // rethrow so the caller retries the whole setup with a fresh token.
        micConnection.close();
        this.micConnection = null;
        throw err;
      }
      this.sessionStartMs = Date.now();
      console.log("[DeepgramStreamingService] Started — web mic-only stream connected");
      return;
    }

    // Desktop: open both connections and wire Tauri audio events.
    //
    // DEGRADED-DUAL start (allSettled, not all): connect the two legs
    // INDEPENDENTLY. If at least ONE leg connects, the session starts — we wire
    // audio for BOTH legs and hand any failed leg to its own reconnect machinery
    // (connect() rejected, but connectInternal already armed scheduleReconnect
    // via onInitialAttemptFailed, so it keeps retrying with backoff + a refreshed
    // token). Only if BOTH legs fail do we tear everything down and throw — the
    // caller (use-recording) then re-fetches the token and retries the whole
    // setup. Previously this awaited Promise.all, so ONE slow/failed leg rejected
    // the whole start(), left the other socket to leak, and killed transcription
    // for the entire meeting (the 386s zero-transcript incident).
    this.streamStatus = { mic: 'connected', system: 'connected' };
    const micConnection = new DeepgramConnection("mic", this.onSegment, this.onFinalSegment, this.onVad, this.handleConnectionStatus);
    const systemConnection = new DeepgramConnection("system", this.onSegment, this.onFinalSegment, this.onVad, this.handleConnectionStatus);
    this.micConnection = micConnection;
    this.systemConnection = systemConnection;

    const [micResult, systemResult] = await Promise.allSettled([
      micConnection.connect(apiKey, refresher),
      systemConnection.connect(apiKey, refresher),
    ]);

    const micOk = micResult.status === "fulfilled";
    const systemOk = systemResult.status === "fulfilled";

    if (!micOk && !systemOk) {
      // Both legs failed. Close each so no in-flight/late-opening socket leaks
      // (connectInternal armed a reconnect for each — close() stops it), then
      // throw so the caller retries the entire setup with a fresh token.
      micConnection.close();
      systemConnection.close();
      this.micConnection = null;
      this.systemConnection = null;
      throw new Error("Deepgram start failed — both mic and system streams failed to connect");
    }

    if (!micOk || !systemOk) {
      console.warn(
        `[DeepgramStreamingService] Started DEGRADED — ${micOk ? "system" : "mic"} leg failed to connect; ` +
          "it will keep retrying in the background while the other leg streams.",
      );
    }

    // Mark the session start now that at least one socket is connected, so
    // we charge only for live-stream seconds, not connection setup.
    this.sessionStartMs = Date.now();

    // Subscribe to Tauri audio events and forward PCM to Deepgram. We wire BOTH
    // legs regardless of which connected: a leg still reconnecting has an OPEN-
    // guarded sendAudio (no-op until it opens), and once its background reconnect
    // succeeds, audio flows without re-wiring.
    const { listen } = await import("@tauri-apps/api/event");

    // A stop() that lands while a listen is pending leaves nothing to tear the
    // late listener down, so it is unlistened here instead of being assigned.
    const stopped = () => generation !== this.stopGeneration;

    const unlistenMic = await listen<number[]>("audio://mic", (event) => {
      if (stopped()) return;
      if (event.payload) {
        const bytes = new Uint8Array(event.payload);
        this.micConnection?.sendAudio(bytes);
        this.onAudioData?.("mic", bytes);
      }
    });
    // Never throws, and survives an unlisten that lands before the webview's
    // listener entry does (see tauri-unlisten.ts).
    if (stopped()) {
      safeUnlisten(unlistenMic);
      return;
    }
    this.unlistenMic = toSafeUnlisten(unlistenMic);

    const unlistenSystem = await listen<number[]>("audio://system", (event) => {
      if (stopped()) return;
      if (event.payload) {
        const bytes = new Uint8Array(event.payload);
        this.systemConnection?.sendAudio(bytes);
        this.onAudioData?.("system", bytes);
      }
    });
    if (stopped()) {
      safeUnlisten(unlistenSystem);
      return;
    }
    this.unlistenSystem = toSafeUnlisten(unlistenSystem);

    console.log(
      micOk && systemOk
        ? "[DeepgramStreamingService] Started — both streams connected"
        : "[DeepgramStreamingService] Started — one stream connected, the other reconnecting",
    );
  }

  /**
   * Push a chunk of mic PCM (16 kHz mono linear16) into the mic connection.
   * Used by the web capture path (WebAudioCapture.onPcm) in place of the
   * desktop's Tauri `audio://mic` event. No-op until start('web') has connected.
   */
  sendMicAudio(bytes: Uint8Array): void {
    this.micConnection?.sendAudio(bytes);
    this.onAudioData?.("mic", bytes);
  }

  /**
   * Timestamp (ms) of the last PCM frame the given stream forwarded, 0 if never
   * (or if the connection doesn't exist — e.g. no system stream on web). Dumb
   * passthrough to the underlying connection's frame tracking — no timers here.
   * The mic-recovery coordinator in use-recording.ts uses this to reset its
   * per-episode recovery budget when audio arrives after a rebuild.
   */
  getLastAudioAt(stream: "mic" | "system"): number {
    const conn = stream === "mic" ? this.micConnection : this.systemConnection;
    return conn?.getLastAudioAt() ?? 0;
  }

  /**
   * Has the given stream's connection forwarded ANY audio yet? The mic
   * first-frame watchdog in use-recording.ts polls this after start() to catch
   * a stream that connected but never received a single PCM frame (the
   * CoreAudio device-release race on resume-after-quit). Returns false when the
   * connection doesn't exist (e.g. no system stream on web).
   */
  hasReceivedAudio(stream: "mic" | "system"): boolean {
    return this.getLastAudioAt(stream) > 0;
  }

  /** Stop streaming and clean up all resources */
  stop() {
    // Unlisten from Tauri events (and any a pending start() is still awaiting)
    this.stopGeneration++;
    this.unlistenMic?.();
    this.unlistenMic = null;
    this.unlistenSystem?.();
    this.unlistenSystem = null;

    // Close Deepgram connections
    this.micConnection?.close();
    this.micConnection = null;
    this.systemConnection?.close();
    this.systemConnection = null;

    // Fire-and-forget usage log. We intentionally do not await — cleanup
    // should be synchronous from the caller's POV.
    const startedAt = this.sessionStartMs;
    this.sessionStartMs = null;
    if (startedAt !== null && this.getUsageAuthHeader) {
      const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      if (durationSeconds > 0) {
        void this.logUsage(durationSeconds);
      }
    }

    console.log("[DeepgramStreamingService] Stopped");
  }

  private async logUsage(durationSeconds: number) {
    try {
      const authHeader = await this.getUsageAuthHeader?.();
      if (!authHeader) return;
      await fetch('/api/ai/log-transcription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({
          provider: 'deepgram',
          model: 'nova-3',
          feature: 'live_transcription',
          durationSeconds,
        }),
      });
    } catch (err) {
      console.warn('[DeepgramStreamingService] usage log failed:', err);
    }
  }
}

// ── Transcript merger utility ───────────────────────────────────

/**
 * Merges transcript segments from both streams into a single
 * chronological list. Replaces interim segments with final ones
 * from the same stream and time window.
 */
export class TranscriptMerger {
  private segments: TranscriptSegment[] = [];

  /** Add or update a segment from either stream */
  addSegment(segment: TranscriptSegment): TranscriptSegment[] {
    if (segment.isFinal) {
      // Remove any interim segments from same stream in overlapping time range
      this.segments = this.segments.filter(
        (s) =>
          s.stream !== segment.stream ||
          s.isFinal ||
          Math.abs(s.startTime - segment.startTime) > 0.5,
      );
      this.segments.push(segment);
    } else {
      // For interim: replace previous interim from same stream
      const existingIdx = this.segments.findIndex(
        (s) =>
          s.stream === segment.stream &&
          !s.isFinal,
      );
      if (existingIdx >= 0) {
        this.segments[existingIdx] = segment;
      } else {
        this.segments.push(segment);
      }
    }

    // Sort by start time
    this.segments.sort((a, b) => a.startTime - b.startTime);
    return [...this.segments];
  }

  /** Get the current merged transcript */
  getTranscript(): TranscriptSegment[] {
    return [...this.segments];
  }

  /** Get only final segments (for display) */
  getFinalTranscript(): TranscriptSegment[] {
    return this.segments.filter((s) => s.isFinal);
  }

  /** Clear all segments */
  clear() {
    this.segments = [];
  }
}
