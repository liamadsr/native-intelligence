import SwiftUI

/// Pushed from Home's header (the phone button). It deliberately does NOT wrap
/// itself in a `NavigationStack`: nesting one inside the pushing stack swallows
/// the back button and strands the user on this screen.
struct iOSContactsTab: View {
    @StateObject private var contactsService = ContactsService.shared
    @State private var searchText = ""

    var body: some View {
        Group {
            if contactsService.isLoading && contactsService.contacts.isEmpty {
                ProgressView("Loading contacts...")
            } else if filteredContacts.isEmpty {
                ContentUnavailableView(
                    "No Contacts",
                    systemImage: "person.2",
                    description: Text("Your CRM contacts will appear here")
                )
            } else {
                List(filteredContacts) { contact in
                    NavigationLink {
                        iOSContactDetailView(contact: contact)
                    } label: {
                        iOSContactRow(contact: contact)
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Contacts")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "Search contacts")
        .refreshable {
            _ = try? await contactsService.fetchContacts()
        }
        .task {
            if contactsService.contacts.isEmpty {
                _ = try? await contactsService.fetchContacts()
            }
        }
    }

    private var filteredContacts: [Contact] {
        if searchText.isEmpty {
            return contactsService.contacts
        }
        return contactsService.contacts.filter { contact in
            contact.displayName.localizedCaseInsensitiveContains(searchText) ||
            (contact.company ?? "").localizedCaseInsensitiveContains(searchText) ||
            (contact.jobTitle ?? "").localizedCaseInsensitiveContains(searchText)
        }
    }
}
