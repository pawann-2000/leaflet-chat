#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    leaflet_desktop::run_with_context(tauri::generate_context!());
}
