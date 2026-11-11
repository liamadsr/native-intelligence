//
//  iOSTeamCallScreen.swift
//  Native Intelligence
//
//  The call, full screen: who is in it (their cameras, or their faces; the
//  one speaking marked; someone's shared screen on top), the conversation's
//  name and the call's clock or its state (connecting, reconnecting, on
//  hold), why the person is listening only, and the controls: mute, camera
//  on and off and its flip, where the sound goes (the system's picker:
//  speaker, earpiece, Bluetooth), ring someone in, and leave. Minimised, it
//  is the bar (iOSTeamCallBar) while the person moves around the app.
//

import AVKit
import LiveKit
import SwiftUI

struct iOSTeamCallScreen: View {
    @ObservedObject var center: TeamCallCenter
    @ObservedObject var session: TeamCallSession
    @ObservedObject private var store = TeamChatStore.shared
    @State private var now = Date()
    @State private var picking = false

    private var tiles: [TeamCallTile] { TeamCallTiles.tiles(session.peers) }

    var body: some View {
        VStack(spacing: 0) {
            header
            if !session.state.notices.isEmpty { notices }
            stage
                .padding(.horizontal, 12)
                .padding(.top, 8)
            controls
        }
        .background(TeamChatStyle.background.ignoresSafeArea())
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { now = $0 }
        .sheet(isPresented: $picking) {
            iOSTeamCallRingPicker(center: center, session: session)
                .presentationDetents([.medium, .large])
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                center.expanded = false
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Minimise the call")
            VStack(spacing: 2) {
                Text(session.label)
                    .font(.system(size: 17, weight: .semibold))
                    .lineLimit(1)
                Text(session.state.statusLine(now: now))
                    .font(.system(size: 14).monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            Button {
                picking = true
            } label: {
                Image(systemName: "person.badge.plus")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .buttonStyle(.plain)
            .opacity(session.channelKind == .channel ? 1 : 0)
            .disabled(session.channelKind != .channel)
            .accessibilityLabel("Ring someone into the call")
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    private var notices: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(session.state.notices, id: \.self) { line in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "mic.slash").foregroundStyle(.secondary)
                    Text(line).font(.system(size: 14)).fixedSize(horizontal: false, vertical: true)
                }
            }
            if session.state.notice != nil {
                Button("Unmute") {
                    Task { await center.continueAfterNotice() }
                }
                .font(.system(size: 14, weight: .semibold))
            } else {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .font(.system(size: 14, weight: .semibold))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TeamChatStyle.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.top, 10)
    }

    // MARK: Stage

    @ViewBuilder
    private var stage: some View {
        let all = tiles
        switch TeamCallTiles.layout(all) {
        case .waiting:
            VStack(spacing: 18) {
                Spacer(minLength: 0)
                if let me = all.first {
                    iOSTeamCallTile(tile: me, session: session, store: store, large: true)
                        .frame(maxWidth: 260)
                        .aspectRatio(3 / 4, contentMode: .fit)
                }
                Text(waitingLine)
                    .font(.system(size: 15))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity)
        case .pair:
            let other = all.first { !$0.isLocal } ?? all[0]
            let me = all.first { $0.isLocal }
            iOSTeamCallTile(tile: other, session: session, store: store, large: true)
                .overlay(alignment: .bottomTrailing) {
                    if let me {
                        iOSTeamCallTile(tile: me, session: session, store: store, large: false)
                            .frame(width: 104, height: 140)
                            .shadow(color: .black.opacity(0.25), radius: 10, y: 4)
                            .padding(10)
                    }
                }
        case let .grid(columns):
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: columns), spacing: 8) {
                    ForEach(all) { tile in
                        iOSTeamCallTile(tile: tile, session: session, store: store, large: false)
                            .aspectRatio(3 / 4, contentMode: .fit)
                    }
                }
            }
            .scrollIndicators(.hidden)
        case .screen:
            VStack(spacing: 8) {
                if let screen = all.first(where: { $0.kind == .screen }) {
                    iOSTeamCallTile(tile: screen, session: session, store: store, large: true)
                }
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(all.filter { $0.kind == .person }) { tile in
                            iOSTeamCallTile(tile: tile, session: session, store: store, large: false)
                                .frame(width: 96, height: 128)
                        }
                    }
                }
                .scrollIndicators(.hidden)
                .frame(height: 128)
            }
        }
    }

    private var waitingLine: String {
        switch session.state.connection {
        case .connecting: return "Joining…"
        default: return session.channelKind == .dm ? "Ringing…" : "Waiting for others to join"
        }
    }

    // MARK: Controls

    private var controls: some View {
        HStack(spacing: 14) {
            let micOn = session.state.mic == .on
            let micBlocked = session.state.mic == .denied || session.state.mic == .missing
            iOSTeamCallControl(systemImage: micOn ? "mic.fill" : "mic.slash.fill", label: micOn ? "Mute" : "Unmute", active: !micOn) {
                Task { await center.setMuted(micOn) }
            }
            .disabled(micBlocked)
            .opacity(micBlocked ? 0.45 : 1)
            let camOn = session.state.camera == .on
            iOSTeamCallControl(systemImage: camOn ? "video.fill" : "video.slash.fill", label: camOn ? "Turn the camera off" : "Turn the camera on", active: camOn) {
                Task { await session.toggleCamera() }
            }
            if camOn {
                iOSTeamCallControl(systemImage: "arrow.triangle.2.circlepath.camera", label: "Flip the camera", active: false) {
                    Task { await session.flipCamera() }
                }
            }
            iOSAudioRoutePicker()
                .frame(width: 60, height: 60)
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("Where the sound goes")
            Button {
                Task { await center.hangUp() }
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 60, height: 60)
                    .background(Color(.systemRed), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Leave the call")
        }
        .padding(.top, 14)
        .padding(.bottom, 12)
    }
}

