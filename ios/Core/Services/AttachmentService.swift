//
//  AttachmentService.swift
//  dial8
//
//  Service for managing file attachments with Supabase Storage
//

import Foundation
import Combine

// MARK: - Attachment Service

class AttachmentService: ObservableObject {
    static let shared = AttachmentService()

    // MARK: - Published Properties

    /// Attachments keyed by noteId for efficient lookup
    @Published private(set) var attachmentsByNote: [UUID: [Attachment]] = [:]

    /// All attachments for a project (used in Files tab)
    @Published private(set) var projectAttachments: [Attachment] = []

    /// Loading state
    @Published private(set) var isLoading = false

    /// Current upload progress (0.0 to 1.0)
    @Published private(set) var uploadProgress: Double = 0

    /// Upload state for UI feedback
    @Published private(set) var isUploading = false

    /// Last error
    @Published private(set) var error: Error?

    // MARK: - Private Properties

    private let supabase = SupabaseManager.shared
    private let storageBucket = "attachments"
    private var cancellables = Set<AnyCancellable>()

    // MARK: - Initialization

    private init() {
        setupAuthObserver()
    }

    private func setupAuthObserver() {
        // A workspace switch invalidates these caches exactly like a sign-out
        // does: they are keyed by capture/project id from the old workspace.
        // Lazily repopulated when a capture is opened, so no refetch here.
        Publishers.Merge(
            NotificationCenter.default.publisher(for: .userSignedOut),
            NotificationCenter.default.publisher(for: .workspaceDidChange)
        )
            .sink { [weak self] _ in
                Task { @MainActor in
                    self?.clearCache()
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - CRUD Operations

    /// Upload a file and create attachment record
    @discardableResult
    @MainActor
    func uploadAttachment(
        fileURL: URL,
        noteId: UUID,
        projectId: UUID?,
        onProgress: ((Double) -> Void)? = nil
    ) async throws -> Attachment {
        guard let userId = supabase.currentUser?.id else {
            throw AttachmentError.authRequired
        }

        // Validate file access
        guard fileURL.startAccessingSecurityScopedResource() else {
            // Try without security scope for files from within the app
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                throw AttachmentError.invalidFileURL
            }
            // Continue without security scope
            return try await performUpload(
                fileURL: fileURL,
                noteId: noteId,
                projectId: projectId,
                userId: userId,
                needsSecurityScope: false,
                onProgress: onProgress
            )
        }

        defer { fileURL.stopAccessingSecurityScopedResource() }

        return try await performUpload(
            fileURL: fileURL,
            noteId: noteId,
            projectId: projectId,
            userId: userId,
            needsSecurityScope: true,
            onProgress: onProgress
        )
    }

    @MainActor
    private func performUpload(
        fileURL: URL,
        noteId: UUID,
        projectId: UUID?,
        userId: UUID,
        needsSecurityScope: Bool,
        onProgress: ((Double) -> Void)?
    ) async throws -> Attachment {
        isUploading = true
        uploadProgress = 0
        defer {
            isUploading = false
            uploadProgress = 0
        }

        // Get file attributes
        let fileName = fileURL.lastPathComponent
        let fileExtension = fileURL.pathExtension.lowercased()

        // Validate file extension
        guard AttachmentConfig.isAllowedExtension(fileExtension) else {
            throw AttachmentError.unsupportedFileType(fileExtension)
        }

        // Read file data
        let fileData = try Data(contentsOf: fileURL)
        let fileSizeBytes = Int64(fileData.count)

        // Validate file size
        guard fileSizeBytes <= AttachmentConfig.maxFileSizeBytes else {
            throw AttachmentError.fileTooLarge(maxSize: AttachmentConfig.maxFileSizeBytes)
        }

        // Check total size for note
        let currentTotalSize = try await getTotalSize(forNote: noteId)
        guard currentTotalSize + fileSizeBytes <= AttachmentConfig.maxTotalSizePerNote else {
            throw AttachmentError.totalSizeExceeded(maxSize: AttachmentConfig.maxTotalSizePerNote)
        }

        // Get MIME type
        let mimeType = AttachmentConfig.mimeType(forExtension: fileExtension)
        let fileCategory = AttachmentConfig.category(forExtension: fileExtension)

        // Generate unique storage path (use lowercase UUIDs for consistent storage paths)
        let fileId = UUID()
        let storagePath = "\(userId.uuidString.lowercased())/\(noteId.uuidString.lowercased())/\(fileId.uuidString.lowercased()).\(fileExtension)"

        // Update progress
        uploadProgress = 0.1
        onProgress?(0.1)

        // Upload to storage
        print("📎 AttachmentService: Uploading \(fileName) to \(storagePath) (\(ByteCountFormatter.string(fromByteCount: fileSizeBytes, countStyle: .file)))")

        _ = try await supabase.uploadFile(
            bucket: storageBucket,
            path: storagePath,
            data: fileData,
            contentType: mimeType
        )

        uploadProgress = 0.8
        onProgress?(0.8)

        // attachments.workspace_id is NOT NULL
        let workspaceId = try await MainActor.run { try WorkspaceService.shared.requireWorkspaceId() }

        // Create database record
        let dto = CreateAttachmentDTO(
            userId: userId,  // Required for RLS policy
            noteId: noteId,
            projectId: projectId,
            workspaceId: workspaceId,
            fileName: fileName,
            fileSizeBytes: fileSizeBytes,
            mimeType: mimeType,
            fileExtension: fileExtension,
            fileCategory: fileCategory.rawValue,
            storagePath: storagePath,
            thumbnailPath: nil
        )

        let attachment: Attachment = try await supabase.client
            .from("attachments")
            .insert(dto)
            .select()
            .single()
            .execute()
            .value

        uploadProgress = 1.0
        onProgress?(1.0)

        // Update local cache
        await MainActor.run {
            if var noteAttachments = attachmentsByNote[noteId] {
                noteAttachments.append(attachment)
                attachmentsByNote[noteId] = noteAttachments
            } else {
                attachmentsByNote[noteId] = [attachment]
            }
        }

        print("📎 AttachmentService: Uploaded attachment \(attachment.id)")
        return attachment
    }

    /// Upload raw data (for screenshots/pasted images)
    @discardableResult
    @MainActor
    func uploadAttachmentData(
        data: Data,
        fileName: String,
        noteId: UUID,
        projectId: UUID?,
        onProgress: ((Double) -> Void)? = nil
    ) async throws -> Attachment {
        guard let userId = supabase.currentUser?.id else {
            throw AttachmentError.authRequired
        }

        isUploading = true
        uploadProgress = 0
        defer {
            isUploading = false
            uploadProgress = 0
        }

        // Get file metadata from filename
        let fileExtension = (fileName as NSString).pathExtension.lowercased()
        let fileSizeBytes = Int64(data.count)

        // Validate file extension
        guard AttachmentConfig.isAllowedExtension(fileExtension) else {
            throw AttachmentError.unsupportedFileType(fileExtension)
        }

        // Validate file size
        guard fileSizeBytes <= AttachmentConfig.maxFileSizeBytes else {
            throw AttachmentError.fileTooLarge(maxSize: AttachmentConfig.maxFileSizeBytes)
        }

        // Check total size for note
        let currentTotalSize = try await getTotalSize(forNote: noteId)
        guard currentTotalSize + fileSizeBytes <= AttachmentConfig.maxTotalSizePerNote else {
            throw AttachmentError.totalSizeExceeded(maxSize: AttachmentConfig.maxTotalSizePerNote)
        }

        // Get MIME type
        let mimeType = AttachmentConfig.mimeType(forExtension: fileExtension)
        let fileCategory = AttachmentConfig.category(forExtension: fileExtension)

        // Generate unique storage path (use lowercase UUIDs for consistent storage paths)
        let fileId = UUID()
        let storagePath = "\(userId.uuidString.lowercased())/\(noteId.uuidString.lowercased())/\(fileId.uuidString.lowercased()).\(fileExtension)"

        // Update progress
        uploadProgress = 0.1
        onProgress?(0.1)

        // Upload to storage
        print("📎 AttachmentService: Uploading \(fileName) to \(storagePath) (\(ByteCountFormatter.string(fromByteCount: fileSizeBytes, countStyle: .file)))")

        _ = try await supabase.uploadFile(
            bucket: storageBucket,
            path: storagePath,
            data: data,
            contentType: mimeType
        )

        uploadProgress = 0.8
        onProgress?(0.8)

        // attachments.workspace_id is NOT NULL
        let workspaceId = try WorkspaceService.shared.requireWorkspaceId()

        // Create database record
        let dto = CreateAttachmentDTO(
            userId: userId,  // Required for RLS policy
            noteId: noteId,
            projectId: projectId,
            workspaceId: workspaceId,
            fileName: fileName,
            fileSizeBytes: fileSizeBytes,
            mimeType: mimeType,
            fileExtension: fileExtension,
            fileCategory: fileCategory.rawValue,
            storagePath: storagePath,
            thumbnailPath: nil
        )

        let attachment: Attachment = try await supabase.client
            .from("attachments")
            .insert(dto)
            .select()
            .single()
            .execute()
            .value

        uploadProgress = 1.0
        onProgress?(1.0)

        // Update local cache
        if var noteAttachments = attachmentsByNote[noteId] {
            noteAttachments.append(attachment)
            attachmentsByNote[noteId] = noteAttachments
        } else {
            attachmentsByNote[noteId] = [attachment]
        }

        print("📎 AttachmentService: Uploaded attachment \(attachment.id)")
        return attachment
    }

    // MARK: - Download/Preview Operations

    /// Get signed URL for viewing/downloading a file
    func getSignedURL(for attachment: Attachment, expiresIn: Int = 3600) async throws -> URL {
        return try await supabase.getSignedURL(
            bucket: storageBucket,
            path: attachment.storagePath,
            expiresIn: expiresIn
        )
    }

    // MARK: - Validation

    /// Get current total attachment size for a note
    func getTotalSize(forNote noteId: UUID) async throws -> Int64 {
        // Try to get from RPC function first
        do {
            let result: Int64 = try await supabase.client
                .rpc("get_note_attachment_size", params: ["p_note_id": noteId.uuidString])
                .execute()
                .value
            return result
        } catch {
            // Fallback to calculating from local cache
            let attachments = attachmentsByNote[noteId] ?? []
            return attachments.reduce(0) { $0 + $1.fileSizeBytes }
        }
    }

    // MARK: - Cache Management

    /// Clear all cached attachments
    @MainActor
    func clearCache() {
        attachmentsByNote = [:]
        projectAttachments = []
    }
}
