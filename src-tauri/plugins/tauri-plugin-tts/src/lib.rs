use tauri::{
    plugin::{Builder, TauriPlugin},
    Emitter, Manager, Runtime,
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
            commands::cancel_native_stt_keep_engine,
            commands::get_stt_authorization_status,
            commands::request_stt_authorization,
        ])
        .setup(|app, _api| {
            app.manage(state::TtsState::new());

            #[cfg(target_os = "macos")]
            {
                // Check (but don't request) mic and STT permission status at
                // startup. Emit the result so the frontend can warm its cache.
                // Permission requests happen exclusively through the frontend's
                // ensureMicPermission() / ensureSttAuth() which have proper
                // deduplication — doing it here too causes duplicate TCC dialogs.
                let app_handle = app.clone();
                std::thread::spawn(move || {
                    let mic_status = unsafe { commands::mic_authorization_status() };
                    let stt_status = unsafe { commands::stt_authorization_status() };
                    log::info!(
                        "[tts] Permission status at startup — mic: {} stt: {} (0=undetermined, 1=authorized, 2=denied, 3=restricted)",
                        mic_status, stt_status
                    );

                    let _ = app_handle.emit(
                        "stt://permissions-ready",
                        serde_json::json!({
                            "micGranted": mic_status == 1,
                            "sttGranted": stt_status == 1
                        }),
                    );
                });
            }

            Ok(())
        })
        .build()
}
