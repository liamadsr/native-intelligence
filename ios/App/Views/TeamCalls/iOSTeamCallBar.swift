//
//  iOSTeamCallBar.swift
//  Native Intelligence
//
//  The call, minimised: a bar over the app while the person moves around it
//  (the conversation's name, the clock or its state, mute, leave); a tap
//  opens the call again. Also the in-app incoming call, for where the
//  system's call screen can't show one (the Simulator), and the window the
//  full call screen lives in, above any sheet the app has up.
//

import SwiftUI
import UIKit

struct iOSTeamCallBar: View {
    @ObservedObject var center: TeamCallCenter
    @ObservedObject var session: TeamCallSession
    @State private var now = Date()

    var body: some View {
        HStack(spacing: 10) {
            Button {
                center.expanded = true
            } label: {
                HStack(spacing: 10) {
                    Circle()
                        .fill(session.state.connection == .connected ? Color(.systemGreen) : Color(.systemOrange))
                        .frame(width: 8, height: 8)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(session.label).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                        Text(session.state.statusLine(now: now))
                            .font(.system(size: 12).monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open the call, \(session.label)")
            let micOn = session.state.mic == .on
            Button {
                Task { await center.setMuted(micOn) }
            } label: {
                Image(systemName: micOn ? "mic.fill" : "mic.slash.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 36, height: 36)
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .buttonStyle(.plain)
            .disabled(session.state.mic == .denied || session.state.mic == .missing)
            .accessibilityLabel(micOn ? "Mute" : "Unmute")
            Button {
                Task { await center.hangUp() }
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Color(.systemRed), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Leave the call")
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .glassEffect(.regular, in: .capsule)
        .padding(.horizontal, 12)
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { now = $0 }
    }
}

/// An incoming call in the app (where the system's call screen couldn't show it).
struct iOSIncomingCallView: View {
    @ObservedObject var center: TeamCallCenter
    let ring: TeamCallIncoming
    @ObservedObject private var store = TeamChatStore.shared

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            TeamChatAvatar(member: TeamChatMember(id: ring.ringId, userId: nil, displayName: ring.callerName, avatarUrl: nil), size: 112)
            Text(ring.callerName)
                .font(.system(size: 30, weight: .regular, design: .serif))
                .padding(.top, 22)
            Text(ring.channelKind == .channel ? "Calling you in \(TeamCallWords.place(kind: .channel, name: ring.channelName) ?? "a channel")" : "Native Intelligence call")
                .font(.system(size: 16))
                .foregroundStyle(.secondary)
                .padding(.top, 6)
            Spacer()
            HStack(spacing: 80) {
                answerButton(systemImage: "phone.down.fill", color: Color(.systemRed), label: "Decline") { center.declineInApp() }
                answerButton(systemImage: "phone.fill", color: Color(.systemGreen), label: "Accept") { center.answerInApp() }
            }
            .padding(.bottom, 56)
        }
        .frame(maxWidth: .infinity)
        .background(TeamChatStyle.background.ignoresSafeArea())
    }

    private func answerButton(systemImage: String, color: Color, label: String, action: @escaping () -> Void) -> some View {
        VStack(spacing: 10) {
            Button(action: action) {
                Image(systemName: systemImage)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 76, height: 76)
                    .background(color, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            Text(label).font(.system(size: 14)).foregroundStyle(.secondary)
        }
    }
}

/// What the call window shows: the call full screen, or a ring the system couldn't show.
struct iOSTeamCallOverlay: View {
    @ObservedObject var center: TeamCallCenter

    var body: some View {
        Group {
            if let ring = center.inAppRing {
                iOSIncomingCallView(center: center, ring: ring)
            } else if let session = center.session, center.expanded {
                iOSTeamCallScreen(center: center, session: session)
            } else {
                Color.clear
            }
        }
    }
}

/// The window the full call screen and an in-app ring live in: above the app's sheets, so a call
/// answered while the chat or the recorder is up still shows. Hidden while there is nothing to show.
@MainActor
final class TeamCallWindow {
    static let shared = TeamCallWindow()
    private var window: UIWindow?

    func update(showing: Bool) {
        if showing {
            if window == nil {
                guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState != .unattached }) else { return }
                let w = UIWindow(windowScene: scene)
                w.windowLevel = .normal + 1
                let host = UIHostingController(rootView: iOSTeamCallOverlay(center: .shared))
                host.view.backgroundColor = .clear
                w.rootViewController = host
                window = w
            }
            window?.isHidden = false
            window?.makeKeyAndVisible()
        } else if let w = window {
            w.isHidden = true
            window = nil
            w.windowScene?.windows.first { $0 !== w && !$0.isHidden }?.makeKey()
        }
    }
}
