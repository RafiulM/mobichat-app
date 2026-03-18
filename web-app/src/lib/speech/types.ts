// Shared types for the speech service modules

// TTS event types (SSE stream from TTS sidecar)
export type TtsAudioHeader = {
  type: 'audio_header'
  sample_rate: number
  channels: number
  format: string
}

export type TtsAudioChunk = {
  type: 'audio'
  data: string
}

export type TtsError = {
  type: 'error'
  source: string
  detail: string
}

export type TtsEvent = TtsAudioHeader | TtsAudioChunk | TtsError

// TTS settings
export type TtsSettings = {
  voice: string
  speed: number
  instruct: string
}

// TTS model info
export type TtsModelInfo = {
  id: string
  name: string
  size: string
  repo_id: string
  is_downloaded: boolean
  is_loaded: boolean
}

// Speech recognition state
export type SpeechRecognitionState = 'idle' | 'listening' | 'processing' | 'error'

// Speech recognition callbacks
export type SpeechRecognitionOptions = {
  onTranscript: (text: string, isFinal: boolean) => void
  onEnd: () => void
  onError: (error: string) => void
  language?: string
}
