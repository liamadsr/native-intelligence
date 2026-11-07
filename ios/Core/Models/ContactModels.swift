//
//  ContactModels.swift
//  dial8
//
//  Core models for CRM/Contacts system
//

import Foundation

// MARK: - Phone Label

enum PhoneLabel: String, Codable, CaseIterable {
    case mobile
    case iPhone
    case home
    case work
    case main
    case other
    case custom

    var displayName: String {
        switch self {
        case .mobile: return "Mobile"
        case .iPhone: return "iPhone"
        case .home: return "Home"
        case .work: return "Work"
        case .main: return "Main"
        case .other: return "Other"
        case .custom: return "Custom"
        }
    }

    static func fromAppleLabel(_ label: String?) -> PhoneLabel {
        guard let label = label?.lowercased() else { return .other }
        switch label {
        case let l where l.contains("mobile"): return .mobile
        case let l where l.contains("iphone"): return .iPhone
        case let l where l.contains("home"): return .home
        case let l where l.contains("work"): return .work
        case let l where l.contains("main"): return .main
        default: return .other
        }
    }
}

// MARK: - Email Label

enum EmailLabel: String, Codable, CaseIterable {
    case home
    case work
    case school
    case iCloud
    case other
    case custom

    var displayName: String {
        switch self {
        case .home: return "Home"
        case .work: return "Work"
        case .school: return "School"
        case .iCloud: return "iCloud"
        case .other: return "Other"
        case .custom: return "Custom"
        }
    }

    static func fromAppleLabel(_ label: String?) -> EmailLabel {
        guard let label = label?.lowercased() else { return .other }
        switch label {
        case let l where l.contains("home"): return .home
        case let l where l.contains("work"): return .work
        case let l where l.contains("school"): return .school
        case let l where l.contains("icloud"): return .iCloud
        default: return .other
        }
    }
}

// MARK: - Address Label

enum AddressLabel: String, Codable, CaseIterable {
    case home
    case work
    case other
    case custom

    var displayName: String {
        switch self {
        case .home: return "Home"
        case .work: return "Work"
        case .other: return "Other"
        case .custom: return "Custom"
        }
    }

    static func fromAppleLabel(_ label: String?) -> AddressLabel {
        guard let label = label?.lowercased() else { return .other }
        switch label {
        case let l where l.contains("home"): return .home
        case let l where l.contains("work"): return .work
        default: return .other
        }
    }
}

// MARK: - URL Label

enum URLLabel: String, Codable, CaseIterable {
    case homepage
    case home
    case work
    case other
    case custom

    var displayName: String {
        switch self {
        case .homepage: return "Home Page"
        case .home: return "Home"
        case .work: return "Work"
        case .other: return "Other"
        case .custom: return "Custom"
        }
    }

    static func fromAppleLabel(_ label: String?) -> URLLabel {
        guard let label = label?.lowercased() else { return .other }
        switch label {
        case let l where l.contains("homepage"): return .homepage
        case let l where l.contains("home"): return .home
        case let l where l.contains("work"): return .work
        default: return .other
        }
    }
}

// MARK: - Date Label

enum DateLabel: String, Codable, CaseIterable {
    case anniversary
    case other
    case custom

    var displayName: String {
        switch self {
        case .anniversary: return "Anniversary"
        case .other: return "Other"
        case .custom: return "Custom"
        }
    }
}

// MARK: - Related Name Label

enum RelatedNameLabel: String, Codable, CaseIterable {
    case spouse
    case child
    case parent
    case sibling
    case friend
    case assistant
    case manager
    case partner
    case other
    case custom

    var displayName: String {
        switch self {
        case .spouse: return "Spouse"
        case .child: return "Child"
        case .parent: return "Parent"
        case .sibling: return "Sibling"
        case .friend: return "Friend"
        case .assistant: return "Assistant"
        case .manager: return "Manager"
        case .partner: return "Partner"
        case .other: return "Other"
        case .custom: return "Custom"
        }
    }

    static func fromAppleLabel(_ label: String?) -> RelatedNameLabel {
        guard let label = label?.lowercased() else { return .other }
        switch label {
        case let l where l.contains("spouse") || l.contains("wife") || l.contains("husband"): return .spouse
        case let l where l.contains("child") || l.contains("son") || l.contains("daughter"): return .child
        case let l where l.contains("parent") || l.contains("mother") || l.contains("father"): return .parent
        case let l where l.contains("sibling") || l.contains("brother") || l.contains("sister"): return .sibling
        case let l where l.contains("friend"): return .friend
        case let l where l.contains("assistant"): return .assistant
        case let l where l.contains("manager"): return .manager
        case let l where l.contains("partner"): return .partner
        default: return .other
        }
    }
}

// MARK: - Social Profile Service

enum SocialProfileService: String, Codable, CaseIterable {
    case twitter
    case linkedin
    case facebook
    case instagram
    case github
    case youtube
    case tiktok
    case snapchat
    case pinterest
    case other

