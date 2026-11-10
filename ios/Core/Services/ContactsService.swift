//
//  ContactsService.swift
//  Native Intelligence
//
//  Service for managing contacts with Supabase backend
//

import Foundation
import Combine

// MARK: - Contacts Error

enum ContactsError: LocalizedError {
    case authRequired
    case notFound
    case createFailed(String)
    case updateFailed(String)
    case deleteFailed(String)
    case networkError(Error)

    var errorDescription: String? {
        switch self {
        case .authRequired:
            return "Please sign in to access contacts"
        case .notFound:
            return "Contact not found"
        case .createFailed(let message):
            return "Failed to create contact: \(message)"
        case .updateFailed(let message):
            return "Failed to update contact: \(message)"
        case .deleteFailed(let message):
            return "Failed to delete contact: \(message)"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        }
    }
}

// MARK: - Contact Filter

enum ContactFilter: String, CaseIterable {
    case all
    case favorites

    var displayName: String {
        switch self {
        case .all: return "All Contacts"
        case .favorites: return "Favorites"
        }
    }

    var icon: String {
        switch self {
        case .all: return "person.2"
        case .favorites: return "star.fill"
        }
    }
}

// MARK: - Contact Sort Option

enum ContactSortOption: String, CaseIterable {
    case firstName
    case lastName
    case company
    case recentlyAdded

    var displayName: String {
        switch self {
        case .firstName: return "First Name"
        case .lastName: return "Last Name"
        case .company: return "Company"
        case .recentlyAdded: return "Recently Added"
        }
    }
}

// MARK: - Contacts Service

class ContactsService: ObservableObject {
    static let shared = ContactsService()

    // MARK: - Published Properties

    @Published private(set) var contacts: [Contact] = []
    @Published private(set) var groups: [ContactGroup] = []
    @Published private(set) var isLoading = false
    @Published private(set) var error: Error?
    @Published var searchQuery = ""
    @Published var selectedFilter: ContactFilter = .all
    @Published var selectedGroupId: UUID?
    @Published var sortOption: ContactSortOption = .firstName

    // MARK: - Computed Properties

    var favoriteContacts: [Contact] {
        contacts.filter { $0.isFavorite }
    }

    var contactCount: Int {
        contacts.count
    }

    var groupCount: Int {
        groups.count
    }

    /// The currently selected group (if any)
    var selectedGroup: ContactGroup? {
        guard let groupId = selectedGroupId else { return nil }
        return groups.first { $0.id == groupId }
    }

    var filteredContacts: [Contact] {
        var result = contacts

        // Apply filter
        switch selectedFilter {
        case .all:
            break
        case .favorites:
            result = result.filter { $0.isFavorite }
        }

        // Apply group filter
        if let groupId = selectedGroupId {
            result = result.filter { contact in
                contact.groups.contains { $0.id == groupId }
            }
        }

        // Apply search
        if !searchQuery.isEmpty {
            let query = searchQuery.lowercased()
            result = result.filter { contact in
                contact.displayName.lowercased().contains(query) ||
                contact.nickname?.lowercased().contains(query) == true ||
                contact.company?.lowercased().contains(query) == true ||
                contact.emails.contains { $0.email.lowercased().contains(query) } ||
                contact.phones.contains { $0.phoneNumber.contains(query) }
            }
        }

        // Apply sorting
        return sortContacts(result)
    }

    var groupedContacts: [String: [Contact]] {
        var grouped: [String: [Contact]] = [:]
        for contact in filteredContacts {
            let key = sectionKey(for: contact)
            grouped[key, default: []].append(contact)
        }
        return grouped
    }

    var sectionKeys: [String] {
        groupedContacts.keys.sorted()
    }

    // MARK: - Private Properties

    private let supabase = SupabaseManager.shared
    private var cancellables = Set<AnyCancellable>()

    // MARK: - Initialization

    private init() {
        setupAuthObserver()
        setupWorkspaceObserver()

        // If user is already authenticated (session restored from previous launch),
        // fetch contacts immediately since authenticationComplete won't fire again
        if supabase.isAuthenticated {
            print("📇 ContactsService: User already authenticated, fetching contacts...")
            Task {
                _ = try? await self.fetchContacts()
                _ = try? await self.fetchGroups()
            }
        }
    }

