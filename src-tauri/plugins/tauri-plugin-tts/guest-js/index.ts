import { invoke } from '@tauri-apps/api/core'

export interface TtsStartResult {
  port: number
  pid: number
}

export async function startTtsServer(): Promise<TtsStartResult> {
  return await invoke('plugin:tts|start_tts_server')
}

export async function stopTtsServer(): Promise<void> {
  return await invoke('plugin:tts|stop_tts_server')
}

export async function getTtsPort(): Promise<number> {
  return await invoke('plugin:tts|get_tts_port')
}

export async function isTtsRunning(): Promise<boolean> {
  return await invoke('plugin:tts|is_tts_running')
}
