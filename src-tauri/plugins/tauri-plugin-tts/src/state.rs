use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::Mutex;

pub struct TtsServerSession {
    pub child: Child,
    pub pid: i32,
    pub port: u16,
}

/// TTS plugin state
pub struct TtsState {
    pub session: Arc<Mutex<Option<TtsServerSession>>>,
}

impl Default for TtsState {
    fn default() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
        }
    }
}

impl TtsState {
    pub fn new() -> Self {
        Self::default()
    }
}
