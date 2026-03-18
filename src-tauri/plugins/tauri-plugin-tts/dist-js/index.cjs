'use strict';

var core = require('@tauri-apps/api/core');

async function startTtsServer() {
    return await core.invoke('plugin:tts|start_tts_server');
}
async function stopTtsServer() {
    return await core.invoke('plugin:tts|stop_tts_server');
}
async function getTtsPort() {
    return await core.invoke('plugin:tts|get_tts_port');
}
async function isTtsRunning() {
    return await core.invoke('plugin:tts|is_tts_running');
}

exports.getTtsPort = getTtsPort;
exports.isTtsRunning = isTtsRunning;
exports.startTtsServer = startTtsServer;
exports.stopTtsServer = stopTtsServer;