    var displayName: String {
        switch self {
        case .twitter: return "Twitter/X"
        case .linkedin: return "LinkedIn"
        case .facebook: return "Facebook"
        case .instagram: return "Instagram"
        case .github: return "GitHub"
        case .youtube: return "YouTube"
        case .tiktok: return "TikTok"
        case .snapchat: return "Snapchat"
        case .pinterest: return "Pinterest"
        case .other: return "Other"
        }
    }

    var icon: String {
        switch self {
        case .twitter: return "bird"
        case .linkedin: return "link"
        case .facebook: return "f.square"
        case .instagram: return "camera"
        case .github: return "chevron.left.forwardslash.chevron.right"
        case .youtube: return "play.rectangle"
        case .tiktok: return "music.note"
        case .snapchat: return "camera.viewfinder"
        case .pinterest: return "pin"
        case .other: return "globe"
        }
    }

    static func fromString(_ service: String?) -> SocialProfileService {
        guard let service = service?.lowercased() else { return .other }
        switch service {
        case let s where s.contains("twitter") || s.contains("x.com"): return .twitter
        case let s where s.contains("linkedin"): return .linkedin
        case let s where s.contains("facebook"): return .facebook
        case let s where s.contains("instagram"): return .instagram
        case let s where s.contains("github"): return .github
        case let s where s.contains("youtube"): return .youtube
        case let s where s.contains("tiktok"): return .tiktok
        case let s where s.contains("snapchat"): return .snapchat
        case let s where s.contains("pinterest"): return .pinterest
        default: return .other
        }
    }
}

// MARK: - Instant Message Service

enum InstantMessageService: String, Codable, CaseIterable {
    case jabber
    case skype
    case discord
    case slack
    case telegram
    case whatsapp
    case signal
    case teams
    case zoom
    case other

    var displayName: String {
        switch self {
        case .jabber: return "Jabber"
        case .skype: return "Skype"
        case .discord: return "Discord"
        case .slack: return "Slack"
        case .telegram: return "Telegram"
        case .whatsapp: return "WhatsApp"
        case .signal: return "Signal"
        case .teams: return "Microsoft Teams"
        case .zoom: return "Zoom"
        case .other: return "Other"
        }
    }

    static func fromString(_ service: String?) -> InstantMessageService {
        guard let service = service?.lowercased() else { return .other }
        switch service {
        case let s where s.contains("jabber"): return .jabber
        case let s where s.contains("skype"): return .skype
        case let s where s.contains("discord"): return .discord
        case let s where s.contains("slack"): return .slack
        case let s where s.contains("telegram"): return .telegram
        case let s where s.contains("whatsapp"): return .whatsapp
        case let s where s.contains("signal"): return .signal
        case let s where s.contains("teams"): return .teams
        case let s where s.contains("zoom"): return .zoom
        default: return .other
        }
    }
}

// MARK: - Custom Field Type

enum CustomFieldType: String, Codable, CaseIterable {
    case text
    case date
    case number
    case url
    case phone
    case email

    var displayName: String {
        switch self {
        case .text: return "Text"
        case .date: return "Date"
        case .number: return "Number"
        case .url: return "URL"
        case .phone: return "Phone"
        case .email: return "Email"
        }
    }

    var icon: String {
        switch self {
        case .text: return "textformat"
        case .date: return "calendar"
        case .number: return "number"
        case .url: return "link"
        case .phone: return "phone"
        case .email: return "envelope"
        }
    }
}

// MARK: - Contact Phone

struct ContactPhone: Codable, Identifiable, Equatable, Hashable {
    var id: UUID
    var contactId: UUID?
    var userId: UUID?
    var label: String
    var customLabel: String?
    var phoneNumber: String
    var isPrimary: Bool
    var sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case id
        case contactId = "contact_id"
        case userId = "user_id"
        case label
        case customLabel = "custom_label"
        case phoneNumber = "phone_number"
        case isPrimary = "is_primary"
        case sortOrder = "sort_order"
    }

    /// `is_primary` and `sort_order` are nullable in `contact_phones`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        contactId = try c.decodeIfPresent(UUID.self, forKey: .contactId)
        userId = try c.decodeIfPresent(UUID.self, forKey: .userId)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? "mobile"
        customLabel = try c.decodeIfPresent(String.self, forKey: .customLabel)
        phoneNumber = try c.decodeIfPresent(String.self, forKey: .phoneNumber) ?? ""
        isPrimary = try c.decodeIfPresent(Bool.self, forKey: .isPrimary) ?? false
        sortOrder = try c.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
    }

    init(
        id: UUID = UUID(),
        contactId: UUID? = nil,
        userId: UUID? = nil,
        label: String = "mobile",
        customLabel: String? = nil,
        phoneNumber: String,
        isPrimary: Bool = false,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.contactId = contactId
        self.userId = userId
        self.label = label
        self.customLabel = customLabel
        self.phoneNumber = phoneNumber
        self.isPrimary = isPrimary
        self.sortOrder = sortOrder
    }

    var displayLabel: String {
        if label == "custom", let custom = customLabel, !custom.isEmpty {
            return custom
        }
        return PhoneLabel(rawValue: label)?.displayName ?? label.capitalized
    }
}

