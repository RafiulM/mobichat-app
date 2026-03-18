use sysinfo::{Pid, System};

/// Check if a process is running by PID
pub fn is_process_running_by_pid(pid: i32) -> bool {
    let mut system = System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let process_pid = Pid::from(pid as usize);
    system.process(process_pid).is_some()
}

/// Gracefully terminate a process on Unix systems (macOS)
#[cfg(unix)]
pub async fn graceful_terminate_process(child: &mut tokio::process::Child) {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    use std::time::Duration;
    use tokio::time::timeout;

    if let Some(raw_pid) = child.id() {
        let raw_pid = raw_pid as i32;
        log::info!("Sending SIGTERM to TTS process PID {}", raw_pid);
        let _ = kill(Pid::from_raw(raw_pid), Signal::SIGTERM);

        match timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(status)) => log::info!("TTS process exited gracefully: {}", status),
            Ok(Err(e)) => log::error!("Error waiting after SIGTERM for TTS process: {}", e),
            Err(_) => {
                log::warn!(
                    "SIGTERM timed out for TTS PID {}; sending SIGKILL",
                    raw_pid
                );
                let _ = kill(Pid::from_raw(raw_pid), Signal::SIGKILL);
                match child.wait().await {
                    Ok(s) => log::info!("Force-killed TTS process exited: {}", s),
                    Err(e) => log::error!("Error waiting after SIGKILL for TTS process: {}", e),
                }
            }
        }
    }
}
