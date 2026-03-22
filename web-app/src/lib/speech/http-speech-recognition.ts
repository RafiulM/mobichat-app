/**
 * HttpSpeechRecognitionService — Fallback STT using MediaRecorder + server-side Whisper.
 *
 * Used on macOS where the Web Speech API is not available in WKWebView.
 * Records audio via getUserMedia, detects silence, then sends the audio
 * to the TTS server's /stt/transcribe endpoint for Whisper transcription.
 *
 * The MediaStream is reused across recording cycles to avoid calling
 * getUserMedia() on every restart, which would trigger repeated
 * permission prompts in WKWebView.
 */

import type { SpeechRecognitionState, SpeechRecognitionOptions } from './types'
import { TTSClient } from './tts-client'

/** Silence detection threshold (RMS amplitude below this = silence) */
const SILENCE_THRESHOLD = 0.01

/** How long silence must persist before we finalize (ms) */
const SILENCE_DURATION_MS = 1500

/** Minimum recording length before we consider sending (ms) */
const MIN_RECORDING_MS = 500

export class HttpSpeechRecognitionService {
  private mediaStream: MediaStream | null = null
  private mediaRecorder: MediaRecorder | null = null
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private silenceCheckInterval: ReturnType<typeof setInterval> | null = null
  private state: SpeechRecognitionState = 'idle'
  private options: SpeechRecognitionOptions | null = null
  private ttsClient: TTSClient | null = null
  private chunks: Blob[] = []
  private recordingStartTime = 0
  private recordingMimeType = ''
  /** Guards against concurrent start() calls during async getUserMedia(). */
  private isStarting = false

  static isSupported(): boolean {
    return !!(
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof MediaRecorder !== 'undefined'
    )
  }

  setTtsClient(client: TTSClient | null): void {
    this.ttsClient = client
  }

