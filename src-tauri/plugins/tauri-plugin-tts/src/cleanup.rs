use tauri::{Manager, Runtime};

pub async fn cleanup_tts_process<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<(), String> {
    let app_state = match app_handle.try_state::<crate::state::TtsState>() {
        Some(state) => state,
        None => {
            log::warn!("TtsState not found in app_handle");
            return Ok(());
        }
    };
    let mut session_guard = app_state.session.lock().await;
    if let Some(mut session) = session_guard.take() {
        #[cfg(unix)]
        {
            use nix::sys::signal::{kill, Signal};
            use nix::unistd::Pid;
            use tokio::time::{timeout, Duration};

            if let Some(raw_pid) = session.child.id() {
                let raw_pid = raw_pid as i32;
                log::info!("Sending SIGTERM to TTS PID {} during shutdown", raw_pid);
                let _ = kill(Pid::from_raw(raw_pid), Signal::SIGTERM);

                match timeout(Duration::from_secs(2), session.child.wait()).await {
                    Ok(Ok(status)) => {
                        log::info!("TTS process {} exited gracefully: {}", raw_pid, status)
                    }
                    Ok(Err(e)) => {
                        log::error!(
                            "Error waiting after SIGTERM for TTS process {}: {}",
                            raw_pid,
                            e
                        )
                    }
                    Err(_) => {
                        log::warn!(
                            "SIGTERM timed out for TTS PID {}; sending SIGKILL",
                            raw_pid
                        );
                        let _ = kill(Pid::from_raw(raw_pid), Signal::SIGKILL);
                        let _ = session.child.wait().await;
                    }
                }
            }
        }

        #[cfg(not(unix))]
        {
            let _ = session.child.kill().await;
            let _ = session.child.wait().await;
        }
    }

    Ok(())
}
