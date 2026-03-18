/**
 * TTSClient — HTTP client for the TTS sidecar server.
 *
 * Handles streaming TTS via SSE, model management, and settings.
 */

import type {
  TtsEvent,
  TtsSettings,
  TtsModelInfo,
} from './types'

export class TTSClient {
  private readonly baseUrl: string

  constructor(serverPort: number) {
    this.baseUrl = `http://127.0.0.1:${serverPort}`
  }

  /**
   * Stream TTS audio for a sentence. Yields SSE events as they arrive.
   */
  async *streamSentence(
    text: string,
    settings: TtsSettings
  ): AsyncGenerator<TtsEvent> {
    const response = await fetch(`${this.baseUrl}/tts/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: settings.voice,
        speed: settings.speed,
        instruct: settings.instruct,
      }),
    })

    if (!response.ok) {
      throw new Error(`TTS stream request failed: ${response.status} ${response.statusText}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('Response body is not readable')
    }

    const decoder = new TextDecoder()
    let partial = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        partial += decoder.decode(value, { stream: true })

        // Parse SSE lines: "data: {...}\n\n"
        const lines = partial.split('\n')
        // Keep the last (possibly incomplete) line
        partial = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) {
            continue
          }
          const jsonStr = trimmed.slice('data:'.length).trim()
          if (!jsonStr || jsonStr === '[DONE]') {
            continue
          }
          try {
            const event = JSON.parse(jsonStr) as TtsEvent
            yield event
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      // Handle any remaining data in the partial buffer
      if (partial.trim()) {
        const trimmed = partial.trim()
        if (trimmed.startsWith('data:')) {
          const jsonStr = trimmed.slice('data:'.length).trim()
          if (jsonStr && jsonStr !== '[DONE]') {
            try {
              const event = JSON.parse(jsonStr) as TtsEvent
              yield event
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * Load a TTS model by ID.
   */
  async loadModel(modelId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/tts/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId }),
    })
    if (!response.ok) {
      throw new Error(`Failed to load model: ${response.status} ${response.statusText}`)
    }
  }

  /**
   * Unload the currently loaded TTS model.
   */
  async unloadModel(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/tts/models/unload`, {
      method: 'POST',
    })
    if (!response.ok) {
      throw new Error(`Failed to unload model: ${response.status} ${response.statusText}`)
    }
  }

  /**
   * Download a TTS model by its repository ID.
   */
  async downloadModel(repoId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/tts/models/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_id: repoId }),
    })
    if (!response.ok) {
      throw new Error(`Failed to download model: ${response.status} ${response.statusText}`)
    }
  }

  /**
   * List all available TTS models.
   */
  async getModels(): Promise<TtsModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/tts/models`)
    if (!response.ok) {
      throw new Error(`Failed to get models: ${response.status} ${response.statusText}`)
    }
    return response.json()
  }

  /**
   * Get current TTS settings.
   */
  async getSettings(): Promise<TtsSettings> {
    const response = await fetch(`${this.baseUrl}/tts/settings`)
    if (!response.ok) {
      throw new Error(`Failed to get settings: ${response.status} ${response.statusText}`)
    }
    return response.json()
  }

  /**
   * Update TTS settings (partial update).
   */
  async updateSettings(settings: Partial<TtsSettings>): Promise<TtsSettings> {
    const response = await fetch(`${this.baseUrl}/tts/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
    if (!response.ok) {
      throw new Error(`Failed to update settings: ${response.status} ${response.statusText}`)
    }
    return response.json()
  }

  /**
   * Generate a short audio preview (WAV blob) without streaming.
   */
  async generateAudio(text: string, settings: TtsSettings): Promise<Blob> {
    const response = await fetch(`${this.baseUrl}/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: settings.voice,
        speed: settings.speed,
        instruct: settings.instruct,
      }),
    })
    if (!response.ok) {
      throw new Error(`TTS generate failed: ${response.status} ${response.statusText}`)
    }
    return response.blob()
  }

  /**
   * Transcribe audio using server-side Whisper.
   */
  async transcribe(audioBlob: Blob, language?: string): Promise<string> {
    // Use the correct file extension based on the blob's MIME type
    const ext = audioBlob.type.includes('mp4')
      ? 'mp4'
      : audioBlob.type.includes('webm')
        ? 'webm'
        : 'wav'
    const formData = new FormData()
    formData.append('audio', audioBlob, `audio.${ext}`)
    if (language) {
      formData.append('language', language)
    }
    const response = await fetch(`${this.baseUrl}/stt/transcribe`, {
      method: 'POST',
      body: formData,
    })
    if (!response.ok) {
      throw new Error(`STT transcribe failed: ${response.status} ${response.statusText}`)
    }
    const result = await response.json()
    return result.text || ''
  }

  /**
   * Check if the TTS sidecar server is healthy.
   */
  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`)
      return response.ok
    } catch {
      return false
    }
  }
}
