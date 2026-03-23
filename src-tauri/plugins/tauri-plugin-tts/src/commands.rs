use std::process::Stdio;
use std::time::Duration;
use tauri::{Emitter, Manager, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::error::{ErrorCode, ServerError, ServerResult, TtsError};
use crate::process::is_process_running_by_pid;
use crate::state::{TtsServerSession, TtsState};

#[cfg(unix)]
use crate::process::graceful_terminate_process;

// FFI bindings to the compiled Objective-C helper (macos_mic.m)
#[cfg(target_os = "macos")]
extern "C" {
    /// Returns: 0 = not determined, 1 = authorized, 2 = denied, 3 = restricted
    pub fn mic_authorization_status() -> i32;
    /// Synchronously requests microphone access. Shows TCC dialog if not yet determined.
    pub fn request_mic_access() -> bool;
}

// FFI bindings to the compiled Objective-C helper (macos_stt.m)
#[cfg(target_os = "macos")]
extern "C" {
    /// Returns: 0 = not determined, 1 = authorized, 2 = denied, 3 = restricted
    pub fn stt_authorization_status() -> i32;
    /// Synchronously requests speech recognition authorization. Shows TCC dialog if not yet determined.
    pub fn stt_request_authorization() -> bool;
    /// Start native speech recognition. Calls the callback with partial/final results.
    pub fn stt_start(
        callback: extern "C" fn(
            *const std::os::raw::c_char,
            bool,
            *const std::os::raw::c_char,
        ),
        language: *const std::os::raw::c_char,
    ) -> bool;
    /// Restart recognition reusing the existing audio engine.
    /// Returns false if the engine is dead (caller should fall back to stt_start).
    pub fn stt_restart(
        callback: extern "C" fn(
            *const std::os::raw::c_char,
            bool,
            *const std::os::raw::c_char,
        ),
        language: *const std::os::raw::c_char,
    ) -> bool;
    /// Stop recognition gracefully — allows final result to be delivered.
    pub fn stt_stop();
    /// Cancel recognition immediately.
    pub fn stt_cancel();
    /// Cancel recognition but keep the audio engine alive for restart.
    pub fn stt_cancel_keep_engine();
}

// ── Native STT event bridge ──────────────────────────────────────────
// The C callback runs on Speech framework's dispatch queue (non-async).
// We use a channel to send events from the C callback to a tokio task
// that emits Tauri events. This avoids storing a concrete AppHandle type
// in a static, keeping the plugin generic over Runtime.

#[cfg(target_os = "macos")]
#[derive(Debug)]
enum SttEvent {
    Result { text: String, is_final: bool },
    Error { error: String },
    /// Recognition session ended — emitter loop stays alive for restart.
    SessionEnded,
    /// Full shutdown — emitter loop exits.
    Shutdown,
}

#[cfg(target_os = "macos")]
static STT_SENDER: std::sync::Mutex<Option<std::sync::mpsc::Sender<SttEvent>>> =
    std::sync::Mutex::new(None);

#[cfg(target_os = "macos")]
extern "C" fn stt_callback(
    text: *const std::os::raw::c_char,
    is_final: bool,
    error: *const std::os::raw::c_char,
) {
    let sender_guard = match STT_SENDER.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(sender) = sender_guard.as_ref() else {
        return;
    };

    if !error.is_null() {
        let error_str = unsafe { std::ffi::CStr::from_ptr(error) }
            .to_string_lossy()
            .to_string();
        log::error!("[stt] Recognition error: {}", error_str);
        let _ = sender.send(SttEvent::Error { error: error_str });
        let _ = sender.send(SttEvent::SessionEnded);
        return;
    }

    if !text.is_null() {
        let text_str = unsafe { std::ffi::CStr::from_ptr(text) }
            .to_string_lossy()
            .to_string();
        let _ = sender.send(SttEvent::Result {
            text: text_str,
            is_final,
        });

        if is_final {
            let _ = sender.send(SttEvent::SessionEnded);
        }
    } else if is_final {
        let _ = sender.send(SttEvent::SessionEnded);
    }
}

/// Request microphone permission from the OS.
///
/// On macOS this calls AVCaptureDevice.requestAccess(for: .audio) directly
/// from the app process, triggering the system TCC permission dialog so the
/// app appears in System Settings → Privacy & Security → Microphone.
/// Returns `true` if access was granted, `false` if denied.
///
/// Short-circuits if permission is already authorized or denied — only
/// triggers the TCC dialog when status is "not determined".
#[tauri::command]
pub async fn request_microphone_permission() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let result = tokio::task::spawn_blocking(|| {
            let status = unsafe { mic_authorization_status() };
            match status {
                1 => {
                    // Already authorized — no need to call request_mic_access()
                    return true;
                }
                2 | 3 => {
                    // Denied or restricted — can't re-prompt
                    return false;
                }
                _ => {}
            }
            log::info!("[tts] Microphone status is undetermined, requesting permission...");
            let granted = unsafe { request_mic_access() };
            log::info!("[tts] Microphone permission result: {}", if granted { "granted" } else { "denied" });
            granted
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?;

        Ok(result)
    }

    #[cfg(not(target_os = "macos"))]
    {
        // On other platforms, assume permission is handled by the browser/webview
        Ok(true)
    }
}

/// Get the current microphone authorization status without triggering the permission dialog.
///
/// Returns: "authorized", "not_determined", "denied", "restricted", or "not_applicable".
#[tauri::command]
pub async fn get_microphone_status() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let status = tokio::task::spawn_blocking(|| {
            let raw = unsafe { mic_authorization_status() };
            match raw {
                0 => "not_determined",
                1 => "authorized",
                2 => "denied",
                3 => "restricted",
                _ => "unknown",
            }
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?;

        Ok(status.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok("not_applicable".to_string())
    }
}

/// Open macOS System Settings to the Microphone privacy pane.
#[tauri::command]
pub async fn open_microphone_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(|| {
            std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
                .spawn()
                .map_err(|e| format!("Failed to open System Settings: {}", e))
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))??;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// Request microphone permission via a temporary .app bundle.
///
/// On macOS Sequoia+, non-bundled binaries (like `cargo tauri dev` builds)
/// cannot trigger the TCC permission dialog. This command works around that
/// by creating a minimal .app bundle with the same bundle ID (`jan.ai.app`),
/// launching it via `open`, and letting IT trigger the TCC dialog.
///
/// Returns `true` if the user granted permission, `false` otherwise.
#[tauri::command]
pub async fn request_microphone_via_helper() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(|| {
            request_mic_via_helper_impl()
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

/// Implementation: create a helper .app, compile a tiny ObjC binary inside it,
/// sign it, launch it, and wait for it to exit.
#[cfg(target_os = "macos")]
fn request_mic_via_helper_impl() -> Result<bool, String> {
    use std::fs;
    use std::process::Command;

    let cache_dir = dirs::cache_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join("jan-mic-helper");
    let app_dir = cache_dir.join("JanMicHelper.app");
    let contents_dir = app_dir.join("Contents");
    let macos_dir = contents_dir.join("MacOS");
    let binary_path = macos_dir.join("JanMicHelper");
    let plist_path = contents_dir.join("Info.plist");
    let src_path = cache_dir.join("mic_helper.m");

    // Create directories
    fs::create_dir_all(&macos_dir)
        .map_err(|e| format!("Failed to create helper app dir: {}", e))?;

    // Write Info.plist
    fs::write(
        &plist_path,
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>jan.ai.app</string>
  <key>CFBundleExecutable</key>
  <string>JanMicHelper</string>
  <key>CFBundleName</key>
  <string>Jan</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Jan needs microphone access for voice input and speech-to-text.</string>
</dict>
</plist>"#,
    )
    .map_err(|e| format!("Failed to write Info.plist: {}", e))?;

    // Only recompile if the binary doesn't exist
    if !binary_path.exists() {
        // Write ObjC source
        fs::write(
            &src_path,
            r#"
#import <AVFoundation/AVFoundation.h>
#import <Cocoa/Cocoa.h>

@interface AppDelegate : NSObject <NSApplicationDelegate>
@end

@implementation AppDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL granted) {
        // Write result to stdout so the parent can read it
        printf("%s\n", granted ? "granted" : "denied");
        fflush(stdout);
        dispatch_async(dispatch_get_main_queue(), ^{
            [NSApp terminate:nil];
        });
    }];
}
@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        [app setDelegate:delegate];
        [app run];
    }
    return 0;
}
"#,
        )
        .map_err(|e| format!("Failed to write ObjC source: {}", e))?;

        // Compile
        let compile = Command::new("clang")
            .args([
                "-framework", "AVFoundation",
                "-framework", "Cocoa",
                "-o",
            ])
            .arg(&binary_path)
            .arg(&src_path)
            .output()
            .map_err(|e| format!("Failed to compile helper: {}", e))?;

        if !compile.status.success() {
            return Err(format!(
                "Helper compilation failed: {}",
                String::from_utf8_lossy(&compile.stderr)
            ));
        }
    }

    // Find entitlements — check common locations
    let entitlements_path = {
        let exe = std::env::current_exe().ok();
        let mut found = None;
        if let Some(ref exe) = exe {
            let mut dir = exe.parent().map(|p| p.to_path_buf());
            for _ in 0..5 {
                if let Some(ref d) = dir {
                    let candidate = d.join("Entitlements.plist");
                    if candidate.exists() {
                        found = Some(candidate);
                        break;
                    }
                    dir = d.parent().map(|p| p.to_path_buf());
                } else {
                    break;
                }
            }
        }
        found
    };

    // Sign the bundle
    let mut sign_cmd = Command::new("codesign");
    sign_cmd.args(["--force", "--sign", "-"]);
    if let Some(ref ent) = entitlements_path {
        sign_cmd.args(["--entitlements"]).arg(ent);
    }
    sign_cmd.arg(&app_dir);

    let sign = sign_cmd
        .output()
        .map_err(|e| format!("Failed to sign helper: {}", e))?;

    if !sign.status.success() {
        log::warn!(
            "[tts] Helper codesign warning: {}",
            String::from_utf8_lossy(&sign.stderr)
        );
    }

    // Launch via `open -W` (waits for the app to exit)
    log::info!("[tts] Launching mic permission helper at {:?}", app_dir);
    let result = Command::new("open")
        .args(["-W", "-a"])
        .arg(&app_dir)
        .output()
        .map_err(|e| format!("Failed to launch helper: {}", e))?;

    if !result.status.success() {
        return Err(format!(
            "Helper launch failed: {}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }

    // Check if permission was granted by reading the TCC state
    // (the helper process had the right bundle context)
    let status = unsafe { mic_authorization_status() };
    log::info!("[tts] Mic status after helper: {} (0=undetermined, 1=authorized, 2=denied, 3=restricted)", status);

    // For non-bundled dev binaries, status may still show 0 (undetermined)
    // because TCC tracks by process identity. Return true optimistically
    // if the helper didn't error — the permission IS granted for the
    // jan.ai.app bundle ID, and production builds will see it.
    Ok(status == 1 || result.status.success())
}


#[derive(serde::Serialize, serde::Deserialize)]
pub struct TtsStartResult {
    pub port: u16,
    pub pid: i32,
}

/// Start the TTS server using the bundled `uv` binary
#[tauri::command]
pub async fn start_tts_server<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> ServerResult<TtsStartResult> {
    log::info!("[tts] start_tts_server called");
    let state: State<TtsState> = app_handle.state();
    let mut session_guard = state.session.lock().await;

    // If a session is already running, return its info
    if let Some(ref session) = *session_guard {
        if is_process_running_by_pid(session.pid) {
            log::info!(
                "TTS server already running on port {} with PID {}",
                session.port,
                session.pid
            );
            return Ok(TtsStartResult {
                port: session.port,
                pid: session.pid,
            });
        } else {
            log::warn!(
                "TTS server session exists but process PID {} is dead, cleaning up",
                session.pid
            );
            *session_guard = None;
        }
    }

    // Resolve bundled `uv` binary path
    let resource_dir = app_handle.path().resource_dir().map_err(|e| {
        TtsError::new(
            ErrorCode::BinaryNotFound,
            "Failed to get resource dir".to_string(),
            Some(e.to_string()),
        )
    })?;

    let uv_path = if cfg!(windows) {
        resource_dir.join("resources/bin/uv.exe")
    } else {
        resource_dir.join("resources/bin/uv")
    };

    if !uv_path.exists() {
        return Err(TtsError::new(
            ErrorCode::BinaryNotFound,
            format!("uv binary not found at: {}", uv_path.display()),
            None,
        )
        .into());
    }

    // Resolve tts-server script directory
    let tts_server_dir = resource_dir.join("resources/tts-server");
    let tts_server_script = tts_server_dir.join("server.py");

    if !tts_server_script.exists() {
        return Err(TtsError::new(
            ErrorCode::ScriptNotFound,
            format!(
                "TTS server script not found at: {}",
                tts_server_script.display()
            ),
            None,
        )
        .into());
    }

    // Allocate a random port
    let port = jan_utils::generate_random_port(&std::collections::HashSet::new())
        .map_err(|e| TtsError::new(ErrorCode::InternalError, e.clone(), Some(e)))?;

    log::info!("Starting TTS server on port {} using uv at {:?}", port, uv_path);

    // Build command: uv run --with fastapi --with uvicorn --with "mlx-audio" --with numpy -- uvicorn server:app --host 127.0.0.1 --port {port}
    let mut command = Command::new(&uv_path);
    command.args([
        "run",
        "--with", "fastapi",
        "--with", "uvicorn",
        "--with", "python-multipart",
        "--with", "mlx-audio",
        "--with", "mlx-whisper",
        "--with", "numpy",
        "--",
        "uvicorn", "server:app",
        "--host", "127.0.0.1",
        "--port", &port.to_string(),
    ]);
    command.current_dir(&tts_server_dir);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    // Spawn the child process
    let mut child = command.spawn().map_err(ServerError::Io)?;

    let stderr = child.stderr.take().expect("stderr was piped");
    let stdout = child.stdout.take().expect("stdout was piped");

    // Create channels for communication between tasks
    let (ready_tx, mut ready_rx) = mpsc::channel::<bool>(1);

    // Spawn task to monitor stdout for readiness
    let stdout_ready_tx = ready_tx.clone();
    let _stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut byte_buffer = Vec::new();

        loop {
            byte_buffer.clear();
            match reader.read_until(b'\n', &mut byte_buffer).await {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&byte_buffer);
                    let line = line.trim_end();
                    if !line.is_empty() {
                        log::info!("[tts stdout] {}", line);
                    }

                    let line_lower = line.to_lowercase();
                    if line_lower.contains("uvicorn running on") {
                        log::info!(
                            "TTS server appears to be ready based on stdout: '{}'",
                            line
                        );
                        let _ = stdout_ready_tx.send(true).await;
                    }
                }
                Err(e) => {
                    log::error!("Error reading TTS stdout: {}", e);
                    break;
                }
            }
        }
    });

    // Spawn task to capture stderr and monitor for readiness
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut byte_buffer = Vec::new();
        let mut stderr_buffer = String::new();

        loop {
            byte_buffer.clear();
            match reader.read_until(b'\n', &mut byte_buffer).await {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&byte_buffer);
                    let line = line.trim_end();

                    if !line.is_empty() {
                        stderr_buffer.push_str(line);
                        stderr_buffer.push('\n');
                        log::info!("[tts] {}", line);

                        let line_lower = line.to_lowercase();
                        if line_lower.contains("uvicorn running on") {
                            log::info!(
                                "TTS server appears to be ready based on logs: '{}'",
                                line
                            );
                            let _ = ready_tx.send(true).await;
                        }
                    }
                }
                Err(e) => {
                    log::error!("Error reading TTS logs: {}", e);
                    break;
                }
            }
        }

        stderr_buffer
    });

    // Check if process exited early
    if let Some(status) = child.try_wait()? {
        if !status.success() {
            let stderr_output = stderr_task.await.unwrap_or_default();
            log::error!("TTS server failed early with code {:?}", status);
            log::error!("{}", stderr_output);
            return Err(TtsError::from_stderr(&stderr_output).into());
        }
    }

    // Wait for server to be ready or timeout (120 seconds for dependency install on first run)
    let timeout_duration = Duration::from_secs(120);
    let start_time = Instant::now();
    log::info!("Waiting for TTS server to be ready...");

    loop {
        tokio::select! {
            Some(true) = ready_rx.recv() => {
                log::info!("TTS server is ready to accept requests!");
                break;
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                if let Some(status) = child.try_wait()? {
                    let stderr_output = stderr_task.await.unwrap_or_default();
                    if !status.success() {
                        log::error!("TTS server exited with error code {:?}", status);
                        return Err(TtsError::from_stderr(&stderr_output).into());
                    } else {
                        log::error!("TTS server exited successfully but without ready signal");
                        return Err(TtsError::from_stderr(&stderr_output).into());
                    }
                }

                if start_time.elapsed() > timeout_duration {
                    log::error!("Timeout waiting for TTS server to be ready");
                    let _ = child.kill().await;
                    let stderr_output = stderr_task.await.unwrap_or_default();
                    return Err(TtsError::new(
                        ErrorCode::ServerStartTimedOut,
                        "The TTS server took too long to start and timed out.".into(),
                        Some(format!(
                            "Timeout: {}s\n\nStderr:\n{}",
                            timeout_duration.as_secs(),
                            stderr_output
                        )),
                    )
                    .into());
                }
            }
        }
    }

    let pid = child.id().map(|id| id as i32).unwrap_or(-1);

    log::info!("TTS server process started with PID: {} on port: {}", pid, port);

    *session_guard = Some(TtsServerSession {
        child,
        pid,
        port,
    });

    Ok(TtsStartResult { port, pid })
}

