/**
 * SpeechRecognitionService — Web Speech API wrapper for speech-to-text.
 *
 * Port of SpeechRecognitionManager.swift's pattern to the browser.
 * Uses the native SpeechRecognition API with silence detection.
 */

import type { SpeechRecognitionState, SpeechRecognitionOptions } from './types'

// Extend the Window interface for vendor-prefixed SpeechRecognition
interface SpeechRecognitionEvent {
  resultIndex: number
  results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent {
  error: string
  message: string
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance

/** Silence timeout in milliseconds — matches MobiChat's silenceThreshold of 1.5s */
const SILENCE_TIMEOUT_MS = 1500

/** Fallback timeout for processing state, in milliseconds */
const PROCESSING_FALLBACK_MS = 2000

export class SpeechRecognitionService {
  private recognition: SpeechRecognitionInstance | null = null
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private processingTimer: ReturnType<typeof setTimeout> | null = null
  private state: SpeechRecognitionState = 'idle'
  private transcript = ''
  private options: SpeechRecognitionOptions | null = null

  /**
   * Check if the Web Speech API is available in this browser.
   */
  static isSupported(): boolean {
    return !!(
      (typeof window !== 'undefined') &&
      (
        (window as unknown as Record<string, unknown>).SpeechRecognition ||
        (window as unknown as Record<string, unknown>).webkitSpeechRecognition
      )
    )
  }

  /**
   * Start speech recognition.
   */
  start(options: SpeechRecognitionOptions): void {
    if (this.state === 'listening') {
      return
    }

    if (!SpeechRecognitionService.isSupported()) {
      options.onError('Speech recognition is not supported in this browser')
      return
    }

    this.options = options
    this.transcript = ''
    this.state = 'listening'

    const SpeechRecognitionCtor = (
      (window as unknown as Record<string, unknown>).SpeechRecognition ||
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition
    ) as SpeechRecognitionConstructor

    const recognition = new SpeechRecognitionCtor()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = options.language ?? 'en-US'

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimTranscript = ''
      let finalTranscript = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const text = result[0].transcript
        if (result.isFinal) {
          finalTranscript += text
        } else {
          interimTranscript += text
        }
      }

      if (finalTranscript) {
        this.transcript += finalTranscript
        this.options?.onTranscript(this.transcript, true)
      } else if (interimTranscript) {
        this.options?.onTranscript(this.transcript + interimTranscript, false)
      }

      // Reset silence timer on any result
      this.resetSilenceTimer()
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      this.clearTimers()
      this.state = 'error'
      this.options?.onError(event.error || event.message || 'Unknown speech recognition error')
    }

    recognition.onend = () => {
      // If we were still listening (browser stopped on its own), handle gracefully
      if (this.state === 'listening' || this.state === 'processing') {
        this.clearTimers()
        this.state = 'idle'
        this.options?.onEnd()
      }
    }

    this.recognition = recognition

    try {
      recognition.start()
    } catch (err) {
      this.state = 'error'
      this.options?.onError(
        err instanceof Error ? err.message : 'Failed to start speech recognition'
      )
    }
  }

  /**
   * Stop recognition gracefully. Allows final results to be processed.
   */
  stop(): void {
    this.clearSilenceTimer()
    this.state = 'processing'

    if (this.recognition) {
      this.recognition.stop()
    }

    // Fallback: if final result doesn't arrive within the timeout, force end
    this.processingTimer = setTimeout(() => {
      if (this.state === 'processing') {
        this.state = 'idle'
        this.options?.onEnd()
        this.recognition = null
      }
    }, PROCESSING_FALLBACK_MS)
  }

  /**
   * Cancel recognition immediately. Clears the transcript.
   */
  cancel(): void {
    this.clearTimers()
    this.state = 'idle'
    this.transcript = ''

    if (this.recognition) {
      this.recognition.abort()
      this.recognition = null
    }
  }

  private resetSilenceTimer(): void {
    this.clearSilenceTimer()
    this.silenceTimer = setTimeout(() => {
      const text = this.transcript.trim()
      if (text && this.state === 'listening') {
        this.stop()
      }
    }, SILENCE_TIMEOUT_MS)
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  private clearTimers(): void {
    this.clearSilenceTimer()
    if (this.processingTimer !== null) {
      clearTimeout(this.processingTimer)
      this.processingTimer = null
    }
  }
}
