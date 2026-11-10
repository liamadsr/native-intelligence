//
//  AIProxyConfig.swift
//  Native Intelligence
//
//  Auth for the AI calls that go through Supabase Edge Functions (embeddings).
//  The server holds every provider key; the app never calls a model provider directly.
//

import Foundation
import Auth
import Supabase

enum AIProxyConfig {
    // MARK: - Proxy Endpoints

    /// Embeddings proxy (OpenAI behind the server's key).
    static var openaiProxyURL: String {
        SupabaseConfig.projectURL + "/functions/v1/ai-proxy-openai"
    }

    // MARK: - Authentication

    /// Get the current Supabase access token for authenticating with Edge Functions.
    /// Returns nil if the user is not signed in.
    static func getAccessToken() async -> String? {
        try? await SupabaseManager.shared.client.auth.session.accessToken
    }

    /// The Supabase anonymous public key (required header for Edge Function calls)
    static var anonKey: String {
        SupabaseConfig.anonPublicKey
    }

    /// Whether the user is signed in, which is all the proxy needs.
    static var isAuthenticated: Bool {
        SupabaseManager.shared.isAuthenticated
    }
}