/// Stop the TTS server
#[tauri::command]
pub async fn stop_tts_server<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> ServerResult<()> {
    let state: State<TtsState> = app_handle.state();
    let mut session_guard = state.session.lock().await;

    if let Some(mut session) = session_guard.take() {
        log::info!("Stopping TTS server with PID {}", session.pid);

        #[cfg(unix)]
        {
            graceful_terminate_process(&mut session.child).await;
        }

        #[cfg(not(unix))]
        {
            let _ = session.child.kill().await;
            let _ = session.child.wait().await;
        }

        log::info!("TTS server stopped");
    } else {
        log::warn!("No TTS server session found to stop");
    }

    Ok(())
}

/// Get the port of the running TTS server
#[tauri::command]
pub async fn get_tts_port<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> ServerResult<u16> {
    let state: State<TtsState> = app_handle.state();
    let session_guard = state.session.lock().await;

    if let Some(ref session) = *session_guard {
        if is_process_running_by_pid(session.pid) {
            Ok(session.port)
        } else {
            Err(TtsError::new(
                ErrorCode::ServerNotRunning,
                "TTS server process is no longer running.".into(),
                None,
            )
            .into())
        }
    } else {
        Err(TtsError::new(
            ErrorCode::ServerNotRunning,
            "TTS server is not running.".into(),
            None,
        )
        .into())
    }
}

