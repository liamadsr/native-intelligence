//
//  dial8WidgetsBundle.swift
//  dial8Widgets
//
//  Bundle containing the capture home screen widget, the Control Center /
//  Action Button control, and the recording Live Activity / Dynamic Island.
//

import WidgetKit
import SwiftUI

@main
struct dial8WidgetsBundle: WidgetBundle {
    var body: some Widget {
        dial8Widgets()
        StartCaptureControl()
        dial8WidgetsLiveActivity()
    }
}
