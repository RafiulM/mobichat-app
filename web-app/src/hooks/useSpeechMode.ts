import { useEffect, useRef, useCallback } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import {
  SentenceBuffer,
  StreamingAudioPlayer,
  TTSClient,
  SpeechRecognitionService,
  HttpSpeechRecognitionService,
  NativeSpeechRecognitionService,
} from '@/lib/speech'
import type { SpeechRecognitionState } from '@/lib/speech'
import { useSpeechStore } from '@/stores/speech-store'
import { invoke } from '@tauri-apps/api/core'

interface UseSpeechModeOptions {
  threadId: string
  chatMessages: UIMessage[]
  chatStatus: string // 'streaming' | 'submitted' | 'ready' | 'error'
  onSubmit: (text: string) => void
}

// Module-level singleton — preserves the MediaStream across component
// remounts (route changes) so getUserMedia() is not re-triggered.
const sharedHttpSttService = new HttpSpeechRecognitionService()

// ── Module-level permission cache ────────────────────────────────────
// Survives hook remounts (page navigation) so we never re-request
// permissions that were already granted. Promise locks deduplicate
// concurrent requests from multiple effects firing together.

let micPermissionGranted =
  typeof IS_TAURI !== 'undefined' && IS_TAURI &&
  typeof IS_MACOS !== 'undefined' && IS_MACOS
    ? localStorage.getItem('mic-permission-granted') === 'true' ||
      localStorage.getItem('mic-helper-granted') === 'true'
    : false

let sttAuthGranted =
  typeof IS_TAURI !== 'undefined' && IS_TAURI &&
  typeof IS_MACOS !== 'undefined' && IS_MACOS
    ? localStorage.getItem('stt-auth-granted') === 'true'
    : false

let micPermissionPromise: Promise<boolean> | null = null
let sttAuthPromise: Promise<boolean> | null = null

/**
 * Ensure microphone permission is granted. Returns true if authorized.
 * Deduplicates concurrent calls — only one IPC request in flight at a time.
 */
async function ensureMicPermission(): Promise<boolean> {
  if (micPermissionGranted) return true
  if (micPermissionPromise) return micPermissionPromise

  micPermissionPromise = (async () => {
    try {
      const status = await invoke<string>('plugin:tts|get_microphone_status')
      if (status === 'authorized') {
        micPermissionGranted = true
        try { localStorage.setItem('mic-permission-granted', 'true') } catch {}
        return true
      }
      if (status !== 'not_determined') return false
      const granted = await invoke<boolean>('plugin:tts|request_microphone_permission')
      if (granted) {
        micPermissionGranted = true
        try { localStorage.setItem('mic-permission-granted', 'true') } catch {}
      }
      return granted
    } catch (err) {
      console.warn('[Speech] Mic permission check failed:', err)
      return false
    } finally {
      micPermissionPromise = null
    }
  })()

  return micPermissionPromise
}

/**
 * Ensure speech recognition authorization is granted. Returns true if authorized.
 * Same deduplication pattern as ensureMicPermission().
 */
async function ensureSttAuth(): Promise<boolean> {
  if (sttAuthGranted) return true
  if (sttAuthPromise) return sttAuthPromise

  sttAuthPromise = (async () => {
    try {
      const status = await invoke<string>('plugin:tts|get_stt_authorization_status')
      if (status === 'authorized') {
        sttAuthGranted = true
        try { localStorage.setItem('stt-auth-granted', 'true') } catch {}
        return true
      }
      if (status !== 'not_determined') return false
      const granted = await invoke<boolean>('plugin:tts|request_stt_authorization')
      if (granted) {
        sttAuthGranted = true
        try { localStorage.setItem('stt-auth-granted', 'true') } catch {}
      }
      return granted
    } catch (err) {
      console.warn('[Speech] STT authorization check failed:', err)
      return false
    } finally {
      sttAuthPromise = null
    }
  })()

  return sttAuthPromise
}

interface UseSpeechModeReturn {
  isVoiceModeActive: boolean
  isOverlayOpen: boolean
  isSttSupported: boolean
  toggleVoiceMode: () => void
  setOverlayOpen: (open: boolean) => void
  sttState: SpeechRecognitionState
  sttError: string | null
  currentTranscript: string
  ttsState: 'idle' | 'loading' | 'speaking'
  startListening: () => void
  stopListening: () => void
  stopSpeaking: () => void
  speakMessage: (text: string, messageId: string) => void
}