// MARK: - Contact Email

struct ContactEmail: Codable, Identifiable, Equatable, Hashable {
    var id: UUID
    var contactId: UUID?
    var userId: UUID?
    var label: String
    var customLabel: String?
    var email: String
    var isPrimary: Bool
    var sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case id
        case contactId = "contact_id"
        case userId = "user_id"
        case label
        case customLabel = "custom_label"
        case email
        case isPrimary = "is_primary"
        case sortOrder = "sort_order"
    }

    /// `is_primary` and `sort_order` are nullable in `contact_emails`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        contactId = try c.decodeIfPresent(UUID.self, forKey: .contactId)
        userId = try c.decodeIfPresent(UUID.self, forKey: .userId)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? "home"
        customLabel = try c.decodeIfPresent(String.self, forKey: .customLabel)
        email = try c.decodeIfPresent(String.self, forKey: .email) ?? ""
        isPrimary = try c.decodeIfPresent(Bool.self, forKey: .isPrimary) ?? false
        sortOrder = try c.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
    }

    init(
        id: UUID = UUID(),
        contactId: UUID? = nil,
        userId: UUID? = nil,
        label: String = "home",
        customLabel: String? = nil,
        email: String,
        isPrimary: Bool = false,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.contactId = contactId
        self.userId = userId
        self.label = label
        self.customLabel = customLabel
        self.email = email
        self.isPrimary = isPrimary
        self.sortOrder = sortOrder
    }

    var displayLabel: String {
        if label == "custom", let custom = customLabel, !custom.isEmpty {
            return custom
        }
        return EmailLabel(rawValue: label)?.displayName ?? label.capitalized
    }
}

// MARK: - Contact Address

struct ContactAddress: Codable, Identifiable, Equatable, Hashable {
    var id: UUID
    var contactId: UUID?
    var userId: UUID?
    var label: String
    var customLabel: String?
    var street: String?
    var city: String?
    var state: String?
    var postalCode: String?
    var country: String?
    var isPrimary: Bool
    var sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case id
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

    /// `is_primary` and `sort_order` are nullable in `contact_addresses`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        contactId = try c.decodeIfPresent(UUID.self, forKey: .contactId)
        userId = try c.decodeIfPresent(UUID.self, forKey: .userId)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? "home"
        customLabel = try c.decodeIfPresent(String.self, forKey: .customLabel)
        street = try c.decodeIfPresent(String.self, forKey: .street)
        city = try c.decodeIfPresent(String.self, forKey: .city)
        state = try c.decodeIfPresent(String.self, forKey: .state)
        postalCode = try c.decodeIfPresent(String.self, forKey: .postalCode)
        country = try c.decodeIfPresent(String.self, forKey: .country)
        isPrimary = try c.decodeIfPresent(Bool.self, forKey: .isPrimary) ?? false
        sortOrder = try c.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
    }

    init(
        id: UUID = UUID(),
        contactId: UUID? = nil,
        userId: UUID? = nil,
        label: String = "home",
        customLabel: String? = nil,
        street: String? = nil,
        city: String? = nil,
        state: String? = nil,
        postalCode: String? = nil,
        country: String? = nil,
        isPrimary: Bool = false,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.contactId = contactId
        self.userId = userId
        self.label = label
        self.customLabel = customLabel
        self.street = street
        self.city = city
        self.state = state
        self.postalCode = postalCode
        self.country = country
        self.isPrimary = isPrimary
        self.sortOrder = sortOrder
    }

    var displayLabel: String {
        if label == "custom", let custom = customLabel, !custom.isEmpty {
            return custom
        }
        return AddressLabel(rawValue: label)?.displayName ?? label.capitalized
    }

    var formattedAddress: String {
        var parts: [String] = []
        if let street = street, !street.isEmpty { parts.append(street) }
        if let city = city, !city.isEmpty { parts.append(city) }
        if let state = state, !state.isEmpty {
            if let postalCode = postalCode, !postalCode.isEmpty {
                parts.append("\(state) \(postalCode)")
            } else {
                parts.append(state)
            }
        } else if let postalCode = postalCode, !postalCode.isEmpty {
            parts.append(postalCode)
        }
        if let country = country, !country.isEmpty { parts.append(country) }
        return parts.joined(separator: ", ")
    }
}

// MARK: - Contact URL