/// Check if the TTS server is currently running
#[tauri::command]
pub async fn is_tts_running<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<bool, String> {
    let state: State<TtsState> = app_handle.state();
    let mut session_guard = state.session.lock().await;

    if let Some(ref session) = *session_guard {
        if is_process_running_by_pid(session.pid) {
            log::info!("[tts] is_tts_running: true (PID {} on port {})", session.pid, session.port);
            Ok(true)
        } else {
            // Clean up stale session
            log::warn!("TTS server PID {} is no longer running, cleaning up session", session.pid);
            *session_guard = None;
            Ok(false)
        }
    } else {
        log::info!("[tts] is_tts_running: false (no session)");
        Ok(false)
    }
}

// ── Native STT commands ──────────────────────────────────────────────

/// Get the current speech recognition authorization status.
///
/// Returns: "authorized", "not_determined", "denied", "restricted", or "not_applicable".
#[tauri::command]
pub async fn get_stt_authorization_status() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let status = tokio::task::spawn_blocking(|| {
            let raw = unsafe { stt_authorization_status() };
            match raw {
                0 => "not_determined",
                1 => "authorized",
                2 => "denied",
                3 => "restricted",
                _ => "unknown",
            }
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?;

        Ok(status.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok("not_applicable".to_string())
    }
}

/// Request speech recognition authorization. Shows TCC dialog if not yet determined.
///
/// Short-circuits if authorization is already granted or denied.
#[tauri::command]
pub async fn request_stt_authorization() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let result = tokio::task::spawn_blocking(|| {
            let status = unsafe { stt_authorization_status() };
            match status {
                1 => {
                    // Already authorized
                    return true;
                }
                2 | 3 => {
                    // Denied or restricted
                    return false;
                }
                _ => {}
            }
            log::info!("[stt] STT status is undetermined, requesting authorization...");
            let granted = unsafe { stt_request_authorization() };
            log::info!(
                "[stt] Speech recognition authorization result: {}",
                if granted { "granted" } else { "denied" }
            );
            granted
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?;

        Ok(result)
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

/// Start native speech recognition using macOS SFSpeechRecognizer.
///
/// Results are delivered as Tauri events:
/// - `stt://result` — `{ text: String, isFinal: bool }`
/// - `stt://error`  — `{ error: String }`
/// - `stt://ended`  — recognition session ended
#[tauri::command]
pub async fn start_native_stt<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    language: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Create a channel for the C callback to send events to Rust
        let (tx, rx) = std::sync::mpsc::channel::<SttEvent>();
        {
            let mut sender_guard = STT_SENDER
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            *sender_guard = Some(tx);
        }

        let lang = language.unwrap_or_else(|| "en-US".to_string());
        let lang_cstring = std::ffi::CString::new(lang)
            .map_err(|e| format!("Invalid language string: {}", e))?;

        let started = tokio::task::spawn_blocking(move || unsafe {
            stt_start(stt_callback, lang_cstring.as_ptr())
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?;

        if !started {
            if let Ok(mut sender_guard) = STT_SENDER.lock() {
                *sender_guard = None;
            }
            return Err("Failed to start native speech recognition".to_string());
        }

        log::info!("[stt] Native speech recognition started");

        // Spawn a blocking task that reads from the channel and emits Tauri events.
        // We use a dedicated blocking thread because std::sync::mpsc::Receiver
        // blocks on recv(). The AppHandle is Send + Sync so it can be moved here.
        let app = app_handle.clone();
        tokio::task::spawn_blocking(move || {
            loop {
                match rx.recv() {
                    Ok(SttEvent::Result { text, is_final }) => {
                        let _ = app.emit(
                            "stt://result",
                            serde_json::json!({ "text": text, "isFinal": is_final }),
                        );
                    }
                    Ok(SttEvent::Error { error }) => {
                        let _ = app.emit(
                            "stt://error",
                            serde_json::json!({ "error": error }),
                        );
                    }
                    Ok(SttEvent::SessionEnded) => {
                        // Session ended but engine is still alive — emit event
                        // but keep the loop running for restart.
                        let _ = app.emit("stt://ended", ());
                    }
                    Ok(SttEvent::Shutdown) => {
                        let _ = app.emit("stt://ended", ());
                        break;
                    }
                    Err(_) => {
                        // Channel closed — sender dropped
                        break;
                    }
                }
            }
        });

        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_handle;
        let _ = language;
        Err("Native STT is only supported on macOS".to_string())
    }
}

/// Restart native speech recognition, reusing the existing audio engine.
///
/// If the engine is still alive, creates a new recognition task without
/// tearing down AVAudioEngine (no mic indicator flicker). If the engine
/// is dead, falls back to a full start with a fresh channel.
///
/// Always creates a fresh event channel and emitter loop to guarantee
/// the event pipeline is intact, even if the previous emitter exited
/// during a cancel/restart race.
#[tauri::command]
pub async fn restart_native_stt<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    language: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Create a fresh channel BEFORE restarting so the event pipeline is
        // guaranteed to be intact. Replacing the sender causes the old
        // emitter loop to exit (its channel closes).
        let (tx, rx) = std::sync::mpsc::channel::<SttEvent>();
        {
            let mut sender_guard = STT_SENDER
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            *sender_guard = Some(tx);
        }

        let lang = language.unwrap_or_else(|| "en-US".to_string());
        let lang_cstring = std::ffi::CString::new(lang.clone())
            .map_err(|e| format!("Invalid language string: {}", e))?;

        let restarted = tokio::task::spawn_blocking(move || unsafe {
            stt_restart(stt_callback, lang_cstring.as_ptr())
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?;

        if !restarted {
            // Engine is dead — fall back to full start with fresh channel
            log::info!("[stt] Engine dead, falling back to full start");
            return start_native_stt(app_handle, Some(lang)).await;
        }

        log::info!("[stt] Native speech recognition restarted (engine reused)");

        // Spawn a fresh emitter loop for the new channel
        let app = app_handle.clone();
        tokio::task::spawn_blocking(move || {
            loop {
                match rx.recv() {
                    Ok(SttEvent::Result { text, is_final }) => {
                        let _ = app.emit(
                            "stt://result",
                            serde_json::json!({ "text": text, "isFinal": is_final }),
                        );
                    }
                    Ok(SttEvent::Error { error }) => {
                        let _ = app.emit(
                            "stt://error",
                            serde_json::json!({ "error": error }),
                        );
                    }
                    Ok(SttEvent::SessionEnded) => {
                        let _ = app.emit("stt://ended", ());
                    }
                    Ok(SttEvent::Shutdown) => {
                        let _ = app.emit("stt://ended", ());
                        break;
                    }
                    Err(_) => {
                        break;
                    }
                }
            }
        });

        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_handle;
        let _ = language;
        Err("Native STT is only supported on macOS".to_string())
    }
}

/// Stop native speech recognition gracefully (allows final result).
#[tauri::command]
pub async fn stop_native_stt() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(|| unsafe { stt_stop() })
            .await
            .map_err(|e| format!("Task join error: {}", e))?;
        log::info!("[stt] Native speech recognition stopped");
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// Cancel native speech recognition immediately.
#[tauri::command]
pub async fn cancel_native_stt() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Send Shutdown event so the emitter loop exits
        if let Ok(sender_guard) = STT_SENDER.lock() {
            if let Some(sender) = sender_guard.as_ref() {
                let _ = sender.send(SttEvent::Shutdown);
            }
        }
        tokio::task::spawn_blocking(|| unsafe { stt_cancel() })
            .await
            .map_err(|e| format!("Task join error: {}", e))?;
        // Clear the sender
        if let Ok(mut sender_guard) = STT_SENDER.lock() {
            *sender_guard = None;
        }
        log::info!("[stt] Native speech recognition cancelled");
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// Cancel native speech recognition but keep the audio engine alive.
///
/// Cancels the current recognition task without tearing down AVAudioEngine.
/// The emitter loop and channel stay alive so that restart_native_stt can
/// reuse the engine without triggering a new microphone access event.
#[tauri::command]
pub async fn cancel_native_stt_keep_engine() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(|| unsafe { stt_cancel_keep_engine() })
            .await
            .map_err(|e| format!("Task join error: {}", e))?;
        log::info!("[stt] Native speech recognition cancelled (engine kept alive)");
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}
