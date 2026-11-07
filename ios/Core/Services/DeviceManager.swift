//
//  DeviceManager.swift
//  dial8
//
//  Manages unique device identification using Keychain for persistence
//

import Foundation
import Security
import UIKit

class DeviceManager: ObservableObject {
    static let shared = DeviceManager()

    @Published private(set) var deviceId: String = ""

    // Keychain configuration
    private let keychainService = "com.dial8.app"
    private let keychainAccount = "deviceId"

    private init() {
        self.deviceId = getOrCreateDeviceId()
        print("📱 DeviceManager: Initialized with device ID: \(deviceId)")
    }

    // MARK: - Device ID Management

    private func getOrCreateDeviceId() -> String {
        // Try to get existing device ID from Keychain
        if let existingId = getDeviceIdFromKeychain() {
            print("📱 DeviceManager: Found existing device ID in Keychain")
            return existingId
        }

        // Generate new device ID
        let newId = generateDeviceId()

        // Save to Keychain
        if saveDeviceIdToKeychain(newId) {
            print("📱 DeviceManager: Created and saved new device ID")
        } else {
            print("⚠️ DeviceManager: Failed to save device ID to Keychain")
        }

        return newId
    }

    private func generateDeviceId() -> String {
        // Create a unique identifier combining multiple factors
        let uuid = UUID().uuidString
        let timestamp = String(Int(Date().timeIntervalSince1970))

        // Get hardware UUID if available
        let hardwareUUID = getHardwareUUID() ?? "no-hardware-id"

        // Combine and hash for a unique, consistent ID
        let combined = "\(hardwareUUID)-\(uuid)-\(timestamp)"

        // Create a shorter, URL-safe ID
        let data = combined.data(using: .utf8)!
        let hash = data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
            .prefix(22) // Keep it reasonably short

        return "dial8_\(hash)"
    }

    private func getHardwareUUID() -> String? {
        // On iOS, use identifierForVendor
        return UIDevice.current.identifierForVendor?.uuidString
    }

    // MARK: - Keychain Operations

    private func getDeviceIdFromKeychain() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let deviceId = String(data: data, encoding: .utf8) else {
            return nil
        }

        return deviceId
    }

    private func saveDeviceIdToKeychain(_ deviceId: String) -> Bool {
        guard let data = deviceId.data(using: .utf8) else { return false }

        // First, try to delete any existing item
        deleteDeviceIdFromKeychain()

        // Add new item
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    private func deleteDeviceIdFromKeychain() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount
        ]

        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Device Information

    func getDeviceInfo() -> DeviceInfo {
        return DeviceInfo.current
    }
}

// MARK: - Device Info

struct DeviceInfo: Codable {
    let deviceId: String
    let model: String
    let osVersion: String
    let appVersion: String

    static var current: DeviceInfo {
        DeviceInfo(
            deviceId: DeviceManager.shared.deviceId,
            model: getCurrentDeviceModel(),
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "Unknown"
        )
    }

    private static func getCurrentDeviceModel() -> String {
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        var model = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.model", &model, &size, nil, 0)
        return String(cString: model)
    }
}