struct ContactURL: Codable, Identifiable, Equatable, Hashable {
    var id: UUID
    var contactId: UUID?
    var userId: UUID?
    var label: String
    var customLabel: String?
    var url: String
    var sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case id
        case contactId = "contact_id"
        case userId = "user_id"
        case label
        case customLabel = "custom_label"
        case url
        case sortOrder = "sort_order"
    }

    /// `sort_order` is nullable in `contact_urls`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        contactId = try c.decodeIfPresent(UUID.self, forKey: .contactId)
        userId = try c.decodeIfPresent(UUID.self, forKey: .userId)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? "homepage"
        customLabel = try c.decodeIfPresent(String.self, forKey: .customLabel)
        url = try c.decodeIfPresent(String.self, forKey: .url) ?? ""
        sortOrder = try c.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
    }

    init(
        id: UUID = UUID(),
        contactId: UUID? = nil,
        userId: UUID? = nil,
        label: String = "homepage",
        customLabel: String? = nil,
        url: String,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.contactId = contactId
        self.userId = userId
        self.label = label
        self.customLabel = customLabel
        self.url = url
        self.sortOrder = sortOrder
    }

    var displayLabel: String {
        if label == "custom", let custom = customLabel, !custom.isEmpty {
            return custom
        }
        return URLLabel(rawValue: label)?.displayName ?? label.capitalized
    }
}

// MARK: - Contact Date

struct ContactDate: Codable, Identifiable, Equatable, Hashable {
    var id: UUID
    var contactId: UUID?
    var userId: UUID?
    var label: String
    var customLabel: String?
    var date: Date
    var sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case id
        case contactId = "contact_id"
        case userId = "user_id"
        case label
        case customLabel = "custom_label"
        case date
        case sortOrder = "sort_order"
    }

    /// `sort_order` is nullable in `contact_dates`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        contactId = try c.decodeIfPresent(UUID.self, forKey: .contactId)
        userId = try c.decodeIfPresent(UUID.self, forKey: .userId)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? "anniversary"
        customLabel = try c.decodeIfPresent(String.self, forKey: .customLabel)
        // `date` is a bare DATE column; Supabase returns "YYYY-MM-DD"
        if let raw = try? c.decode(Date.self, forKey: .date) {
            date = raw
        } else if let dateString = try c.decodeIfPresent(String.self, forKey: .date) {
            date = Contact.parseDateString(dateString) ?? Date()
        } else {
            date = Date()
        }
        sortOrder = try c.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
    }

    init(
        id: UUID = UUID(),
        contactId: UUID? = nil,
        userId: UUID? = nil,
        label: String = "anniversary",
        customLabel: String? = nil,
        date: Date,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.contactId = contactId
        self.userId = userId
        self.label = label
        self.customLabel = customLabel
        self.date = date
        self.sortOrder = sortOrder
    }

    var displayLabel: String {
        if label == "custom", let custom = customLabel, !custom.isEmpty {
            return custom
        }
        return DateLabel(rawValue: label)?.displayName ?? label.capitalized
    }
}

// MARK: - Contact Social Profile

struct ContactSocialProfile: Codable, Identifiable, Equatable, Hashable {
    var id: UUID
    var contactId: UUID?
    var userId: UUID?
    var service: String
    var username: String?
    var url: String?
    var sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case id
        case contactId = "contact_id"
        case userId = "user_id"
        case service
        case username
        case url
        case sortOrder = "sort_order"
    }

    /// `sort_order` is nullable in `contact_social_profiles`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        contactId = try c.decodeIfPresent(UUID.self, forKey: .contactId)
        userId = try c.decodeIfPresent(UUID.self, forKey: .userId)
        service = try c.decodeIfPresent(String.self, forKey: .service) ?? "other"
        username = try c.decodeIfPresent(String.self, forKey: .username)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        sortOrder = try c.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
    }

    init(
        id: UUID = UUID(),
        contactId: UUID? = nil,
        userId: UUID? = nil,
        service: String,
        username: String? = nil,
        url: String? = nil,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.contactId = contactId
        self.userId = userId
        self.service = service
        self.username = username
        self.url = url
        self.sortOrder = sortOrder
    }

    var displayService: String {
        SocialProfileService.fromString(service).displayName
    }

    var serviceIcon: String {
        SocialProfileService.fromString(service).icon
    }
}

// MARK: - Contact Instant Message

struct ContactInstantMessage: Codable, Identifiable, Equatable, Hashable {
    var id: UUID
    var contactId: UUID?
    var userId: UUID?
    var service: String
    var username: String
    var sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case id
        case contactId = "contact_id"
        case userId = "user_id"
        case service
        case username
        case sortOrder = "sort_order"
    }

    /// `sort_order` is nullable in `contact_instant_messages`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        contactId = try c.decodeIfPresent(UUID.self, forKey: .contactId)
        userId = try c.decodeIfPresent(UUID.self, forKey: .userId)
        service = try c.decodeIfPresent(String.self, forKey: .service) ?? "other"
        username = try c.decodeIfPresent(String.self, forKey: .username) ?? ""
        sortOrder = try c.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
    }

    init(
        id: UUID = UUID(),
        contactId: UUID? = nil,
        userId: UUID? = nil,
        service: String,
        username: String,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.contactId = contactId
        self.userId = userId
        self.service = service
        self.username = username
        self.sortOrder = sortOrder
    }

    var displayService: String {
        InstantMessageService.fromString(service).displayName
    }
}

