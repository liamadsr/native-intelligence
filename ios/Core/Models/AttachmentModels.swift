//
//  AttachmentModels.swift
//  dial8
//
//  Models for file attachments on notes
//

import Foundation

// MARK: - File Category

enum FileCategory: String, Codable, CaseIterable {
    case image
    case document

    /// Tolerant decode: an unrecognised `file_category` falls back to `.document`
    /// instead of failing the whole row.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = FileCategory(rawValue: raw) ?? .document
    }

    var displayName: String {
        switch self {
        case .image: return "Image"
        case .document: return "Document"
        }
    }

    var icon: String {
        switch self {
        case .image: return "photo"
        case .document: return "doc"
        }
    }
}

// MARK: - Attachment Model

struct Attachment: Codable, Identifiable, Equatable, Hashable {
    let id: UUID
    let userId: UUID
    /// `attachments.note_id` — still present in the DB, and nullable
    /// (an attachment may hang off an action instead of a capture).
    let noteId: UUID?
    let projectId: UUID?  // Optional - captures can exist without a project

    // File metadata
    var fileName: String
    var fileSizeBytes: Int64
    var mimeType: String
    var fileExtension: String
    var fileCategory: FileCategory

    // Storage
    var storageBucket: String
    var storagePath: String
    var thumbnailPath: String?
    var displayOrder: Int

