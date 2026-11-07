import SwiftUI

struct iOSContactDetailView: View {
    let contact: Contact

    var body: some View {
        List {
            // Header
            Section {
                VStack(spacing: 12) {
                    ZStack {
                        Circle()
                            .fill(.blue.opacity(0.15))
                        Text(initials)
                            .font(.title.bold())
                            .foregroundStyle(.blue)
                    }
                    .frame(width: 80, height: 80)

                    Text(contact.displayName)
                        .font(.title2.bold())

                    if let company = contact.company, !company.isEmpty {
                        Text(contact.jobTitle != nil ? "\(contact.jobTitle!) at \(company)" : company)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }

            // Phone numbers
            if !contact.phones.isEmpty {
                Section("Phone") {
                    ForEach(contact.phones, id: \.id) { phone in
                        Link(destination: URL(string: "tel:\(phone.phoneNumber)")!) {
                            LabeledContent(phone.label) {
                                Text(phone.phoneNumber)
                                    .foregroundStyle(.blue)
                            }
                        }
                    }
                }
            }

            // Emails
            if !contact.emails.isEmpty {
                Section("Email") {
                    ForEach(contact.emails, id: \.id) { email in
                        Link(destination: URL(string: "mailto:\(email.email)")!) {
                            LabeledContent(email.label) {
                                Text(email.email)
                                    .foregroundStyle(.blue)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
            }

            // Addresses
            if !contact.addresses.isEmpty {
                Section("Address") {
                    ForEach(contact.addresses, id: \.id) { address in
                        VStack(alignment: .leading, spacing: 2) {
                            if let street = address.street, !street.isEmpty {
                                Text(street)
                            }
                            HStack {
                                if let city = address.city { Text(city) }
                                if let state = address.state { Text(state) }
                                if let postalCode = address.postalCode { Text(postalCode) }
                            }
                            if let country = address.country, !country.isEmpty {
                                Text(country)
                            }
                        }
                        .font(.subheadline)
                    }
                }
            }

            // Notes
            if let notes = contact.notes, !notes.isEmpty {
                Section("Notes") {
                    Text(notes)
                        .font(.body)
                }
            }

            // Details
            Section("Details") {
                if let birthday = contact.birthday {
                    LabeledContent("Birthday", value: birthday.formatted(date: .long, time: .omitted))
                }
                LabeledContent("Added", value: contact.createdAt.formatted(date: .abbreviated, time: .omitted))
                LabeledContent("Updated", value: contact.updatedAt.formatted(date: .abbreviated, time: .omitted))
            }
        }
        .navigationTitle("Contact")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var initials: String {
        let first = (contact.firstName ?? "").prefix(1)
        let last = (contact.lastName ?? "").prefix(1)
        let result = "\(first)\(last)".uppercased()
        return result.isEmpty ? "?" : result
    }
}
