//
//  TranscriptSegmentBubble.swift
//  Native Intelligence
//
//  Transcript segment display view.
//  Shows speaker label, timestamp, and transcript text in a colored bubble.
//

import SwiftUI

struct TranscriptSegmentBubble: View {
    let segment: TranscriptSegment
    @Environment(\.colorScheme) private var colorScheme

    private var isMe: Bool {
        segment.source == .microphone
    }

    private var speakerColor: Color {
        switch segment.source {
        case .microphone: return .blue
        case .systemAudio: return .purple
        }
    }

    private var alignment: HorizontalAlignment {
        isMe ? .trailing : .leading
    }

    var body: some View {
        HStack {
            if isMe {
                Spacer(minLength: 40)
            }

            VStack(alignment: alignment, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: segment.source.iconName)
                        .font(.system(size: 10))
                        .foregroundColor(speakerColor)

                    Text(segment.source.displayLabel)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(speakerColor)

                    Text("• \(segment.formattedOffset)")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }

                Text(segment.text)
                    .font(.system(size: 13))
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .multilineTextAlignment(isMe ? .trailing : .leading)
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 12)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(speakerColor.opacity(colorScheme == .dark ? 0.15 : 0.1))
            )

            if !isMe {
                Spacer(minLength: 40)
            }
        }
    }
}