  async start(options: SpeechRecognitionOptions): Promise<void> {
    if (this.state === 'listening' || this.isStarting) return

    if (!this.ttsClient) {
      options.onError('TTS server not connected — cannot transcribe')
      return
    }

    this.isStarting = true

    try {
    // Log availability for debugging
    console.info('[HTTP-STT] Checking APIs:', {
      mediaDevices: !!navigator.mediaDevices,
      getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      MediaRecorder: typeof MediaRecorder !== 'undefined',
    })

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      options.onError('Microphone API is not available in this browser. Ensure macOSPrivateApi is enabled.')
      return
    }

    this.options = options
    this.chunks = []

    // Reuse existing MediaStream if still active to avoid repeated getUserMedia
    // permission prompts in WKWebView. Only request a new stream if needed.
    if (!this.mediaStream || !this.mediaStream.active) {
      try {
        // Use simple constraints first — WKWebView may reject advanced constraints
        // like sampleRate. We'll resample server-side if needed.
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          },
        })
      } catch (err) {
        console.error('[HTTP-STT] getUserMedia failed:', err)
        if (err instanceof DOMException) {
          if (err.name === 'NotAllowedError' || err.name === 'NotFoundError') {
            options.onError('not-allowed')
            return
          }
        }
        options.onError(
          `Microphone error: ${err instanceof Error ? err.message : String(err)}`
        )
        return
      }
    }

    this.state = 'listening'
    this.recordingStartTime = Date.now()

    // Set up audio analysis for silence detection
    this.audioContext = new AudioContext()
    const source = this.audioContext.createMediaStreamSource(this.mediaStream)
    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 2048
    source.connect(this.analyser)

    // Set up MediaRecorder — Safari/WKWebView only supports audio/mp4, not audio/webm
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : '' // Let MediaRecorder use its default

    this.recordingMimeType = mimeType || 'audio/webm'
    this.mediaRecorder = new MediaRecorder(
      this.mediaStream,
      mimeType ? { mimeType } : undefined
    )

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data)
      }
    }

    this.mediaRecorder.onstop = () => {
      this.handleRecordingComplete()
    }

    this.mediaRecorder.onerror = (e) => {
      console.error('[HTTP-STT] MediaRecorder error:', e)
      this.cleanupRecording()
      this.state = 'idle'
      this.options?.onError('Recording failed — MediaRecorder error')
    }

    console.info('[HTTP-STT] Starting recording, mimeType:', this.recordingMimeType)
    this.mediaRecorder.start(250) // collect data every 250ms

    // Start silence detection
    this.startSilenceDetection()
    } finally {
      this.isStarting = false
    }
  }

  stop(): void {
    this.clearTimers()
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.state = 'processing'
      this.mediaRecorder.stop()
    } else {
      this.cleanupRecording()
      this.state = 'idle'
      this.options?.onEnd()
    }
  }

  cancel(): void {
    this.clearTimers()
    this.chunks = []
    this.isStarting = false
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      // Remove onstop to prevent handleRecordingComplete from firing
      this.mediaRecorder.onstop = null
      this.mediaRecorder.stop()
    }
    this.cleanupFull()
    this.state = 'idle'
  }

  /** Cancel recording but keep the MediaStream alive for reuse.
   *  Used during thread changes where we want to stop listening
   *  but avoid re-triggering getUserMedia on the next start(). */
  cancelKeepStream(): void {
    this.clearTimers()
    this.chunks = []
    this.isStarting = false
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.onstop = null
      this.mediaRecorder.stop()
    }
    this.cleanupRecording()
    this.state = 'idle'
  }

  private startSilenceDetection(): void {
    if (!this.analyser) return

    const dataArray = new Float32Array(this.analyser.fftSize)

    this.silenceCheckInterval = setInterval(() => {
      if (!this.analyser || this.state !== 'listening') return

      this.analyser.getFloatTimeDomainData(dataArray)

      // Calculate RMS
      let sum = 0
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i]
      }
      const rms = Math.sqrt(sum / dataArray.length)

      if (rms > SILENCE_THRESHOLD) {
        // Voice detected — clear silence timer, show interim feedback
        this.clearSilenceTimer()
        this.options?.onTranscript('...', false)
      } else if (!this.silenceTimer) {
        // Silence started — begin countdown
        const elapsed = Date.now() - this.recordingStartTime
        if (elapsed > MIN_RECORDING_MS) {
          this.silenceTimer = setTimeout(() => {
            if (this.state === 'listening' && this.mediaRecorder?.state === 'recording') {
              this.state = 'processing'
              this.options?.onTranscript('Processing...', false)
              this.mediaRecorder.stop()
            }
          }, SILENCE_DURATION_MS)
        }
      }
    }, 100)
  }

  private async handleRecordingComplete(): Promise<void> {
    this.clearTimers()

    if (this.chunks.length === 0 || !this.ttsClient) {
      this.cleanupRecording()
      this.state = 'idle'
      this.options?.onEnd()
      return
    }

    const audioBlob = new Blob(this.chunks, { type: this.recordingMimeType })
    this.chunks = []

    try {
      const text = await this.ttsClient.transcribe(
        audioBlob,
        this.options?.language
      )

      if (text) {
        this.options?.onTranscript(text, true)
      }
    } catch (err) {
      console.error('Transcription error:', err)
      this.options?.onError(
        `Transcription failed: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      this.cleanupRecording()
      this.state = 'idle'
      this.options?.onEnd()
    }
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  private clearTimers(): void {
    this.clearSilenceTimer()
    if (this.silenceCheckInterval !== null) {
      clearInterval(this.silenceCheckInterval)
      this.silenceCheckInterval = null
    }
  }

  /** Clean up recording resources but KEEP the MediaStream alive for reuse. */
  private cleanupRecording(): void {
    this.clearTimers()
    if (this.audioContext) {
      this.audioContext.close().catch(() => {})
      this.audioContext = null
      this.analyser = null
    }
    this.mediaRecorder = null
  }

  /** Full cleanup including stopping the MediaStream (used on cancel). */
  private cleanupFull(): void {
    this.cleanupRecording()
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop())
      this.mediaStream = null
    }
  }
}
