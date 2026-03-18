use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub mod cleanup;
pub mod commands;
mod error;
mod process;
pub mod state;

pub use cleanup::cleanup_tts_process;
pub use state::TtsState;

/// Initializes the TTS plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("tts")
        .invoke_handler(tauri::generate_handler![
            commands::start_tts_server,
            commands::stop_tts_server,
            commands::get_tts_port,
            commands::is_tts_running,
            commands::request_microphone_permission,
            commands::get_microphone_status,
            commands::open_microphone_settings,
            commands::request_microphone_via_helper,
            commands::start_native_stt,
            commands::restart_native_stt,
            commands::stop_native_stt,
            commands::cancel_native_stt,
            commands::get_stt_authorization_status,
            commands::request_stt_authorization,
        ])
        .setup(|app, _api| {
            app.manage(state::TtsState::new());

            #[cfg(target_os = "macos")]
            {
                // Request microphone permission on app startup.
                // In production .app builds this triggers the TCC dialog.
                // In dev builds (non-bundled binary) this silently fails —
                // the user can use the Settings → Speech → Grant Access button
                // which launches a helper .app to trigger the TCC dialog.
                std::thread::spawn(|| {
                    let status = unsafe { commands::mic_authorization_status() };
                    log::info!(
                        "[tts] Microphone auth status at startup: {} (0=undetermined, 1=authorized, 2=denied, 3=restricted)",
                        status
                    );
                    if status == 0 {
                        // Not yet determined — trigger the system dialog
                        log::info!("[tts] Requesting microphone permission...");
                        let granted = unsafe { commands::request_mic_access() };
                        log::info!(
                            "[tts] Microphone permission result: {}",
                            if granted { "GRANTED" } else { "DENIED" }
                        );
                    }
                });
            }

            Ok(())
        })
        .build()
}
