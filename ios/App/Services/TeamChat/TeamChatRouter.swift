//
//  TeamChatRouter.swift
//  Native Intelligence
//
//  Where team chat is in Home's navigation stack, and where a tapped push
//  takes the person (PushTap decides the steps; this takes them): another
//  workspace's push switches workspace first, a team chat push opens its
//  channel at the message (its thread over it for a reply), the agent's
//  push opens the chat.
//

import Foundation
import SwiftUI

/// A team chat screen in Home's stack.
enum TeamChatRoute: Hashable {
    case list
    /// A channel, scrolled to a message when one is named.
    case channel(id: String, focus: String?)
    case thread(channelId: String, rootId: String, focus: String?)
}

@MainActor
final class TeamChatRouter: ObservableObject {
    static let shared = TeamChatRouter()

    /// Home's navigation stack.
    @Published var path: [TeamChatRoute] = []
    /// Asks Home to show the chat with the agent (the agent's push).
    @Published var chatRequest = 0
    /// Whether the chat with the agent is up (its push then shows no banner).
    var chatOpen = false

    private init() {}

    func openList() {
        path = [.list]
    }

    /// A tapped push, or a link: take its steps.
    func open(_ route: PushRoute) async {
        let workspaces = Set(WorkspaceService.shared.memberships.map { $0.workspaceId.uuidString.lowercased() })
        let current = WorkspaceService.shared.workspaceId?.uuidString.lowercased()
        for step in PushTap.steps(for: route, currentWorkspaceId: current, memberOf: workspaces) {
            switch step {
            case let .switchWorkspace(id):
                guard let uuid = UUID(uuidString: id) else { continue }
                try? await WorkspaceService.shared.switchWorkspace(to: uuid)
            case let .openTeamChat(channelId, messageId, rootId):
                if let rootId {
                    path = [.list, .channel(id: channelId, focus: rootId), .thread(channelId: channelId, rootId: rootId, focus: messageId)]
                } else {
                    path = [.list, .channel(id: channelId, focus: messageId)]
                }
            case .openChat:
                path = []
                chatRequest += 1
            }
        }
    }
}