    /// The CRM is per workspace: contacts and groups from the old one must not
    /// linger. Clear both synchronously, then refetch for the new workspace.
    private func setupWorkspaceObserver() {
        NotificationCenter.default.publisher(for: .workspaceDidChange)
            .sink { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.contacts = []
                    self.groups = []
                    self.searchQuery = ""
                    self.selectedGroupId = nil
                    self.error = nil
                    self.isLoading = false
                    print("📇 ContactsService: cleared cache for workspace switch")
                    _ = try? await self.fetchContacts()
                    _ = try? await self.fetchGroups()
                }
            }
            .store(in: &cancellables)
    }

    private func setupAuthObserver() {
        NotificationCenter.default.publisher(for: .authenticationComplete)
            .sink { [weak self] _ in
                print("📇 ContactsService: Received authenticationComplete, fetching contacts...")
                Task {
                    _ = try? await self?.fetchContacts()
                    _ = try? await self?.fetchGroups()
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: .userSignedOut)
            .sink { [weak self] _ in
                Task { @MainActor in
                    self?.contacts = []
                    self?.groups = []
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - Sorting & Grouping Helpers

    private func sortContacts(_ contacts: [Contact]) -> [Contact] {
        switch sortOption {
        case .firstName:
            return contacts.sorted { ($0.firstName ?? "").lowercased() < ($1.firstName ?? "").lowercased() }
        case .lastName:
            return contacts.sorted { ($0.lastName ?? "").lowercased() < ($1.lastName ?? "").lowercased() }
        case .company:
            return contacts.sorted { ($0.company ?? "zzz").lowercased() < ($1.company ?? "zzz").lowercased() }
        case .recentlyAdded:
            return contacts.sorted { $0.createdAt > $1.createdAt }
        }
    }

    private func sectionKey(for contact: Contact) -> String {
        let value: String?
        switch sortOption {
        case .firstName:
            value = contact.firstName
        case .lastName:
            value = contact.lastName
        case .company:
            value = contact.company
        case .recentlyAdded:
            return "" // No sections for recently added
        }

        guard let first = value?.first else { return "#" }
        let upper = String(first).uppercased()
        return upper.first?.isLetter == true ? upper : "#"
    }

    // MARK: - Fetch Operations

    /// Fetch all contacts for the current user
    @discardableResult
    func fetchContacts() async throws -> [Contact] {
        guard let userId = supabase.currentUser?.id else {
            throw ContactsError.authRequired
        }

        await MainActor.run {
            isLoading = true
            error = nil
        }

        defer {
            Task { @MainActor in
                isLoading = false
            }
        }

        do {
            // Fetch base contacts
            let baseContacts: [Contact] = try await supabase.client
                .from("contacts")
                .select()
                .eq("user_id", value: userId.uuidString)
                .order("first_name", ascending: true)
                .execute()
                .value

            // Fetch all related data in parallel
            async let phonesTask = fetchAllPhones(userId: userId)
            async let emailsTask = fetchAllEmails(userId: userId)
            async let addressesTask = fetchAllAddresses(userId: userId)
            async let urlsTask = fetchAllURLs(userId: userId)
            async let datesTask = fetchAllDates(userId: userId)
            async let socialProfilesTask = fetchAllSocialProfiles(userId: userId)
            async let instantMessagesTask = fetchAllInstantMessages(userId: userId)
            async let relatedNamesTask = fetchAllRelatedNames(userId: userId)
            async let customFieldsTask = fetchAllCustomFields(userId: userId)
            async let groupMembersTask = fetchAllGroupMembers(userId: userId)

            let (phones, emails, addresses, urls, dates, socialProfiles, instantMessages, relatedNames, customFields, groupMembers) = try await (
                phonesTask, emailsTask, addressesTask, urlsTask, datesTask,
                socialProfilesTask, instantMessagesTask, relatedNamesTask, customFieldsTask, groupMembersTask
            )

            // Group data by contact ID
            let phonesByContact = Dictionary(grouping: phones, by: { $0.contactId ?? UUID() })
            let emailsByContact = Dictionary(grouping: emails, by: { $0.contactId ?? UUID() })
            let addressesByContact = Dictionary(grouping: addresses, by: { $0.contactId ?? UUID() })
            let urlsByContact = Dictionary(grouping: urls, by: { $0.contactId ?? UUID() })
            let datesByContact = Dictionary(grouping: dates, by: { $0.contactId ?? UUID() })
            let socialProfilesByContact = Dictionary(grouping: socialProfiles, by: { $0.contactId ?? UUID() })
            let instantMessagesByContact = Dictionary(grouping: instantMessages, by: { $0.contactId ?? UUID() })
            let relatedNamesByContact = Dictionary(grouping: relatedNames, by: { $0.contactId ?? UUID() })
            let customFieldsByContact = Dictionary(grouping: customFields, by: { $0.contactId ?? UUID() })
            let groupIdsByContact = Dictionary(grouping: groupMembers, by: { $0.contactId }).mapValues { $0.map { $0.groupId } }

            // Assemble full contacts
            let fullContacts = baseContacts.map { contact -> Contact in
                var c = contact
                c.phones = phonesByContact[contact.id] ?? []
                c.emails = emailsByContact[contact.id] ?? []
                c.addresses = addressesByContact[contact.id] ?? []
                c.urls = urlsByContact[contact.id] ?? []
                c.dates = datesByContact[contact.id] ?? []
                c.socialProfiles = socialProfilesByContact[contact.id] ?? []
                c.instantMessages = instantMessagesByContact[contact.id] ?? []
                c.relatedNames = relatedNamesByContact[contact.id] ?? []
                c.customFields = customFieldsByContact[contact.id] ?? []
                c.groups = self.groups.filter { groupIdsByContact[contact.id]?.contains($0.id) == true }
                return c
            }

            await MainActor.run {
                self.contacts = fullContacts
            }

            print("📇 ContactsService: Fetched \(fullContacts.count) contacts")
            return fullContacts

        } catch {
            await MainActor.run {
                self.error = error
            }
            print("❌ ContactsService: Failed to fetch contacts: \(error)")
            throw error
        }
    }

    // MARK: - Helper fetch functions for related data

    private func fetchAllPhones(userId: UUID) async throws -> [ContactPhone] {
        try await supabase.client
            .from("contact_phones")
            .select()
            .eq("user_id", value: userId.uuidString)
            .order("sort_order", ascending: true)
            .execute()
            .value
    }

    private func fetchAllEmails(userId: UUID) async throws -> [ContactEmail] {
        try await supabase.client
            .from("contact_emails")
            .select()
            .eq("user_id", value: userId.uuidString)
            .order("sort_order", ascending: true)
            .execute()
            .value
    }

    private func fetchAllAddresses(userId: UUID) async throws -> [ContactAddress] {
        try await supabase.client
            .from("contact_addresses")
            .select()
            .eq("user_id", value: userId.uuidString)
            .order("sort_order", ascending: true)
            .execute()
            .value
    }

    private func fetchAllURLs(userId: UUID) async throws -> [ContactURL] {
        try await supabase.client
            .from("contact_urls")
            .select()
            .eq("user_id", value: userId.uuidString)
            .order("sort_order", ascending: true)
            .execute()
            .value
    }

    private func fetchAllDates(userId: UUID) async throws -> [ContactDate] {
        try await supabase.client
            .from("contact_dates")
            .select()
            .eq("user_id", value: userId.uuidString)
            .order("sort_order", ascending: true)
            .execute()
            .value
    }

    private func fetchAllSocialProfiles(userId: UUID) async throws -> [ContactSocialProfile] {
        try await supabase.client
            .from("contact_social_profiles")
            .select()
            .eq("user_id", value: userId.uuidString)
            .order("sort_order", ascending: true)
            .execute()
            .value
    }

    private func fetchAllInstantMessages(userId: UUID) async throws -> [ContactInstantMessage] {
        try await supabase.client
            .from("contact_instant_messages")
            .select()
            .eq("user_id", value: userId.uuidString)
            .order("sort_order", ascending: true)
            .execute()
            .value
    }

    private func fetchAllRelatedNames(userId: UUID) async throws -> [ContactRelatedName] {
        try await supabase.client
            .from("contact_related_names")
            .select()
            .eq("user_id", value: userId.uuidString)
            .order("sort_order", ascending: true)
            .execute()
            .value
    }

    private func fetchAllCustomFields(userId: UUID) async throws -> [ContactCustomField] {
        try await supabase.client
            .from("contact_custom_fields")
            .select()
            .eq("user_id", value: userId.uuidString)
            .order("sort_order", ascending: true)
            .execute()
            .value
    }

    private func fetchAllGroupMembers(userId: UUID) async throws -> [ContactGroupMember] {
        try await supabase.client
            .from("contact_group_members")
            .select()
            .eq("user_id", value: userId.uuidString)
            .execute()
            .value
    }

    // MARK: - Search

    /// Search contacts using the database function
    func searchContacts(query: String, limit: Int = 20) async throws -> [ContactSearchResult] {
        guard let userId = supabase.currentUser?.id else {
            throw ContactsError.authRequired
        }

        do {
            // Use typed struct for proper encoding
            let params = SearchContactsParams(
                p_user_id: userId.uuidString,
                p_search_term: query,
                p_limit: limit
            )
            let response = try await supabase.client
                .rpc("search_contacts", params: params)
                .execute()

            // NOTE: no `.convertFromSnakeCase` here — ContactSearchResult declares
            // explicit snake_case CodingKeys, and the key strategy would rewrite the
            // incoming keys out from under them (silently nil-ing every mapped field).
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601

            let results = try decoder.decode([ContactSearchResult].self, from: response.data)

            return results

        } catch {
            print("❌ ContactsService: Search failed: \(error)")
            throw error
        }
    }

    // MARK: - Groups

    /// Fetch all groups
    @discardableResult
    func fetchGroups() async throws -> [ContactGroup] {
        guard let userId = supabase.currentUser?.id else {
            throw ContactsError.authRequired
        }

        do {
            let result: [ContactGroup] = try await supabase.client
                .from("contact_groups")
                .select()
                .eq("user_id", value: userId.uuidString)
                .order("sort_order", ascending: true)
                .execute()
                .value

            // Get member counts
            let memberCounts = try await fetchGroupMemberCounts(userId: userId)

            let groupsWithCounts = result.map { group -> ContactGroup in
                var g = group
                g.memberCount = memberCounts[group.id] ?? 0
                return g
            }

            await MainActor.run {
                self.groups = groupsWithCounts
            }

            print("📇 ContactsService: Fetched \(groupsWithCounts.count) groups")
            return groupsWithCounts

        } catch {
            print("❌ ContactsService: Failed to fetch groups: \(error)")
            throw error
        }
    }

    private func fetchGroupMemberCounts(userId: UUID) async throws -> [UUID: Int] {
        struct GroupCount: Codable {
            let groupId: UUID
            let count: Int

            enum CodingKeys: String, CodingKey {
                case groupId = "group_id"
                case count
            }
        }

        // This would need a custom RPC or we count client-side
        let members: [ContactGroupMember] = try await supabase.client
            .from("contact_group_members")
            .select()
            .eq("user_id", value: userId.uuidString)
            .execute()
            .value

        var counts: [UUID: Int] = [:]
        for member in members {
            counts[member.groupId, default: 0] += 1
        }
        return counts
    }
}

// MARK: - RPC Parameter DTOs

/// Parameters for the search_contacts database function
private struct SearchContactsParams: Encodable {
    let p_user_id: String
    let p_search_term: String
    let p_limit: Int
}

// MARK: - Insert DTOs (for Supabase insert operations)

/// Insert payload for `contacts`. `workspace_id` is NOT NULL in the DB.
/// The `contact_*` child tables do NOT have a workspace_id column (verified
/// against live schema 2026-09-11) — only `contacts` and `contact_groups` do.
private struct ContactBase: Codable {
    let userId: UUID
    let workspaceId: UUID
    var appleContactId: String?
    var firstName: String?
    var lastName: String?
    var middleName: String?
    var prefix: String?
    var suffix: String?
    var nickname: String?
    var phoneticFirstName: String?
    var phoneticLastName: String?
    var maidenName: String?
    var company: String?
    var department: String?
    var jobTitle: String?
    var phoneticCompany: String?
    var pronouns: String?
    var birthday: Date?
    var notes: String?
    var imageUrl: String?
    var isFavorite: Bool

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case workspaceId = "workspace_id"
        case appleContactId = "apple_contact_id"
        case firstName = "first_name"
        case lastName = "last_name"
        case middleName = "middle_name"
        case prefix
        case suffix
        case nickname
        case phoneticFirstName = "phonetic_first_name"
        case phoneticLastName = "phonetic_last_name"
        case maidenName = "maiden_name"
        case company
        case department
        case jobTitle = "job_title"
        case phoneticCompany = "phonetic_company"
        case pronouns
        case birthday
        case notes
        case imageUrl = "image_url"
        case isFavorite = "is_favorite"
    }
}

private struct ContactPhoneInsert: Codable {
    let contactId: UUID
    let userId: UUID
    let label: String
    let customLabel: String?
    let phoneNumber: String
    let isPrimary: Bool
    let sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case contactId = "contact_id"
        case userId = "user_id"
        case label
        case customLabel = "custom_label"
        case phoneNumber = "phone_number"
        case isPrimary = "is_primary"
        case sortOrder = "sort_order"
    }
}

private struct ContactEmailInsert: Codable {
    let contactId: UUID
    let userId: UUID
    let label: String
    let customLabel: String?
    let email: String
    let isPrimary: Bool
    let sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case contactId = "contact_id"
        case userId = "user_id"
        case label
        case customLabel = "custom_label"
        case email
        case isPrimary = "is_primary"
        case sortOrder = "sort_order"
    }
}

