//
//  EmbeddingService.swift
//  dial8
//
//  Service for generating text embeddings via server-side proxy.
//  Requests route through Supabase Edge Functions that hold the OpenAI API key
//  server-side and track usage/costs per user.
//

import Foundation
import Combine

// MARK: - Embedding Error

enum EmbeddingError: LocalizedError {
    case notAuthenticated
    case invalidResponse
    case networkError(Error)
    case rateLimited(retryAfter: Int?)
    case invalidInput
    case apiError(String)
    case usageLimitExceeded(String)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            return "Sign in required to use AI features"
        case .invalidResponse:
            return "Invalid response from OpenAI API"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .rateLimited(let retryAfter):
            if let seconds = retryAfter {
                return "Rate limited. Retry after \(seconds) seconds"
            }
            return "Rate limited. Please try again later"
        case .invalidInput:
            return "Invalid input text for embedding"
        case .apiError(let message):
            return "OpenAI API error: \(message)"
        case .usageLimitExceeded(let message):
            return message
        }
    }
}

// MARK: - Embedding Status

enum EmbeddingStatus: Equatable {
    case notConfigured
    case ready
    case indexing(progress: Double, total: Int, completed: Int)
    case error(String)

    var description: String {
        switch self {
        case .notConfigured:
            return "Sign in required"
        case .ready:
            return "Ready"
        case .indexing(let progress, let total, let completed):
            return "Indexing \(completed)/\(total) (\(Int(progress * 100))%)"
        case .error(let message):
            return "Error: \(message)"
        }
    }

    var isReady: Bool {
        if case .ready = self { return true }
        return false
    }
}

// MARK: - OpenAI API Models

struct OpenAIEmbeddingRequest: Encodable {
    let model: String
    let input: [String]
    let encodingFormat: String

    enum CodingKeys: String, CodingKey {
        case model
        case input
        case encodingFormat = "encoding_format"
    }
}

struct OpenAIEmbeddingResponse: Decodable {
    let object: String
    let data: [EmbeddingData]
    let model: String
    let usage: Usage

    struct EmbeddingData: Decodable {
        let object: String
        let embedding: [Float]
        let index: Int
    }

    struct Usage: Decodable {
        let promptTokens: Int
        let totalTokens: Int

        enum CodingKeys: String, CodingKey {
            case promptTokens = "prompt_tokens"
            case totalTokens = "total_tokens"
        }
    }
}

struct OpenAIErrorResponse: Decodable {
    let error: ErrorDetail

    struct ErrorDetail: Decodable {
        let message: String
        let type: String
        let code: String?
    }
}

// MARK: - Embedding Service

class EmbeddingService: ObservableObject {
    static let shared = EmbeddingService()

    // MARK: - Published Properties

    @Published private(set) var status: EmbeddingStatus = .notConfigured
    @Published private(set) var isProcessing: Bool = false
    @Published private(set) var totalTokensUsed: Int = 0

    // MARK: - Configuration

    /// OpenAI embedding model - text-embedding-3-small is cost-effective and produces 1536 dimensions
    let embeddingModel = "text-embedding-3-small"
    let embeddingDimensions = 1536

    /// Maximum texts per batch request (OpenAI limit is 2048, we use smaller for safety)
    private let maxBatchSize = 100

    // MARK: - Private Properties

    private var cancellables = Set<AnyCancellable>()

    // MARK: - Initialization

    private init() {
        updateStatus()

        // Listen for auth changes to update status
        NotificationCenter.default.addObserver(
            forName: .authenticationComplete, object: nil, queue: .main
        ) { [weak self] _ in self?.updateStatus() }

        NotificationCenter.default.addObserver(
            forName: .userSignedOut, object: nil, queue: .main
        ) { [weak self] _ in self?.updateStatus() }
    }

    /// Whether embeddings can run: the proxy only needs a signed-in user
    func hasAPIKey() -> Bool {
        AIProxyConfig.isAuthenticated
    }

    // MARK: - Status Management

    private func updateStatus() {
        if AIProxyConfig.isAuthenticated {
            status = .ready
        } else {
            status = .notConfigured
        }
    }

