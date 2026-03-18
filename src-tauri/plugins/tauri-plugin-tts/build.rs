const COMMANDS: &[&str] = &[
    "start_tts_server",
    "stop_tts_server",
    "get_tts_port",
    "is_tts_running",
    "request_microphone_permission",
    "get_microphone_status",
    "open_microphone_settings",
    "request_microphone_via_helper",
    "start_native_stt",
    "restart_native_stt",
    "stop_native_stt",
    "cancel_native_stt",
    "get_stt_authorization_status",
    "request_stt_authorization",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();

    // Compile the Objective-C helper for native microphone permission on macOS
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("src/macos_mic.m")
            .flag("-fobjc-arc")
            .compile("macos_mic");

        cc::Build::new()
            .file("src/macos_stt.m")
            .flag("-fobjc-arc")
            .compile("macos_stt");

        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=Speech");
    }
}