/// One round control: filled when it is on (muted, the camera on).
struct iOSTeamCallControl: View {
    let systemImage: String
    let label: String
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            if active {
                Image(systemName: systemImage)
                    .font(.system(size: 21, weight: .semibold))
                    .foregroundStyle(Color(.systemBackground))
                    .frame(width: 60, height: 60)
                    .background(Color.primary, in: Circle())
            } else {
                Image(systemName: systemImage)
                    .font(.system(size: 21, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 60, height: 60)
                    .glassEffect(.regular.interactive(), in: .circle)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// One person's tile (their camera, or their face) or a shared screen.
struct iOSTeamCallTile: View {
    let tile: TeamCallTile
    @ObservedObject var session: TeamCallSession
    let store: TeamChatStore
    let large: Bool

    var body: some View {
        // The tile's own shape sets its size; what it shows (video, a face) fills it and never pushes it.
        RoundedRectangle(cornerRadius: large ? 22 : 16, style: .continuous)
            .fill(TeamChatStyle.tile)
            .overlay {
                if tile.hasVideo {
                    video
                } else {
                    TeamChatAvatar(member: store.members[tile.identity] ?? TeamChatMember(id: tile.identity, userId: nil, displayName: tile.name, avatarUrl: nil), size: large ? 96 : 56)
                }
            }
            .overlay(alignment: .bottomLeading) { nameTag }
        .clipShape(RoundedRectangle(cornerRadius: large ? 22 : 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: large ? 22 : 16, style: .continuous)
                .strokeBorder(tile.speaking ? Color(.systemGreen) : .clear, lineWidth: 3)
        )
        .animation(.easeOut(duration: 0.15), value: tile.speaking)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(tile.isLocal ? "You" : tile.name)
    }

    private var nameTag: some View {
            HStack(spacing: 5) {
                if !tile.micOn && tile.kind == .person {
                    Image(systemName: "mic.slash.fill").font(.system(size: 11, weight: .semibold))
                }
                Text(tile.kind == .screen ? "\(tile.name)’s screen" : (tile.isLocal ? "You" : tile.name))
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(tile.hasVideo ? .white : .primary)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(tile.hasVideo ? AnyShapeStyle(.black.opacity(0.35)) : AnyShapeStyle(.clear), in: Capsule())
            .padding(8)
    }

    @ViewBuilder
    private var video: some View {
        if let track = session.videoTrack(for: tile) {
            SwiftUIVideoView(track, layoutMode: tile.kind == .screen ? .fit : .fill, mirrorMode: tile.isLocal ? .mirror : .off)
        } else {
            waitingForVideo
        }
    }

    @ViewBuilder
    private var waitingForVideo: some View {
        #if DEBUG
        if session.isFixture {
            iOSTeamCallFixtureVideo(seed: tile.identity, screen: tile.kind == .screen)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        #else
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        #endif
    }
}

/// The system's picker for where the sound goes (speaker, earpiece, Bluetooth, AirPlay).
struct iOSAudioRoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.prioritizesVideoDevices = false
        v.tintColor = .label
        v.activeTintColor = .systemGreen
        return v
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}

/// Ring people from the conversation into the call (a channel's call rings nobody by itself).
struct iOSTeamCallRingPicker: View {
    @ObservedObject var center: TeamCallCenter
    @ObservedObject var session: TeamCallSession
    @ObservedObject private var store = TeamChatStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var line: String?

    var body: some View {
        NavigationStack {
            List {
                let inCall = Set(session.peers.map(\.identity))
                ForEach(store.memberList.filter { $0.id != store.me && !inCall.contains($0.id) }) { m in
                    Button {
                        Task {
                            let n = await center.ring(memberIds: [m.id])
                            line = n == nil ? "Couldn’t ring \(m.name). Try again." : n == 0 ? "\(m.name) can’t be rung for this call right now." : "Ringing \(m.name)…"
                        }
                    } label: {
                        HStack(spacing: 12) {
                            TeamChatAvatar(member: m, size: 32)
                            Text(m.name).foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "phone.arrow.up.right").foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Ring into the call")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .safeAreaInset(edge: .bottom) {
                if let line {
                    Text(line).font(.system(size: 14)).padding(10).frame(maxWidth: .infinity).background(.bar)
                }
            }
        }
    }
}

#if DEBUG
/// The DEBUG preview's stand-in for someone's camera: soft light on a face-coloured blur.
struct iOSTeamCallFixtureVideo: View {
    let seed: String
    let screen: Bool

    var body: some View {
        let palettes: [[Color]] = [
            [Color(red: 0.24, green: 0.30, blue: 0.42), Color(red: 0.78, green: 0.58, blue: 0.47)],
            [Color(red: 0.20, green: 0.32, blue: 0.28), Color(red: 0.86, green: 0.74, blue: 0.56)],
            [Color(red: 0.36, green: 0.26, blue: 0.36), Color(red: 0.90, green: 0.66, blue: 0.58)],
        ]
        let p = palettes[abs(seed.hashValue) % palettes.count]
        if screen {
            ZStack(alignment: .topLeading) {
                Color(red: 0.96, green: 0.96, blue: 0.97)
                VStack(alignment: .leading, spacing: 8) {
                    RoundedRectangle(cornerRadius: 3).fill(Color(red: 0.2, green: 0.2, blue: 0.24)).frame(width: 160, height: 12)
                    ForEach(0..<5, id: \.self) { i in
                        RoundedRectangle(cornerRadius: 3).fill(Color(red: 0.75, green: 0.77, blue: 0.80)).frame(width: CGFloat(220 - i * 26), height: 8)
                    }
                    HStack(spacing: 8) {
                        RoundedRectangle(cornerRadius: 6).fill(Color(red: 0.45, green: 0.55, blue: 0.80)).frame(width: 90, height: 60)
                        RoundedRectangle(cornerRadius: 6).fill(Color(red: 0.93, green: 0.62, blue: 0.45)).frame(width: 90, height: 60)
                    }
                }
                .padding(16)
            }
        } else {
            GeometryReader { g in
                let w = min(g.size.width, g.size.height * 0.8)
                ZStack {
                    LinearGradient(colors: p, startPoint: .top, endPoint: .bottom)
                    Circle().fill(p[1].opacity(0.9)).frame(width: w * 0.42, height: w * 0.42).offset(y: -w * 0.12).blur(radius: 2)
                    Ellipse().fill(p[0].opacity(0.85)).frame(width: w * 0.9, height: w * 0.55).offset(y: w * 0.42)
                }
                .frame(width: g.size.width, height: g.size.height)
            }
        }
    }
}
#endif