private struct ContactAddressInsert: Codable {
    let contactId: UUID
    let userId: UUID
    let label: String
    let customLabel: String?
    let street: String?
    let city: String?
    let state: String?
    let postalCode: String?
    let country: String?
    let isPrimary: Bool
    let sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case contactId = "contact_id"
        case userId = "user_id"
        case label
        case customLabel = "custom_label"
        case street
        case city
        case state
        case postalCode = "postal_code"
        case country
        case isPrimary = "is_primary"
        case sortOrder = "sort_order"
    }
}

private struct ContactURLInsert: Codable {
    let contactId: UUID
    let userId: UUID
    let label: String
    let customLabel: String?
    let url: String
    let sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case contactId = "contact_id"
        case userId = "user_id"
        case label
        case customLabel = "custom_label"
        case url
        case sortOrder = "sort_order"
    }
}

private struct ContactDateInsert: Codable {
    let contactId: UUID
    let userId: UUID
    let label: String
    let customLabel: String?
    let date: Date
    let sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case contactId = "contact_id"
        case userId = "user_id"
        case label
        case customLabel = "custom_label"
        case date
        case sortOrder = "sort_order"
    }
}

private struct ContactSocialProfileInsert: Codable {
    let contactId: UUID
    let userId: UUID
    let service: String
    let username: String?
    let url: String?
    let sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case contactId = "contact_id"
        case userId = "user_id"
        case service
        case username
        case url
        case sortOrder = "sort_order"
    }
}