    // Timestamps
    let createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case noteId = "note_id"
        case projectId = "project_id"
        case fileName = "file_name"
        case fileSizeBytes = "file_size_bytes"
        case mimeType = "mime_type"
        case fileExtension = "file_extension"
        case fileCategory = "file_category"
        case storageBucket = "storage_bucket"
        case storagePath = "storage_path"
        case thumbnailPath = "thumbnail_path"
        case displayOrder = "display_order"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    /// Tolerant decode: `note_id`, `project_id`, `thumbnail_path`, `display_order`,
    /// `created_at` and `updated_at` are all nullable in `attachments`.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        userId = try container.decode(UUID.self, forKey: .userId)
        noteId = try container.decodeIfPresent(UUID.self, forKey: .noteId)
        projectId = try container.decodeIfPresent(UUID.self, forKey: .projectId)
        fileName = try container.decodeIfPresent(String.self, forKey: .fileName) ?? "Untitled"
        fileSizeBytes = try container.decodeIfPresent(Int64.self, forKey: .fileSizeBytes) ?? 0
        mimeType = try container.decodeIfPresent(String.self, forKey: .mimeType) ?? "application/octet-stream"
        fileExtension = try container.decodeIfPresent(String.self, forKey: .fileExtension) ?? ""
        fileCategory = try container.decodeIfPresent(FileCategory.self, forKey: .fileCategory) ?? .document
        storageBucket = try container.decodeIfPresent(String.self, forKey: .storageBucket) ?? "attachments"
        storagePath = try container.decodeIfPresent(String.self, forKey: .storagePath) ?? ""
        thumbnailPath = try container.decodeIfPresent(String.self, forKey: .thumbnailPath)
        displayOrder = try container.decodeIfPresent(Int.self, forKey: .displayOrder) ?? 0
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date()
    }

    init(
        id: UUID = UUID(),
        userId: UUID,
        noteId: UUID?,
        projectId: UUID? = nil,
        fileName: String,
        fileSizeBytes: Int64,
        mimeType: String,
        fileExtension: String,
        fileCategory: FileCategory,
        storageBucket: String = "attachments",
        storagePath: String,
        thumbnailPath: String? = nil,
        displayOrder: Int = 0,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.userId = userId
        self.noteId = noteId
        self.projectId = projectId
        self.fileName = fileName
        self.fileSizeBytes = fileSizeBytes
        self.mimeType = mimeType
        self.fileExtension = fileExtension
        self.fileCategory = fileCategory
        self.storageBucket = storageBucket
        self.storagePath = storagePath
        self.thumbnailPath = thumbnailPath
        self.displayOrder = displayOrder
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    // MARK: - Computed Properties

    var isImage: Bool {
        fileCategory == .image
    }

    var isDocument: Bool {
        fileCategory == .document
    }

    var formattedFileSize: String {
        ByteCountFormatter.string(fromByteCount: fileSizeBytes, countStyle: .file)
    }

    /// Get the appropriate SF Symbol icon for this file type
    var fileIcon: String {
        switch mimeType {
        case let m where m.hasPrefix("image/"):
            return "photo"
        case "application/pdf":
            return "doc.richtext"
        case let m where m.contains("word"):
            return "doc.text"
        case let m where m.contains("excel") || m.contains("spreadsheet"):
            return "tablecells"
        case let m where m.contains("powerpoint") || m.contains("presentation"):
            return "rectangle.on.rectangle"
        default:
            return "doc"
        }
    }

    /// Color for the file type icon
    var fileIconColor: String {
        switch mimeType {
        case let m where m.hasPrefix("image/"):
            return "#10B981" // Green
        case "application/pdf":
            return "#EF4444" // Red
        case let m where m.contains("word"):
            return "#3B82F6" // Blue
        case let m where m.contains("excel") || m.contains("spreadsheet"):
            return "#22C55E" // Green
        case let m where m.contains("powerpoint") || m.contains("presentation"):
            return "#F97316" // Orange
        default:
            return "#6B7280" // Gray
        }
    }

    static func == (lhs: Attachment, rhs: Attachment) -> Bool {
        lhs.id == rhs.id
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

// MARK: - Create Attachment DTO

/// Insert payload for `attachments`. `workspace_id` is NOT NULL in the DB,
/// so it is required here; `note_id` is nullable.
struct CreateAttachmentDTO: Codable {
    let userId: UUID  // Required for RLS policy: auth.uid() = user_id
    let noteId: UUID?
    let projectId: UUID?
    let workspaceId: UUID
    let fileName: String
    let fileSizeBytes: Int64
    let mimeType: String
    let fileExtension: String
    let fileCategory: String
    let storagePath: String
    let thumbnailPath: String?

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case noteId = "note_id"
        case projectId = "project_id"
        case workspaceId = "workspace_id"
        case fileName = "file_name"
        case fileSizeBytes = "file_size_bytes"
        case mimeType = "mime_type"
        case fileExtension = "file_extension"
        case fileCategory = "file_category"
        case storagePath = "storage_path"
        case thumbnailPath = "thumbnail_path"
    }
}

// MARK: - Attachment Configuration

struct AttachmentConfig {
    /// Maximum file size: 25MB
    static let maxFileSizeBytes: Int64 = 25 * 1024 * 1024

    /// Maximum total size per note: 200MB
    static let maxTotalSizePerNote: Int64 = 200 * 1024 * 1024

    /// Allowed image MIME types
    static let allowedImageTypes = [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/heic",
        "image/webp"
    ]

    /// Allowed document MIME types
    static let allowedDocumentTypes = [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ]

    /// All allowed MIME types
    static var allAllowedTypes: [String] {
        allowedImageTypes + allowedDocumentTypes
    }

    /// File extensions for images
    static let imageExtensions = ["png", "jpg", "jpeg", "gif", "heic", "webp"]

    /// File extensions for documents
    static let documentExtensions = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]

    /// Determine category from MIME type
    static func category(for mimeType: String) -> FileCategory {
        if allowedImageTypes.contains(mimeType) {
            return .image
        }
        return .document
    }

    /// Check if MIME type is allowed
    static func isAllowed(mimeType: String) -> Bool {
        allAllowedTypes.contains(mimeType)
    }

    /// Check if file extension is allowed
    static func isAllowedExtension(_ ext: String) -> Bool {
        let lowercased = ext.lowercased()
        return imageExtensions.contains(lowercased) || documentExtensions.contains(lowercased)
    }

    /// Get category from file extension
    static func category(forExtension ext: String) -> FileCategory {
        let lowercased = ext.lowercased()
        if imageExtensions.contains(lowercased) {
            return .image
        }
        return .document
    }

    /// Get MIME type from file extension
    static func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "heic": return "image/heic"
        case "webp": return "image/webp"
        case "pdf": return "application/pdf"
        case "doc": return "application/msword"
        case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        case "xls": return "application/vnd.ms-excel"
        case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        case "ppt": return "application/vnd.ms-powerpoint"
        case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - Attachment Error

enum AttachmentError: LocalizedError {
    case authRequired
    case fileTooLarge(maxSize: Int64)
    case totalSizeExceeded(maxSize: Int64)
    case unsupportedFileType(String)
    case uploadFailed(Error)
    case downloadFailed(Error)
    case deleteFailed(Error)
    case notFound
    case networkError(Error)
    case invalidFileURL

    var errorDescription: String? {
        switch self {
        case .authRequired:
            return "Authentication required to manage attachments"
        case .fileTooLarge(let maxSize):
            return "File exceeds maximum size of \(ByteCountFormatter.string(fromByteCount: maxSize, countStyle: .file))"
        case .totalSizeExceeded(let maxSize):
            return "Total attachments for this note exceed \(ByteCountFormatter.string(fromByteCount: maxSize, countStyle: .file))"
        case .unsupportedFileType(let type):
            return "File type '\(type)' is not supported. Supported types: images (PNG, JPG, GIF, HEIC, WebP) and documents (PDF, Word, Excel, PowerPoint)"
        case .uploadFailed(let error):
            return "Upload failed: \(error.localizedDescription)"
        case .downloadFailed(let error):
            return "Download failed: \(error.localizedDescription)"
        case .deleteFailed(let error):
            return "Delete failed: \(error.localizedDescription)"
        case .notFound:
            return "Attachment not found"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .invalidFileURL:
            return "Invalid file URL"
        }
    }
}
