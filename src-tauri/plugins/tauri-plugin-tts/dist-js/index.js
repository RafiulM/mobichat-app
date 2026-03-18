import { invoke } from '@tauri-apps/api/core';

async function startTtsServer() {
    return await invoke('plugin:tts|start_tts_server');
}
async function stopTtsServer() {
    return await invoke('plugin:tts|stop_tts_server');
}
async function getTtsPort() {
    return await invoke('plugin:tts|get_tts_port');
}
async function isTtsRunning() {
    return await invoke('plugin:tts|is_tts_running');
}

export { getTtsPort, isTtsRunning, startTtsServer, stopTtsServer };