    // MARK: - Embedding Generation

    /// Generate embedding for a single text
    func generateEmbedding(text: String) async throws -> [Float] {
        let results = try await generateEmbeddings(texts: [text])
        guard let embedding = results.first else {
            throw EmbeddingError.invalidResponse
        }
        return embedding
    }

    /// Generate embeddings for multiple texts (batch request)
    func generateEmbeddings(texts: [String]) async throws -> [[Float]] {
        // Filter out empty texts
        let cleanedTexts = texts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        guard !cleanedTexts.isEmpty else {
            throw EmbeddingError.invalidInput
        }

        // Process in batches if needed
        if cleanedTexts.count > maxBatchSize {
            return try await generateEmbeddingsInBatches(texts: cleanedTexts)
        }

        return try await makeEmbeddingRequest(texts: cleanedTexts)
    }

    /// Process large batches by splitting into smaller requests
    private func generateEmbeddingsInBatches(texts: [String]) async throws -> [[Float]] {
        var allEmbeddings: [[Float]] = []
        let batches = texts.chunked(into: maxBatchSize)

        for (index, batch) in batches.enumerated() {
            print("📊 EmbeddingService: Processing batch \(index + 1)/\(batches.count)")

            let batchEmbeddings = try await makeEmbeddingRequest(texts: batch)
            allEmbeddings.append(contentsOf: batchEmbeddings)

            // Small delay between batches to avoid rate limiting
            if index < batches.count - 1 {
                try await Task.sleep(nanoseconds: 100_000_000) // 0.1 second
            }
        }

        return allEmbeddings
    }

    /// Make the embedding request through the server proxy
    private func makeEmbeddingRequest(texts: [String]) async throws -> [[Float]] {
        let request = try await buildProxyRequest(texts: texts)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw EmbeddingError.invalidResponse
        }

        // Handle usage limit exceeded from proxy
        if httpResponse.statusCode == 429 {
            if let errorData = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let reason = errorData["reason"] as? String {
                throw EmbeddingError.usageLimitExceeded("Your AI usage limit has been reached (\(reason)).")
            }
            let retryAfter = httpResponse.value(forHTTPHeaderField: "Retry-After")
                .flatMap { Int($0) }
            throw EmbeddingError.rateLimited(retryAfter: retryAfter)
        }

        // Handle errors
        if httpResponse.statusCode != 200 {
            if let errorResponse = try? JSONDecoder().decode(OpenAIErrorResponse.self, from: data) {
                throw EmbeddingError.apiError(errorResponse.error.message)
            }
            throw EmbeddingError.apiError("HTTP \(httpResponse.statusCode)")
        }

        // Parse successful response
        let embeddingResponse = try JSONDecoder().decode(OpenAIEmbeddingResponse.self, from: data)

        // Update token usage
        await MainActor.run {
            totalTokensUsed += embeddingResponse.usage.totalTokens
        }

        // Sort by index to maintain order
        let sortedData = embeddingResponse.data.sorted { $0.index < $1.index }
        return sortedData.map { $0.embedding }
    }

    /// Build request for server-side proxy (managed keys)
    private func buildProxyRequest(texts: [String]) async throws -> URLRequest {
        guard let accessToken = await AIProxyConfig.getAccessToken() else {
            throw EmbeddingError.notAuthenticated
        }

        guard let url = URL(string: AIProxyConfig.openaiProxyURL) else {
            throw EmbeddingError.invalidInput
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.addValue(AIProxyConfig.anonKey, forHTTPHeaderField: "apikey")
        request.addValue("embeddings", forHTTPHeaderField: "x-dial8-feature")

        let requestBody = OpenAIEmbeddingRequest(
            model: embeddingModel,
            input: texts,
            encodingFormat: "float"
        )
        request.httpBody = try JSONEncoder().encode(requestBody)
        return request
    }
}

// MARK: - Array Extension for Chunking

extension Array {
    func chunked(into size: Int) -> [[Element]] {
        return stride(from: 0, to: count, by: size).map {
            Array(self[$0 ..< Swift.min($0 + size, count)])
        }
    }
}
