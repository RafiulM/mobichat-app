/**
 * NativeSpeechRecognitionService — macOS native STT via SFSpeechRecognizer.
 *
 * Uses Tauri commands + events to bridge to the native Speech framework.
 * Provides real-time partial results with on-device processing.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { SpeechRecognitionState, SpeechRecognitionOptions } from './types'

/** Silence timeout — if no new partial results arrive, auto-stop */
const SILENCE_TIMEOUT_MS = 1500

export class NativeSpeechRecognitionService {
  private unlisteners: UnlistenFn[] = []
  private state: SpeechRecognitionState = 'idle'
  private options: SpeechRecognitionOptions | null = null
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null
  private starting = false
  /** True while the native audio engine is alive (between start and cancel) */
  engineAlive = false
  /** Last partial transcript received — used to submit on silence timeout */
  private lastTranscript = ''
  /** Guards against double-submit when both silence timeout and isFinal fire */
  private submittedThisSession = false

  static isSupported(): boolean {
    return (
      typeof IS_TAURI !== 'undefined' &&
      !!IS_TAURI &&
      typeof IS_MACOS !== 'undefined' &&
      !!IS_MACOS
    )
  }

  async start(options: SpeechRecognitionOptions): Promise<void> {
    if (this.state === 'listening' || this.starting) return
    this.starting = true

    // Clean up any leftover listeners from a previous session
    this.cleanup()

    this.options = options
    this.state = 'listening'
    this.lastTranscript = ''
    this.submittedThisSession = false

    // Set up event listeners BEFORE invoking start
    this.unlisteners.push(
      await listen<{ text: string; isFinal: boolean }>(
        'stt://result',
        (event) => {
          const { text, isFinal } = event.payload

          if (isFinal) {
            this.clearSilenceTimer()
            // Only submit if silence timeout hasn't already submitted
            if (!this.submittedThisSession) {
              this.submittedThisSession = true
              this.lastTranscript = ''
              this.options?.onTranscript(text, true)
            }
          } else {
            this.lastTranscript = text
            this.options?.onTranscript(text, false)
            this.resetSilenceTimer()
          }
        }
      )
    )

    this.unlisteners.push(
      await listen<{ error: string }>('stt://error', (event) => {
        this.clearSilenceTimer()
        // Don't cleanup listeners — engine may still be alive for restart
        this.state = 'error'
        this.options?.onError(event.payload.error)
      })
    )

    this.unlisteners.push(
      await listen('stt://ended', () => {
        if (this.state === 'listening' || this.state === 'processing') {
          this.clearSilenceTimer()
          this.clearFallbackTimer()
          // Don't cleanup listeners — engine stays alive for restart
          this.state = 'idle'
          this.options?.onEnd()
        }
      })
    )

    try {
      await invoke('plugin:tts|start_native_stt', {
        language: options.language ?? 'en-US',
      })
      this.engineAlive = true
    } catch (err) {
      this.cleanup()
      this.state = 'error'
      options.onError(
        err instanceof Error ? err.message : String(err)
      )
    } finally {
      this.starting = false
    }
  }

  /**
   * Restart recognition reusing the existing audio engine.
   * If engine is alive and listeners are active, calls restart_native_stt.
   * Otherwise falls back to a full start().
   */
  async restart(options: SpeechRecognitionOptions): Promise<void> {
    if (!this.engineAlive || this.unlisteners.length === 0) {
      return this.start(options)
    }

    if (this.state === 'listening' || this.starting) return
    this.starting = true

    this.options = options
    this.state = 'listening'
    this.lastTranscript = ''
    this.submittedThisSession = false

    try {
      await invoke('plugin:tts|restart_native_stt', {
        language: options.language ?? 'en-US',
      })
    } catch (err) {
      // restart failed — fall back to full start only if we haven't been
      // cancelled concurrently (e.g., by cancelKeepEngine during navigation)
      this.starting = false
      this.engineAlive = false
      if (this.state !== 'listening') {
        // A concurrent cancel reset state — don't fall back, another effect
        // will handle restarting if needed.
        return
      }
      this.cleanup()
      return this.start(options)
    } finally {
      this.starting = false
    }
  }

  /**
   * Stop recognition gracefully. Called externally (e.g., when chat starts
   * streaming). Does NOT submit the transcript — caller manages that.
   */
  stop(): void {
    this.clearSilenceTimer()
    this.state = 'processing'
    invoke('plugin:tts|stop_native_stt').catch((err) => {
      console.error('[NativeSTT] stop error:', err)
    })
  }

  /**
   * Stop recognition and submit the accumulated partial transcript
   * immediately — like MacLLMs's stopListening(). Called by the silence
   * timer. Does not wait for isFinal from the Speech framework.
   */
  private submitAndStop(): void {
    this.clearSilenceTimer()

    // Submit accumulated transcript immediately (MacLLMs pattern)
    const text = this.lastTranscript
    this.lastTranscript = ''
    if (text.trim() && !this.submittedThisSession) {
      this.submittedThisSession = true
      this.options?.onTranscript(text, true)
    }

    this.state = 'processing'
    invoke('plugin:tts|stop_native_stt').catch((err) => {
      console.error('[NativeSTT] stop error:', err)
    })

    // Fallback: if stt://ended never fires (engine-alive edge case),
    // force transition to idle after 2s so auto-restart can proceed.
    this.clearFallbackTimer()
    this.fallbackTimer = setTimeout(() => {
      if (this.state === 'processing') {
        this.state = 'idle'
        this.options?.onEnd()
      }
    }, 2000)
  }

  cancel(): void {
    this.clearSilenceTimer()
    this.clearFallbackTimer()
    this.state = 'idle'
    this.starting = false
    this.engineAlive = false
    this.lastTranscript = ''
    this.submittedThisSession = false
    invoke('plugin:tts|cancel_native_stt').catch((err) => {
      console.error('[NativeSTT] cancel error:', err)
    })
    this.cleanup()
  }

  /**
   * Cancel the current recognition session but keep the audio engine alive.
   * Used during route transitions (component unmount / thread change) so that
   * restart() can reuse the engine without creating a new AVAudioEngine and
   * without triggering a new macOS microphone access event.
   */
  cancelKeepEngine(): void {
    this.clearSilenceTimer()
    this.clearFallbackTimer()
    this.state = 'idle'
    this.starting = false
    this.lastTranscript = ''
    this.submittedThisSession = false
    invoke('plugin:tts|cancel_native_stt_keep_engine').catch((err) => {
      console.error('[NativeSTT] cancelKeepEngine error:', err)
    })
    // Keep engineAlive = true and listeners intact for restart
  }

  private resetSilenceTimer(): void {
    this.clearSilenceTimer()
    this.silenceTimer = setTimeout(() => {
      if (this.state === 'listening') {
        this.submitAndStop()
      }
    }, SILENCE_TIMEOUT_MS)
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
  }

  private cleanup(): void {
    this.clearSilenceTimer()
    this.clearFallbackTimer()
    this.unlisteners.forEach((fn) => fn())
    this.unlisteners = []
  }
}