// MARK: - Contact Related Name

struct ContactRelatedName: Codable, Identifiable, Equatable, Hashable {
    var id: UUID
    var contactId: UUID?
    var userId: UUID?
    var label: String
    var customLabel: String?
    var name: String
    var relatedContactId: UUID?
    var sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case id
        case contactId = "contact_id"
        case userId = "user_id"
        case label
        case customLabel = "custom_label"
        case name
        case relatedContactId = "related_contact_id"
        case sortOrder = "sort_order"
    }

    /// `sort_order` is nullable in `contact_related_names`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        contactId = try c.decodeIfPresent(UUID.self, forKey: .contactId)
        userId = try c.decodeIfPresent(UUID.self, forKey: .userId)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? "friend"
        customLabel = try c.decodeIfPresent(String.self, forKey: .customLabel)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        relatedContactId = try c.decodeIfPresent(UUID.self, forKey: .relatedContactId)
        sortOrder = try c.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
    }

    init(
        id: UUID = UUID(),
        contactId: UUID? = nil,
        userId: UUID? = nil,
        label: String = "friend",
        customLabel: String? = nil,
        name: String,
        relatedContactId: UUID? = nil,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.contactId = contactId
        self.userId = userId
        self.label = label
        self.customLabel = customLabel
        self.name = name
        self.relatedContactId = relatedContactId
        self.sortOrder = sortOrder
    }

    var displayLabel: String {
        if label == "custom", let custom = customLabel, !custom.isEmpty {
            return custom
        }
        return RelatedNameLabel(rawValue: label)?.displayName ?? label.capitalized
    }
}

// MARK: - Contact Custom Field

struct ContactCustomField: Codable, Identifiable, Equatable, Hashable {
    var id: UUID
    var contactId: UUID?
    var userId: UUID?
    var fieldType: String
    var label: String
    var value: String?
    var sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case id
        case contactId = "contact_id"
        case userId = "user_id"
        case fieldType = "field_type"
        case label
        case value
        case sortOrder = "sort_order"
    }

    /// `value` and `sort_order` are nullable in `contact_custom_fields`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        contactId = try c.decodeIfPresent(UUID.self, forKey: .contactId)
        userId = try c.decodeIfPresent(UUID.self, forKey: .userId)
        fieldType = try c.decodeIfPresent(String.self, forKey: .fieldType) ?? "text"
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        value = try c.decodeIfPresent(String.self, forKey: .value)
        sortOrder = try c.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
    }

    init(
        id: UUID = UUID(),
        contactId: UUID? = nil,
        userId: UUID? = nil,
        fieldType: String = "text",
        label: String,
        value: String? = nil,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.contactId = contactId
        self.userId = userId
        self.fieldType = fieldType
        self.label = label
        self.value = value
        self.sortOrder = sortOrder
    }

    var type: CustomFieldType {
        CustomFieldType(rawValue: fieldType) ?? .text
    }
}

// MARK: - Contact Group

struct ContactGroup: Codable, Identifiable, Equatable, Hashable {
    let id: UUID
    let userId: UUID
    var name: String
    var description: String?
    var color: String
    var icon: String
    var isSmartGroup: Bool
    var sortOrder: Int
    let createdAt: Date
    var updatedAt: Date

    // Transient - not stored in database
    var memberCount: Int?

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case name
        case description
        case color
        case icon
        case isSmartGroup = "is_smart_group"
        case sortOrder = "sort_order"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    /// Tolerant decode: `description`, `color`, `icon`, `is_smart_group`,
    /// `sort_order`, `created_at` and `updated_at` are all nullable in
    /// `contact_groups`, so every one of them gets a default.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        userId = try container.decode(UUID.self, forKey: .userId)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? "Untitled Group"
        description = try container.decodeIfPresent(String.self, forKey: .description)
        color = try container.decodeIfPresent(String.self, forKey: .color) ?? "#6366F1"
        icon = try container.decodeIfPresent(String.self, forKey: .icon) ?? "person.2"
        isSmartGroup = try container.decodeIfPresent(Bool.self, forKey: .isSmartGroup) ?? false
        sortOrder = try container.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date()
        memberCount = nil
    }

    init(
        id: UUID = UUID(),
        userId: UUID,
        name: String,
        description: String? = nil,
        color: String = "#6366F1",
        icon: String = "person.2",
        isSmartGroup: Bool = false,
        sortOrder: Int = 0,
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        memberCount: Int? = nil
    ) {
        self.id = id
        self.userId = userId
        self.name = name
        self.description = description
        self.color = color
        self.icon = icon
        self.isSmartGroup = isSmartGroup
        self.sortOrder = sortOrder
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.memberCount = memberCount
    }
}

