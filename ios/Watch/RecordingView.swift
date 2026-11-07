import SwiftUI

/// The watch's only screen.
///
/// The recording state is deliberately sparse: a charcoal card filling the bezel,
/// one very large serif count-up dead centre, the meeting name under it, and two
/// controls in the bottom corners. Nothing sits at the top — that band belongs to
/// watchOS, which draws the time and its own recording-mic glyph there, and
/// anything we put under it would be obscured or would fight it.
struct RecordingView: View {
    @EnvironmentObject private var recorder: WatchRecorder

    /// The card inset from the bezel. Small enough that the screen still reads as
    /// full-bleed on the rounded display, big enough to show the black edge.
    private let cardInset: CGFloat = 6

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch recorder.state {
            case .idle:
                idle
            case .recording, .paused:
                capture
            case .stopped(let sent):
                stopped(sent: sent)
            }
        }
    }

    // MARK: - Idle

    /// ⚠️ THE `NavigationStack` WRAPS THE IDLE STATE ONLY, NOT THE ROOT.
    ///
    /// `WorkspaceSelector` uses a `.navigationLink` Picker, which needs a
    /// navigation container — but putting one at the root would change the safe
    /// area and the title band of the RECORDING and PAUSED layouts, which must
    /// stay pixel-identical. Scoping it to `idle` makes that guarantee structural:
    /// the capture layout is not inside a navigation container at all, so there is
    /// nothing for a hidden toolbar to get wrong.
    ///
    /// The bar is hidden because this screen has no title of its own — the record
    /// button is the screen. watchOS still draws the time in that band.
    private var idle: some View {
        NavigationStack {
            idleContent
                .toolbar(.hidden, for: .navigationBar)
        }
    }

    private var idleContent: some View {
        VStack(spacing: 10) {
            Spacer(minLength: 0)

            Button {
                recorder.toggle()
            } label: {
                ZStack {
                    Circle()
                        .fill(Color.white.opacity(0.12))
                        .overlay(Circle().strokeBorder(Color.white.opacity(0.25), lineWidth: 1))
                    Image(systemName: "mic.fill")
                        .font(.system(size: 30, weight: .medium))
                        .foregroundStyle(.white)
                }
                .frame(width: 92, height: 92)
            }
            .buttonStyle(.plain)

            // Where "Dial8" used to be. Same type, same weight, same place — it
            // now says something useful and, when there is a choice to make, it
            // can be tapped or scrubbed with the Crown.
            WorkspaceSelector()

            Spacer(minLength: 0)

            if recorder.pendingSessionCount > 0 {
                Text("\(recorder.pendingSessionCount) waiting to sync")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Recording / paused

    /// One layout for both states. Only three things change on pause: the clock
    /// stops, the subtitle becomes "Paused", and the right-hand control turns from
    /// a level meter into a stop button. Keeping the frame identical means the
    /// pause button never moves under the user's finger.
    private var capture: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(white: 0.11))
                .padding(cardInset)
                // The card is the screen, not a box floating in it: it has to
                // reach into the safe-area inset at the top (under the system
                // clock) and to the bottom bezel, or it reads as a small panel
                // with black bands above and below.
                .ignoresSafeArea(edges: [.top, .bottom])

            VStack(spacing: 2) {
                Spacer(minLength: 0)

                Text(WatchRecorder.format(recorder.elapsed))
                    .font(.system(size: 44, weight: .regular, design: .serif))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    // "1:23:45" at 44pt is wider than the 46mm card. Shrink only
                    // as far as it must, and only once the hour rolls over — the
                    // common "0:07:26" case renders at full size.
                    .minimumScaleFactor(0.72)
                    .lineLimit(1)

                Text(subtitle)
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 6)

                Spacer(minLength: 0)

                HStack(alignment: .center) {
                    leftControl
                    Spacer(minLength: 0)
                    rightControl
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, cardInset + 8)
            .padding(.bottom, cardInset + 4)
            // The content stays INSIDE the safe area even though the card behind
            // it does not: this is what keeps the count-up clear of the system's
            // status band (the time and its recording mic glyph).
            .padding(.top, 2)
        }
    }

    private var subtitle: String {
        recorder.isPaused ? "Paused" : recorder.displayTitle
    }

    /// Pause while recording, resume while paused.
    private var leftControl: some View {
        CircleControl(systemName: recorder.isPaused ? "play.fill" : "pause.fill") {
            recorder.togglePause()
        }
    }

    /// The live meter while recording; the stop button once paused, where it can't
    /// be hit by accident mid-meeting.
    @ViewBuilder
    private var rightControl: some View {
        if recorder.isPaused {
            CircleControl(systemName: "stop.fill") {
                recorder.stop()
            }
        } else {
            LevelMeter(level: recorder.level)
                .frame(width: 64, height: 64)
        }
    }

    // MARK: - Stopped

    private func stopped(sent: Bool) -> some View {
        VStack(spacing: 10) {
            Spacer(minLength: 0)
            Image(systemName: recorder.wasInterrupted
                  ? "exclamationmark.triangle"
                  : (sent ? "checkmark.circle" : "clock"))
                .font(.system(size: 30, weight: .regular))
                .foregroundStyle(.white.opacity(0.85))
            Text(recorder.wasInterrupted
                 ? "Interrupted — saved what we got"
                 : (sent ? "Sent to iPhone" : "Waiting for iPhone"))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer(minLength: 0)
            if recorder.pendingSessionCount > 0 {
                Text("\(recorder.pendingSessionCount) waiting to sync")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Controls

/// A translucent circular button — the only control shape on this screen.
private struct CircleControl: View {
    let systemName: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().fill(Color.white.opacity(0.15))
                Image(systemName: systemName)
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(.white)
            }
            .frame(width: 64, height: 64)
        }
        .buttonStyle(.plain)
    }
}

/// Five vertical bars that rise and fall with the mic.
///
/// The bars are staggered — a single level drives all five, so without a
/// per-bar weighting they would move as one block and read as a slider rather
/// than as sound. The middle bars react hardest, which is how a level meter
/// looks. The idle floor is 4pt so the meter is still a visible object in
/// silence rather than vanishing.
private struct LevelMeter: View {
    let level: Double

    private let barCount = 5
    private let barWidth: CGFloat = 4
    private let spacing: CGFloat = 4
    private let minHeight: CGFloat = 4
    private let maxHeight: CGFloat = 40

    /// Centre bars swing furthest; the outer pair stay shorter.
    private static let weights: [Double] = [0.45, 0.75, 1.0, 0.8, 0.5]

    var body: some View {
        HStack(alignment: .center, spacing: spacing) {
            ForEach(0..<barCount, id: \.self) { index in
                Capsule(style: .continuous)
                    .fill(Color.white.opacity(0.85))
                    .frame(width: barWidth, height: height(for: index))
            }
        }
        .frame(width: 64, height: 64)
        .animation(.easeOut(duration: 0.12), value: level)
    }

    private func height(for index: Int) -> CGFloat {
        let weight = Self.weights[index % Self.weights.count]
        let value = max(0, min(1, level)) * weight
        return minHeight + (maxHeight - minHeight) * CGFloat(value)
    }
}