export function useSpeechMode({
  threadId,
  chatMessages,
  chatStatus,
  onSubmit,
}: UseSpeechModeOptions): UseSpeechModeReturn {
  // ── Store selectors ──────────────────────────────────────────────────

  const isVoiceModeActive = useSpeechStore((s) => s.isVoiceModeActive)
  const isOverlayOpen = useSpeechStore((s) => s.isOverlayOpen)
  const sttState = useSpeechStore((s) => s.sttState)
  const sttError = useSpeechStore((s) => s.sttError)
  const currentTranscript = useSpeechStore((s) => s.currentTranscript)
  const ttsState = useSpeechStore((s) => s.ttsState)
  const ttsServerPort = useSpeechStore((s) => s.ttsServerPort)
  const autoSpeakResponses = useSpeechStore((s) => s.autoSpeakResponses)

  const toggleVoiceMode = useSpeechStore((s) => s.toggleVoiceMode)
  const setOverlayOpen = useSpeechStore((s) => s.setOverlayOpen)
  const setSttState = useSpeechStore((s) => s.setSttState)
  const setCurrentTranscript = useSpeechStore((s) => s.setCurrentTranscript)
  const setSttError = useSpeechStore((s) => s.setSttError)
  const setTtsState = useSpeechStore((s) => s.setTtsState)
  const setSpeakingMessageId = useSpeechStore((s) => s.setSpeakingMessageId)

  // ── Refs for service instances ───────────────────────────────────────

  const ttsClientRef = useRef<TTSClient | null>(null)
  const audioPlayerRef = useRef<StreamingAudioPlayer>(
    new StreamingAudioPlayer()
  )
  const sentenceBufferRef = useRef<SentenceBuffer>(new SentenceBuffer())
  const sttServiceRef = useRef<SpeechRecognitionService>(
    new SpeechRecognitionService()
  )
  const httpSttServiceRef = useRef<HttpSpeechRecognitionService>(
    sharedHttpSttService
  )
  const nativeSttServiceRef = useRef<NativeSpeechRecognitionService>(
    new NativeSpeechRecognitionService()
  )

  /** Tracks whether the native engine has been started at least once.
   *  On subsequent calls we use restart() to skip permission checks and
   *  reuse the AVAudioEngine, avoiding mic indicator flicker. */
  const nativeEngineStartedRef = useRef(false)

  /** Guards against concurrent startNativeListening calls — multiple effects
   *  can fire close together (voice mode activation + chat ready), and we
   *  must not issue duplicate permission requests while the first is pending. */
  const nativeStartingRef = useRef(false)

  /** Guards against concurrent startHttpListening calls — same race as native. */
  const httpStartingRef = useRef(false)

  // Permission caches are module-level (micPermissionGranted, sttAuthGranted)
  // so they survive hook remounts. See ensureMicPermission() / ensureSttAuth().

  // ── Refs for text delta tracking ─────────────────────────────────────

  const prevTextLenRef = useRef(0)
  const lastAssistantIdRef = useRef<string | null>(null)

  // ── Refs for TTS queue processing ────────────────────────────────────

  const ttsQueueRef = useRef<string[]>([])
  const isProcessingQueueRef = useRef(false)
  const isMountedRef = useRef(true)

  // Keep latest callback refs in sync to avoid stale closures
  const onSubmitRef = useRef(onSubmit)
  onSubmitRef.current = onSubmit

  const threadIdRef = useRef(threadId)
  threadIdRef.current = threadId

  // ── TTS Client initialization ────────────────────────────────────────

  useEffect(() => {
    if (ttsServerPort) {
      const client = new TTSClient(ttsServerPort)
      ttsClientRef.current = client
      httpSttServiceRef.current.setTtsClient(client)
    } else {
      ttsClientRef.current = null
      httpSttServiceRef.current.setTtsClient(null)
    }
  }, [ttsServerPort])

  // ── TTS queue processor ──────────────────────────────────────────────

  const processTtsQueue = useCallback(async () => {
    if (isProcessingQueueRef.current) return
    if (ttsQueueRef.current.length === 0) return
    if (!ttsClientRef.current) return

    isProcessingQueueRef.current = true

    while (ttsQueueRef.current.length > 0 && isMountedRef.current) {
      const sentence = ttsQueueRef.current.shift()
      if (!sentence) continue

      const store = useSpeechStore.getState()
      if (!store.isVoiceModeActive && !store.speakingMessageId) {
        // Voice mode was deactivated and not doing per-message speak
        ttsQueueRef.current = []
        break
      }

      try {
        setTtsState('speaking')

        const settings = {
          voice: useSpeechStore.getState().ttsVoice,
          speed: useSpeechStore.getState().ttsSpeed,
          instruct: useSpeechStore.getState().ttsInstruct,
        }

        const generator = ttsClientRef.current.streamSentence(
          sentence,
          settings
        )

        for await (const event of generator) {
          if (!isMountedRef.current) break

          switch (event.type) {
            case 'audio_header':
              audioPlayerRef.current.initialize(
                event.sample_rate,
                event.channels
              )
              break
            case 'audio':
              audioPlayerRef.current.scheduleChunk(event.data)
              break
            case 'error':
              console.error('TTS error:', event.source, event.detail)
              break
          }
        }

        // Signal no more chunks for this sentence
        audioPlayerRef.current.finish()

        // Wait for audio playback to complete
        await new Promise<void>((resolve) => {
          const player = audioPlayerRef.current
          // If finish() already triggered completion (e.g., empty audio), resolve immediately
          const checkImmediate = () => {
            // Set up the callback for when playback completes
            player.onPlaybackComplete = () => {
              player.onPlaybackComplete = undefined
              resolve()
            }
          }
          checkImmediate()
        })
      } catch (error) {
        console.error('TTS processing error:', error)
      }
    }

    isProcessingQueueRef.current = false

    // If queue is empty and we're done, reset TTS state
    if (ttsQueueRef.current.length === 0 && isMountedRef.current) {
      setTtsState('idle')
      setSpeakingMessageId(null)

      // Auto-restart STT after TTS completes if voice mode is still active
      const store = useSpeechStore.getState()
      if (
        store.isVoiceModeActive &&
        store.autoSpeakResponses &&
        store.sttState === 'idle'
      ) {
        startListeningInternal()
      }
    }
  }, [setTtsState, setSpeakingMessageId])

  // ── STT management ───────────────────────────────────────────────────

  // Determine which STT backend to use:
  // 1. Native macOS STT via SFSpeechRecognizer (preferred on macOS Tauri — real-time, no server)
  // 2. Web Speech API (Chrome, Electron, etc.)
  // 3. HTTP Whisper fallback (macOS WKWebView via TTS server)
  // On macOS Tauri (WKWebView), webkitSpeechRecognition exists but doesn't
  // work in embedded context.
  const isTauriMacOS = IS_TAURI && IS_MACOS
  const useNativeStt = isTauriMacOS && NativeSpeechRecognitionService.isSupported()
  const useWebSpeechApi = !useNativeStt && !isTauriMacOS && SpeechRecognitionService.isSupported()
  const useHttpStt = !useNativeStt && !useWebSpeechApi && (isTauriMacOS || HttpSpeechRecognitionService.isSupported())
  const isSttSupported = useNativeStt || useWebSpeechApi || useHttpStt

  const sttCallbacks = useCallback((): {
    onTranscript: (text: string, isFinal: boolean) => void
    onEnd: () => void
    onError: (error: string) => void
    language?: string
  } => ({
    onTranscript: (text: string, isFinal: boolean) => {
      setCurrentTranscript(text)

      if (isFinal && text.trim()) {
        setSttState('processing')
        onSubmitRef.current(text.trim())
        setCurrentTranscript('')
      }
    },
    onEnd: () => {
      if (!isMountedRef.current) return
      const store = useSpeechStore.getState()
      if (store.sttState === 'listening' || store.sttState === 'processing') {
        setSttState('idle')
      }
      // Auto-restart if voice mode is still active
      const current = useSpeechStore.getState()
      if (current.isVoiceModeActive && current.ttsState === 'idle') {
        setTimeout(() => {
          const s = useSpeechStore.getState()
          if (s.isVoiceModeActive && s.ttsState === 'idle' && s.sttState === 'idle') {
            startListeningInternal()
          }
        }, 600)
      }
    },
    onError: (error: string) => {
      if (!isMountedRef.current) return
      if (error === 'no-speech') {
        setSttState('idle')
        const store = useSpeechStore.getState()
        if (store.isVoiceModeActive && store.ttsState === 'idle') {
          setTimeout(() => {
            const s = useSpeechStore.getState()
            if (s.isVoiceModeActive && s.ttsState === 'idle' && s.sttState === 'idle') {
              startListeningInternal()
            }
          }, 600)
        }
        return
      }
      if (error === 'not-allowed' || error === 'service-not-allowed') {
        // Web Speech API blocked — try HTTP fallback
        if (useHttpStt) {
          console.info('[Speech] Web Speech API not allowed, using HTTP Whisper fallback')
          startHttpListening()
          return
        }
        console.warn('[Speech] STT not available in this environment')
        setSttError(
          'Microphone access denied. Grant permission in System Settings → Privacy & Security → Microphone.'
        )
        setSttState('error')
        return
      }
      setSttError(error)
      setSttState('error')
    },
  }), [setSttState, setCurrentTranscript, setSttError])

  const startHttpListening = useCallback(async () => {
    // Guard against concurrent calls — same pattern as startNativeListening
    if (httpStartingRef.current) return
    httpStartingRef.current = true

    try {
    // TTS server must be running for HTTP STT transcription
    if (!useSpeechStore.getState().ttsServerPort) {
      console.info('[Speech] HTTP STT waiting for TTS server')
      return
    }

    // On macOS, ensure native mic permission is granted BEFORE calling
    // getUserMedia. Uses the module-level deduplicating helper.
    if (IS_TAURI && IS_MACOS) {
      const granted = await ensureMicPermission()
      if (!granted) {
        console.warn('[Speech] Native mic permission not granted, getUserMedia may fail')
      }
    }

    setSttState('listening')
    setCurrentTranscript('')

    await httpSttServiceRef.current.start({
      onTranscript: (text: string, isFinal: boolean) => {
        setCurrentTranscript(text)
        if (isFinal && text.trim()) {
          setSttState('processing')
          onSubmitRef.current(text.trim())
          setCurrentTranscript('')
        }
      },
      onEnd: () => {
        if (!isMountedRef.current) return
        const store = useSpeechStore.getState()
        if (store.sttState === 'listening' || store.sttState === 'processing') {
          setSttState('idle')
        }
        // Auto-restart if voice mode is still active
        const current = useSpeechStore.getState()
        if (current.isVoiceModeActive && current.ttsState === 'idle') {
          setTimeout(() => {
            const s = useSpeechStore.getState()
            if (s.isVoiceModeActive && s.ttsState === 'idle' && s.sttState === 'idle') {
              startHttpListening()
            }
          }, 300)
        }
      },
      onError: (error: string) => {
        if (!isMountedRef.current) return
        if (error === 'not-allowed') {
          console.warn('[Speech] Microphone access denied')
          setSttError(
            'Microphone access denied. Grant permission in System Settings → Privacy & Security → Microphone.'
          )
          setSttState('error')
          return
        }
        console.error('[Speech] HTTP STT error:', error)
        setSttError(error)
        setSttState('error')
      },
    })
    } finally {
      httpStartingRef.current = false
    }
  }, [setSttState, setCurrentTranscript, setSttError])

  const startNativeListening = useCallback(async () => {
    // Guard against concurrent calls — multiple effects can fire together
    if (nativeStartingRef.current) return
    nativeStartingRef.current = true

    try {
    const isRestart = nativeEngineStartedRef.current

    if (!isRestart) {
      // First start — request mic and speech recognition permissions via
      // the module-level deduplicating helpers. These ensure only one IPC
      // call is in flight even if multiple effects trigger concurrently.
      const micGranted = await ensureMicPermission()
      if (!micGranted) {
        setSttError('Microphone access denied. Grant permission in System Settings → Privacy & Security → Microphone.')
        setSttState('error')
        return
      }

      const sttGranted = await ensureSttAuth()
      if (!sttGranted) {
        setSttError('Speech recognition permission denied. Enable it in System Settings → Privacy & Security → Speech Recognition.')
        setSttState('error')
        return
      }
    }

    setSttState('listening')
    setCurrentTranscript('')

    const sttOptions = {
      onTranscript: (text: string, isFinal: boolean) => {
        setCurrentTranscript(text)
        if (isFinal && text.trim()) {
          setSttState('processing')
          onSubmitRef.current(text.trim())
          setCurrentTranscript('')
        }
      },
      onEnd: () => {
        if (!isMountedRef.current) return
        const store = useSpeechStore.getState()
        if (store.sttState === 'listening' || store.sttState === 'processing') {
          setSttState('idle')
        }
        // Auto-restart if voice mode is still active
        const current = useSpeechStore.getState()
        if (current.isVoiceModeActive && current.ttsState === 'idle') {
          setTimeout(() => {
            const s = useSpeechStore.getState()
            if (s.isVoiceModeActive && s.ttsState === 'idle' && s.sttState === 'idle') {
              startNativeListening()
            }
          }, 600)
        }
      },
      onError: (error: string) => {
        if (!isMountedRef.current) return
        console.error('[Speech] Native STT error:', error)
        nativeEngineStartedRef.current = false
        setSttError(error)
        setSttState('error')
      },
    }

    if (isRestart) {
      await nativeSttServiceRef.current.restart(sttOptions)
    } else {
      await nativeSttServiceRef.current.start(sttOptions)
      nativeEngineStartedRef.current = true
    }
    } finally {
      nativeStartingRef.current = false
    }
  }, [setSttState, setCurrentTranscript, setSttError])

  const startListeningInternal = useCallback(() => {
    console.info('[Speech] startListeningInternal', { useNativeStt, useWebSpeechApi, useHttpStt })
    if (useNativeStt) {
      startNativeListening()
    } else if (useWebSpeechApi) {
      setSttState('listening')
      setCurrentTranscript('')
      sttServiceRef.current.start(sttCallbacks())
    } else if (useHttpStt) {
      startHttpListening()
    } else {
      console.warn('[Speech] No STT backend available')
    }
  }, [useNativeStt, useWebSpeechApi, useHttpStt, setSttState, setCurrentTranscript, sttCallbacks, startHttpListening, startNativeListening])

  const startListening = useCallback(() => {
    startListeningInternal()
  }, [startListeningInternal])

  const stopListening = useCallback(() => {
    sttServiceRef.current.stop()
    httpSttServiceRef.current.stop()
    nativeSttServiceRef.current.stop()
    setSttState('idle')
    setCurrentTranscript('')
  }, [setSttState, setCurrentTranscript])

  // ── Stop speaking ────────────────────────────────────────────────────

  const stopSpeaking = useCallback(() => {
    ttsQueueRef.current = []
    audioPlayerRef.current.stop()
    isProcessingQueueRef.current = false
    setTtsState('idle')
    setSpeakingMessageId(null)
  }, [setTtsState, setSpeakingMessageId])

  // ── Per-message speak ────────────────────────────────────────────────

  const speakMessage = useCallback(
    (text: string, messageId: string) => {
      // Stop any current playback
      stopSpeaking()

      if (!ttsClientRef.current) {
        console.warn('TTS client not available — no server port configured')
        return
      }

      setSpeakingMessageId(messageId)

      // Split the text into sentences using a fresh buffer
      const buffer = new SentenceBuffer()
      const sentences = buffer.addToken(text)
      const remainder = buffer.flush()

      ttsQueueRef.current = [
        ...sentences,
        ...(remainder ? [remainder] : []),
      ]

      processTtsQueue()
    },
    [stopSpeaking, setSpeakingMessageId, processTtsQueue]
  )

  // ── Text delta interception (streaming TTS) ──────────────────────────

  useEffect(() => {
    if (chatStatus !== 'streaming') return
    if (!isVoiceModeActive || !autoSpeakResponses) return
    if (!ttsClientRef.current) return

    const lastMsg = chatMessages[chatMessages.length - 1]
    if (!lastMsg || lastMsg.role !== 'assistant') return

    // Reset tracking when a new assistant message starts
    if (lastMsg.id !== lastAssistantIdRef.current) {
      lastAssistantIdRef.current = lastMsg.id
      prevTextLenRef.current = 0
      sentenceBufferRef.current = new SentenceBuffer()
      setSpeakingMessageId(lastMsg.id)
    }

    // Extract full text from message parts
    const fullText = lastMsg.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('')

    // Get new text since last update
    const newText = fullText.slice(prevTextLenRef.current)
    prevTextLenRef.current = fullText.length

    if (newText) {
      const sentences = sentenceBufferRef.current.addToken(newText)
      sentences.forEach((s) => ttsQueueRef.current.push(s))
      processTtsQueue()
    }
  }, [
    chatMessages,
    chatStatus,
    isVoiceModeActive,
    autoSpeakResponses,
    processTtsQueue,
    setSpeakingMessageId,
  ])

  // ── Stream finish handling ───────────────────────────────────────────
  // When streaming stops, flush the sentence buffer and add remainder to queue

  const prevChatStatusRef = useRef(chatStatus)

  useEffect(() => {
    const wasStreaming = prevChatStatusRef.current === 'streaming'
    prevChatStatusRef.current = chatStatus

    if (!wasStreaming || chatStatus !== 'ready') return
    if (!isVoiceModeActive || !autoSpeakResponses) return

    const remainder = sentenceBufferRef.current.flush()
    if (remainder) {
      ttsQueueRef.current.push(remainder)
      processTtsQueue()
    }

    // Reset tracking refs for next stream
    lastAssistantIdRef.current = null
    prevTextLenRef.current = 0
  }, [chatStatus, isVoiceModeActive, autoSpeakResponses, processTtsQueue])

  // ── Voice mode activation / deactivation ─────────────────────────────

  useEffect(() => {
    if (isVoiceModeActive) {
      console.info('[Speech] Voice mode activated', {
        useNativeStt,
        useWebSpeechApi,
        useHttpStt,
        isSttSupported,
        ttsServerPort,
        isTauriMacOS,
      })
      // When voice mode is activated, start STT if not already speaking
      const store = useSpeechStore.getState()
      if (
        store.ttsState === 'idle' &&
        store.sttState === 'idle' &&
        chatStatus !== 'streaming' &&
        chatStatus !== 'submitted'
      ) {
        // On macOS HTTP STT path (not native), wait for TTS server to be ready.
        // The auto-start effect below will start the server, and the
        // ttsServerPort watch effect will trigger STT once it's ready.
        if (useHttpStt && !useNativeStt && !ttsServerPort) return
        startListeningInternal()
      }
    } else {
      // When voice mode is deactivated, stop everything.
      // Use cancelKeepStream for HTTP STT to preserve the MediaStream —
      // avoids re-triggering getUserMedia dialogs when voice mode is toggled.
      sttServiceRef.current.cancel()
      httpSttServiceRef.current.cancelKeepStream()
      nativeSttServiceRef.current.cancel()
      nativeEngineStartedRef.current = false
      nativeStartingRef.current = false
      httpStartingRef.current = false
      setSttState('idle')
      setCurrentTranscript('')

      ttsQueueRef.current = []
      audioPlayerRef.current.stop()
      isProcessingQueueRef.current = false
      setTtsState('idle')
      setSpeakingMessageId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVoiceModeActive])

  // ── Auto-start TTS server for HTTP STT (macOS) ──
  // On macOS WKWebView, the Web Speech API is not available, so we use
  // HTTP STT which requires the TTS server (Whisper) to be running.
  // Mic permission is handled by startHttpListening() via ensureMicPermission()
  // — no duplicate check here.

  useEffect(() => {
    if (!isVoiceModeActive || !useHttpStt) return

    let cancelled = false

    ;(async () => {
      // Ensure mic permission is granted before starting the TTS server.
      // Uses the module-level deduplicating helper so concurrent effects
      // won't trigger multiple TCC dialogs.
      if (IS_TAURI && IS_MACOS) {
        await ensureMicPermission()
      }

      // Start TTS server if not already running
      if (!ttsServerPort) {
        try {
          const running = await invoke<boolean>('plugin:tts|is_tts_running')
          let port: number
          if (running) {
            port = await invoke<number>('plugin:tts|get_tts_port')
          } else {
            const result = await invoke<{ port: number; pid: number }>(
              'plugin:tts|start_tts_server'
            )
            port = result.port
          }
          if (!cancelled) {
            useSpeechStore.getState().setTtsServerPort(port)
          }
        } catch (err) {
          console.error('[Speech] Failed to auto-start TTS server:', err)
          if (!cancelled) {
            setSttError(
              'Speech server failed to start. Go to Settings → Speech to troubleshoot.'
            )
            setSttState('error')
          }
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isVoiceModeActive, useHttpStt, ttsServerPort, setSttError, setSttState])

  // ── Start STT when TTS server becomes available during voice mode ─────
  // After the TTS server starts and the port is set, the TTS client effect
  // (above) creates the client. This effect then kicks off STT.

  useEffect(() => {
    if (!isVoiceModeActive || !useHttpStt || !ttsServerPort) return

    const store = useSpeechStore.getState()
    if (
      store.sttState === 'idle' &&
      store.ttsState === 'idle' &&
      chatStatus !== 'streaming' &&
      chatStatus !== 'submitted'
    ) {
      startListeningInternal()
    }
  }, [
    ttsServerPort,
    isVoiceModeActive,
    useHttpStt,
    chatStatus,
    startListeningInternal,
  ])

  // ── Auto-start STT when chat becomes ready ───────────────────────────
  // After the assistant finishes responding and TTS is idle, restart STT

  useEffect(() => {
    if (!isVoiceModeActive) return
    if (chatStatus !== 'ready') return
    // Don't attempt HTTP STT before TTS server is ready — let the
    // ttsServerPort watch effect (above) handle that case instead.
    if (useHttpStt && !useNativeStt && !ttsServerPort) return

    const store = useSpeechStore.getState()
    if (store.ttsState === 'idle' && store.sttState === 'idle') {
      // Small delay to avoid immediately restarting after the stream ends
      // and to let TTS queue processing finish first
      const timer = setTimeout(() => {
        const current = useSpeechStore.getState()
        if (
          current.isVoiceModeActive &&
          current.ttsState === 'idle' &&
          current.sttState === 'idle'
        ) {
          startListeningInternal()
        }
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [chatStatus, isVoiceModeActive, useHttpStt, useNativeStt, ttsServerPort, startListeningInternal])

  // ── Stop STT when chat starts streaming ──────────────────────────────
  // If the model starts responding, stop listening

  useEffect(() => {
    if (
      (chatStatus === 'streaming' || chatStatus === 'submitted') &&
      sttState === 'listening'
    ) {
      sttServiceRef.current.stop()
      httpSttServiceRef.current.stop()
      nativeSttServiceRef.current.stop()
      setSttState('idle')
    }
  }, [chatStatus, sttState, setSttState])

  // ── Cleanup on unmount ───────────────────────────────────────────────

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      sttServiceRef.current.cancel()
      httpSttServiceRef.current.cancelKeepStream()
      nativeSttServiceRef.current.cancel()
      nativeEngineStartedRef.current = false
      nativeStartingRef.current = false
      httpStartingRef.current = false
      audioPlayerRef.current.stop()
      ttsQueueRef.current = []
      isProcessingQueueRef.current = false
    }
  }, [])

  // Reset state when thread changes
  useEffect(() => {
    // Stop any ongoing speech operations when switching threads.
    // Use cancelKeepStream for HTTP STT to preserve the MediaStream —
    // avoids re-triggering getUserMedia permission dialogs on thread change.
    sttServiceRef.current.cancel()
    httpSttServiceRef.current.cancelKeepStream()
    nativeSttServiceRef.current.cancel()
    nativeEngineStartedRef.current = false
    nativeStartingRef.current = false
    httpStartingRef.current = false
    audioPlayerRef.current.stop()
    ttsQueueRef.current = []
    isProcessingQueueRef.current = false
    sentenceBufferRef.current = new SentenceBuffer()
    prevTextLenRef.current = 0
    lastAssistantIdRef.current = null

    setSttState('idle')
    setCurrentTranscript('')
    setTtsState('idle')
    setSpeakingMessageId(null)
  }, [threadId, setSttState, setCurrentTranscript, setTtsState, setSpeakingMessageId])

  // ── Return values ────────────────────────────────────────────────────

  return {
    isVoiceModeActive,
    isOverlayOpen,
    isSttSupported,
    toggleVoiceMode,
    setOverlayOpen,
    sttState,
    sttError,
    currentTranscript,
    ttsState,
    startListening,
    stopListening,
    stopSpeaking,
    speakMessage,
  }
}