// MARK: - Contact Group Member

struct ContactGroupMember: Codable, Identifiable, Equatable {
    let id: UUID
    let groupId: UUID
    let contactId: UUID
    let userId: UUID
    /// `contact_group_members.added_at` is nullable in the DB.
    let addedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case groupId = "group_id"
        case contactId = "contact_id"
        case userId = "user_id"
        case addedAt = "added_at"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        groupId = try container.decode(UUID.self, forKey: .groupId)
        contactId = try container.decode(UUID.self, forKey: .contactId)
        userId = try container.decode(UUID.self, forKey: .userId)
        addedAt = try container.decodeIfPresent(Date.self, forKey: .addedAt) ?? Date()
    }

    init(id: UUID = UUID(), groupId: UUID, contactId: UUID, userId: UUID, addedAt: Date = Date()) {
        self.id = id
        self.groupId = groupId
        self.contactId = contactId
        self.userId = userId
        self.addedAt = addedAt
    }
}

// MARK: - Main Contact Model

struct Contact: Codable, Identifiable, Equatable {
    let id: UUID
    let userId: UUID
    var appleContactId: String?

    // Name fields
    var firstName: String?
    var lastName: String?
    var middleName: String?
    var prefix: String?
    var suffix: String?
    var nickname: String?
    var phoneticFirstName: String?
    var phoneticLastName: String?
    var maidenName: String?

    // Organization
    var company: String?
    var department: String?
    var jobTitle: String?
    var phoneticCompany: String?

    // Other
    var pronouns: String?
    var birthday: Date?
    var notes: String?
    var imageUrl: String?

    // Metadata
    var isFavorite: Bool
    var lastSyncedAt: Date?
    let createdAt: Date
    var updatedAt: Date

