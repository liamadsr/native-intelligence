//
//  dial8Widgets.swift
//  dial8Widgets
//
//  Home screen widget that provides a quick "Start Capture" button.
//  Tapping it deep-links into the app and opens the recording sheet.
//

import WidgetKit
import SwiftUI

struct CaptureProvider: TimelineProvider {
    func placeholder(in context: Context) -> CaptureEntry {
        CaptureEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (CaptureEntry) -> Void) {
        completion(CaptureEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<CaptureEntry>) -> Void) {
        let entry = CaptureEntry(date: Date())
        let timeline = Timeline(entries: [entry], policy: .never)
        completion(timeline)
    }
}

struct CaptureEntry: TimelineEntry {
    let date: Date
}

struct CaptureWidgetView: View {
    var body: some View {
        smallWidget
    }

    private var smallWidget: some View {
        VStack(spacing: 8) {
            Image(systemName: "mic.circle.fill")
                .font(.system(size: 40))
                .foregroundStyle(.primary)

            Text("Capture")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(for: .widget) {
            Color(.systemBackground)
        }
        .widgetURL(URL(string: "dial8://capture"))
    }
}

struct dial8Widgets: Widget {
    let kind: String = "dial8CaptureWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: CaptureProvider()) { entry in
            CaptureWidgetView()
        }
        .configurationDisplayName("Quick Capture")
        .description("Start a voice capture from your home screen.")
        .supportedFamilies([.systemSmall])
    }
}

#Preview(as: .systemSmall) {
    dial8Widgets()
} timeline: {
    CaptureEntry(date: .now)
}
