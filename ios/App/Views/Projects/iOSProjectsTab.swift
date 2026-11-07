import SwiftUI

/// Pushed from Home's header (the folder button). It deliberately does NOT wrap
/// itself in a `NavigationStack`: nesting one inside the pushing stack swallows
/// the back button and strands the user on this screen.
struct iOSProjectsTab: View {
    @StateObject private var projectsService = ProjectsService.shared

    var body: some View {
        Group {
            if projectsService.isLoading && projectsService.projects.isEmpty {
                ProgressView("Loading projects...")
            } else if projectsService.projects.isEmpty {
                ContentUnavailableView(
                    "No Projects",
                    systemImage: "folder",
                    description: Text("Your projects will appear here")
                )
            } else {
                List(projectsService.projects) { project in
                    NavigationLink {
                        iOSProjectDetailView(project: project)
                    } label: {
                        iOSProjectRow(project: project)
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Projects")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            _ = try? await projectsService.fetchProjects()
        }
        .task {
            if projectsService.projects.isEmpty {
                _ = try? await projectsService.fetchProjects()
            }
        }
    }
}