    // Nested data (populated from joins)
    var phones: [ContactPhone]
    var emails: [ContactEmail]
    var addresses: [ContactAddress]
    var urls: [ContactURL]
    var dates: [ContactDate]
    var socialProfiles: [ContactSocialProfile]
    var instantMessages: [ContactInstantMessage]
    var relatedNames: [ContactRelatedName]
    var customFields: [ContactCustomField]
    var groups: [ContactGroup]

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
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
        case lastSyncedAt = "last_synced_at"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case phones
        case emails
        case addresses
        case urls
        case dates
        case socialProfiles = "social_profiles"
        case instantMessages = "instant_messages"
        case relatedNames = "related_names"
        case customFields = "custom_fields"
        case groups
    }

    init(
        id: UUID = UUID(),
        userId: UUID,
        appleContactId: String? = nil,
        firstName: String? = nil,
        lastName: String? = nil,
        middleName: String? = nil,
        prefix: String? = nil,
        suffix: String? = nil,
        nickname: String? = nil,
        phoneticFirstName: String? = nil,
        phoneticLastName: String? = nil,
        maidenName: String? = nil,
        company: String? = nil,
        department: String? = nil,
        jobTitle: String? = nil,
        phoneticCompany: String? = nil,
        pronouns: String? = nil,
        birthday: Date? = nil,
        notes: String? = nil,
        imageUrl: String? = nil,
        isFavorite: Bool = false,
        lastSyncedAt: Date? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        phones: [ContactPhone] = [],
        emails: [ContactEmail] = [],
        addresses: [ContactAddress] = [],
        urls: [ContactURL] = [],
        dates: [ContactDate] = [],
        socialProfiles: [ContactSocialProfile] = [],
        instantMessages: [ContactInstantMessage] = [],
        relatedNames: [ContactRelatedName] = [],
        customFields: [ContactCustomField] = [],
        groups: [ContactGroup] = []
    ) {
        self.id = id
        self.userId = userId
        self.appleContactId = appleContactId
        self.firstName = firstName
        self.lastName = lastName
        self.middleName = middleName
        self.prefix = prefix
        self.suffix = suffix
        self.nickname = nickname
        self.phoneticFirstName = phoneticFirstName
        self.phoneticLastName = phoneticLastName
        self.maidenName = maidenName
        self.company = company
        self.department = department
        self.jobTitle = jobTitle
        self.phoneticCompany = phoneticCompany
        self.pronouns = pronouns
        self.birthday = birthday
        self.notes = notes
        self.imageUrl = imageUrl
        self.isFavorite = isFavorite
        self.lastSyncedAt = lastSyncedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.phones = phones
        self.emails = emails
        self.addresses = addresses
        self.urls = urls
        self.dates = dates
        self.socialProfiles = socialProfiles
        self.instantMessages = instantMessages
        self.relatedNames = relatedNames
        self.customFields = customFields
        self.groups = groups
    }

    // MARK: - Custom Decoder

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decode(UUID.self, forKey: .id)
        userId = try container.decode(UUID.self, forKey: .userId)
        appleContactId = try container.decodeIfPresent(String.self, forKey: .appleContactId)
        firstName = try container.decodeIfPresent(String.self, forKey: .firstName)
        lastName = try container.decodeIfPresent(String.self, forKey: .lastName)
        middleName = try container.decodeIfPresent(String.self, forKey: .middleName)
        prefix = try container.decodeIfPresent(String.self, forKey: .prefix)
        suffix = try container.decodeIfPresent(String.self, forKey: .suffix)
        nickname = try container.decodeIfPresent(String.self, forKey: .nickname)
        phoneticFirstName = try container.decodeIfPresent(String.self, forKey: .phoneticFirstName)
        phoneticLastName = try container.decodeIfPresent(String.self, forKey: .phoneticLastName)
        maidenName = try container.decodeIfPresent(String.self, forKey: .maidenName)
        company = try container.decodeIfPresent(String.self, forKey: .company)
        department = try container.decodeIfPresent(String.self, forKey: .department)
        jobTitle = try container.decodeIfPresent(String.self, forKey: .jobTitle)
        phoneticCompany = try container.decodeIfPresent(String.self, forKey: .phoneticCompany)
        pronouns = try container.decodeIfPresent(String.self, forKey: .pronouns)
        notes = try container.decodeIfPresent(String.self, forKey: .notes)
        imageUrl = try container.decodeIfPresent(String.self, forKey: .imageUrl)
        isFavorite = try container.decodeIfPresent(Bool.self, forKey: .isFavorite) ?? false

        // Decode birthday with flexible date parsing
        if let birthdayString = try container.decodeIfPresent(String.self, forKey: .birthday) {
            birthday = Contact.parseDateString(birthdayString)
        } else {
            birthday = nil
        }

        // Decode timestamps with flexible parsing
        if let syncString = try container.decodeIfPresent(String.self, forKey: .lastSyncedAt) {
            lastSyncedAt = Contact.parseTimestampString(syncString)
        } else {
            lastSyncedAt = nil
        }

        if let createdString = try container.decodeIfPresent(String.self, forKey: .createdAt) {
            createdAt = Contact.parseTimestampString(createdString) ?? Date()
        } else {
            createdAt = Date()
        }

        if let updatedString = try container.decodeIfPresent(String.self, forKey: .updatedAt) {
            updatedAt = Contact.parseTimestampString(updatedString) ?? Date()
        } else {
            updatedAt = Date()
        }

        // Decode arrays with defaults for missing keys
        phones = try container.decodeIfPresent([ContactPhone].self, forKey: .phones) ?? []
        emails = try container.decodeIfPresent([ContactEmail].self, forKey: .emails) ?? []
        addresses = try container.decodeIfPresent([ContactAddress].self, forKey: .addresses) ?? []
        urls = try container.decodeIfPresent([ContactURL].self, forKey: .urls) ?? []
        dates = try container.decodeIfPresent([ContactDate].self, forKey: .dates) ?? []
        socialProfiles = try container.decodeIfPresent([ContactSocialProfile].self, forKey: .socialProfiles) ?? []
        instantMessages = try container.decodeIfPresent([ContactInstantMessage].self, forKey: .instantMessages) ?? []
        relatedNames = try container.decodeIfPresent([ContactRelatedName].self, forKey: .relatedNames) ?? []
        customFields = try container.decodeIfPresent([ContactCustomField].self, forKey: .customFields) ?? []
        groups = try container.decodeIfPresent([ContactGroup].self, forKey: .groups) ?? []
    }

    // Date parsing helpers (fileprivate so the child models can reuse them)
    fileprivate static func parseDateString(_ string: String) -> Date? {
        // Try date-only format first (YYYY-MM-DD)
        let dateOnlyFormatter = DateFormatter()
        dateOnlyFormatter.dateFormat = "yyyy-MM-dd"
        if let date = dateOnlyFormatter.date(from: string) {
            return date
        }

        // Try ISO8601 formats
        let iso8601Formatter = ISO8601DateFormatter()
        iso8601Formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = iso8601Formatter.date(from: string) {
            return date
        }

        iso8601Formatter.formatOptions = [.withInternetDateTime]
        return iso8601Formatter.date(from: string)
    }

    private static func parseTimestampString(_ string: String) -> Date? {
        // Try ISO8601 with fractional seconds
        let iso8601Formatter = ISO8601DateFormatter()
        iso8601Formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = iso8601Formatter.date(from: string) {
            return date
        }

        // Try ISO8601 without fractional seconds
        iso8601Formatter.formatOptions = [.withInternetDateTime]
        if let date = iso8601Formatter.date(from: string) {
            return date
        }

        // Try date-only format
        let dateOnlyFormatter = DateFormatter()
        dateOnlyFormatter.dateFormat = "yyyy-MM-dd"
        return dateOnlyFormatter.date(from: string)
    }

    // MARK: - Computed Properties

    var displayName: String {
        var parts: [String] = []
        if let prefix = prefix, !prefix.isEmpty { parts.append(prefix) }
        if let firstName = firstName, !firstName.isEmpty { parts.append(firstName) }
        if let middleName = middleName, !middleName.isEmpty { parts.append(middleName) }
        if let lastName = lastName, !lastName.isEmpty { parts.append(lastName) }
        if let suffix = suffix, !suffix.isEmpty { parts.append(suffix) }

        let fullName = parts.joined(separator: " ")
        if !fullName.isEmpty { return fullName }

        // Fall back to nickname or company
        if let nickname = nickname, !nickname.isEmpty { return nickname }
        if let company = company, !company.isEmpty { return company }

        // Fall back to email
        if let email = primaryEmail { return email }

        return "No Name"
    }

    var shortName: String {
        if let firstName = firstName, !firstName.isEmpty { return firstName }
        if let nickname = nickname, !nickname.isEmpty { return nickname }
        if let lastName = lastName, !lastName.isEmpty { return lastName }
        return displayName
    }

    var initials: String {
        var chars: [Character] = []
        if let first = firstName?.first { chars.append(first) }
        if let last = lastName?.first { chars.append(last) }
        if chars.isEmpty, let nickname = nickname?.first { chars.append(nickname) }
        if chars.isEmpty, let company = company?.first { chars.append(company) }
        return String(chars).uppercased()
    }

    var primaryEmail: String? {
        emails.first(where: { $0.isPrimary })?.email ?? emails.first?.email
    }

    var primaryPhone: String? {
        phones.first(where: { $0.isPrimary })?.phoneNumber ?? phones.first?.phoneNumber
    }

    var workEmail: String? {
        emails.first(where: { $0.label == "work" })?.email
    }

    var personalEmail: String? {
        emails.first(where: { $0.label == "home" || $0.label == "iCloud" })?.email
    }

    var subtitle: String {
        if let jobTitle = jobTitle, let company = company {
            return "\(jobTitle) at \(company)"
        }
        if let jobTitle = jobTitle { return jobTitle }
        if let company = company { return company }
        if let email = primaryEmail { return email }
        return ""
    }

    var sortKey: String {
        let lastName = self.lastName ?? ""
        let firstName = self.firstName ?? ""
        let company = self.company ?? ""
        return "\(lastName)\(firstName)\(company)".lowercased()
    }

    static func == (lhs: Contact, rhs: Contact) -> Bool {
        lhs.id == rhs.id
    }
}