private struct ContactInstantMessageInsert: Codable {
    let contactId: UUID
    let userId: UUID
    let service: String
    let username: String
    let sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case contactId = "contact_id"
        case userId = "user_id"
        case service
        case username
        case sortOrder = "sort_order"
    }
}

private struct ContactRelatedNameInsert: Codable {
    let contactId: UUID
    let userId: UUID
    let label: String
    let customLabel: String?
    let name: String
    let relatedContactId: UUID?
    let sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case contactId = "contact_id"
        case userId = "user_id"
        case label
        case customLabel = "custom_label"
        case name
        case relatedContactId = "related_contact_id"
        case sortOrder = "sort_order"
    }
}

private struct ContactCustomFieldInsert: Codable {
    let contactId: UUID
    let userId: UUID
    let fieldType: String
    let label: String
    let value: String?
    let sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case contactId = "contact_id"
        case userId = "user_id"
        case fieldType = "field_type"
        case label
        case value
        case sortOrder = "sort_order"
    }
}

/// Insert payload for `contact_groups`. `workspace_id` is NOT NULL in the DB.
private struct ContactGroupInsert: Codable {
    let userId: UUID
    let workspaceId: UUID
    let name: String
    let description: String?
    let color: String
    let icon: String

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case workspaceId = "workspace_id"
        case name
        case description
        case color
        case icon
    }
}

private struct ContactGroupMemberInsert: Codable {
    let groupId: UUID
    let contactId: UUID
    let userId: UUID

    enum CodingKeys: String, CodingKey {
        case groupId = "group_id"
        case contactId = "contact_id"
        case userId = "user_id"
    }
}

// MARK: - Notification Names

extension Notification.Name {
    static let contactCreated = Notification.Name("contactCreated")
    static let contactUpdated = Notification.Name("contactUpdated")
    static let contactDeleted = Notification.Name("contactDeleted")
    static let contactsDeleted = Notification.Name("contactsDeleted")
}
