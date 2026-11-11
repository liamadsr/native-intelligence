//
//  iOSTeamCallCard.swift
//  Native Intelligence
//
//  A call's message in its conversation (TeamCallCard decides what it says):
//  live, who is in it and Join (or "You're in this call", which opens it);
//  ended, how it went ("Call ended · 12 min · 3 people", "Missed call").
//

import SwiftUI

struct iOSTeamCallCard: View {
    let message: TeamChatMessage
    @ObservedObject var model: TeamChatConversationModel
    @ObservedObject private var calls = TeamCallCenter.shared

    private var store: TeamChatStore { model.store }
    private var view: TeamCallView? { message.callId.flatMap { model.calls[$0] } }
    private var kind: TeamChatChannelKind { model.channel?.kind ?? .channel }

    var body: some View {
        let card = TeamCallCard.of(message: message.body, view: view, channelKind: kind, inCallId: calls.session?.callId)
        HStack(spacing: 12) {
            Image(systemName: icon(card))
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(isLive(card) ? Color(.systemGreen) : .secondary)
                .frame(width: 40, height: 40)
                .background(TeamChatStyle.tile, in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                switch card {
                case let .live(people, _):
                    Text("Call in progress").font(.system(size: 15, weight: .semibold))
                    Text(TeamCallCard.peopleLine(people.map { store.members[$0]?.name ?? "A teammate" }))
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                case let .ended(line):
                    Text(line).font(.system(size: 15, weight: .semibold)).foregroundStyle(.primary)
                    Text(TeamChatFormat.messageTime(message.createdAt)).font(.system(size: 13)).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if case let .live(_, here) = card, calls.available {
                Button {
                    Task { await calls.call(channelId: model.channelId, callId: message.callId, kind: kind, label: callLabel) }
                } label: {
                    Text(here ? "Open" : "Join")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(here ? Color.primary : Color.white)
                        .padding(.horizontal, 16)
                        .frame(height: 34)
                        .background(here ? AnyShapeStyle(TeamChatStyle.tile) : AnyShapeStyle(Color(.systemGreen)), in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(here ? "Open the call" : "Join the call")
            }
        }
        .padding(10)
        .frame(maxWidth: 340, alignment: .leading)
        .background(TeamChatStyle.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var callLabel: String {
        model.channel.map(store.title(of:)) ?? "Call"
    }

    private func isLive(_ card: TeamCallCard) -> Bool {
        if case .live = card { return true }
        return false
    }

    private func icon(_ card: TeamCallCard) -> String {
        switch card {
        case .live: return "phone.fill"
        case let .ended(line): return line == "Missed call" ? "phone.arrow.down.left" : "phone.down.fill"
        }
    }
}

/// The conversation's call button: start a call there (audio, the camera off), or open the one the
/// person is in. Hidden while calling is off on the server.
struct iOSTeamCallButton: View {
    let channel: TeamChatChannel
    @ObservedObject var store: TeamChatStore
    @ObservedObject private var calls = TeamCallCenter.shared

    var body: some View {
        if calls.available, channel.archivedAt == nil {
            Button {
                Task { await calls.call(channelId: channel.id, kind: channel.kind, label: store.title(of: channel)) }
            } label: {
                Image(systemName: calls.session?.channelId == channel.id.lowercased() ? "phone.connection.fill" : "phone")
            }
            .accessibilityLabel("Call")
        }
    }
}