// MARK: - Contact Search Result

struct ContactSearchResult: Codable, Identifiable {
    let id: UUID
    let firstName: String?
    let lastName: String?
    let nickname: String?
    let company: String?
    let jobTitle: String?
    let imageUrl: String?
    let isFavorite: Bool
    let primaryEmail: String?
    let primaryPhone: String?
    let relevance: Float

    enum CodingKeys: String, CodingKey {
        case id
        case firstName = "first_name"
        case lastName = "last_name"
        case nickname
        case company
        case jobTitle = "job_title"
        case imageUrl = "image_url"
        case isFavorite = "is_favorite"
        case primaryEmail = "primary_email"
        case primaryPhone = "primary_phone"
        case relevance
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        firstName = try container.decodeIfPresent(String.self, forKey: .firstName)
        lastName = try container.decodeIfPresent(String.self, forKey: .lastName)
        nickname = try container.decodeIfPresent(String.self, forKey: .nickname)
        company = try container.decodeIfPresent(String.self, forKey: .company)
        jobTitle = try container.decodeIfPresent(String.self, forKey: .jobTitle)
        imageUrl = try container.decodeIfPresent(String.self, forKey: .imageUrl)
        // Handle NULL is_favorite from database by defaulting to false
        isFavorite = try container.decodeIfPresent(Bool.self, forKey: .isFavorite) ?? false
        primaryEmail = try container.decodeIfPresent(String.self, forKey: .primaryEmail)
        primaryPhone = try container.decodeIfPresent(String.self, forKey: .primaryPhone)
        relevance = try container.decode(Float.self, forKey: .relevance)
    }

    var displayName: String {
        var parts: [String] = []
        if let firstName = firstName, !firstName.isEmpty { parts.append(firstName) }
        if let lastName = lastName, !lastName.isEmpty { parts.append(lastName) }
        if !parts.isEmpty { return parts.joined(separator: " ") }
        if let nickname = nickname, !nickname.isEmpty { return nickname }
        if let company = company, !company.isEmpty { return company }
        return "No Name"
    }

    var initials: String {
        var chars: [Character] = []
        if let first = firstName?.first { chars.append(first) }
        if let last = lastName?.first { chars.append(last) }
        if chars.isEmpty, let nickname = nickname?.first { chars.append(nickname) }
        return String(chars).uppercased()
    }
}
