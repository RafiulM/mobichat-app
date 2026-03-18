import { useState, useEffect, useCallback, useRef } from 'react'
import { useSpeechStore } from '@/stores/speech-store'
import { TTSClient } from '@/lib/speech/tts-client'
import { invoke } from '@tauri-apps/api/core'
import type { TtsModelInfo } from '@/lib/speech/types'

export type ServerStatus = 'idle' | 'starting' | 'ready' | 'error'

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    // Tauri invoke errors are often plain objects with a message field
    if ('message' in err && typeof (err as { message: unknown }).message === 'string') {
      return (err as { message: string }).message
    }
    try {
      return JSON.stringify(err)
    } catch {
      return 'Unknown error'
    }
  }
  return 'Unknown error'
}

export function useTtsSettings() {
  const [serverStatus, setServerStatus] = useState<ServerStatus>('idle')
  const [serverError, setServerError] = useState<string | null>(null)
  const [models, setModels] = useState<TtsModelInfo[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState<Record<string, string>>({})
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const ttsClientRef = useRef<TTSClient | null>(null)

  const setTtsServerPort = useSpeechStore((s) => s.setTtsServerPort)
  const ttsVoice = useSpeechStore((s) => s.ttsVoice)
  const ttsSpeed = useSpeechStore((s) => s.ttsSpeed)
  const ttsInstruct = useSpeechStore((s) => s.ttsInstruct)
  const autoSpeakResponses = useSpeechStore((s) => s.autoSpeakResponses)
  const updateTtsSettings = useSpeechStore((s) => s.updateTtsSettings)
  const setAutoSpeakResponses = useSpeechStore((s) => s.setAutoSpeakResponses)

  const isServerReady = serverStatus === 'ready'

  // Start server on mount
  useEffect(() => {
    let cancelled = false

    async function initServer() {
      setServerStatus('starting')
      setServerError(null)
      try {
        const running = await invoke<boolean>('plugin:tts|is_tts_running')
        let port: number
        if (running) {
          port = await invoke<number>('plugin:tts|get_tts_port')
        } else {
          const result = await invoke<{ port: number; pid: number }>('plugin:tts|start_tts_server')
          port = result.port
        }
        if (cancelled) return
        setTtsServerPort(port)
        ttsClientRef.current = new TTSClient(port)
        setServerStatus('ready')
      } catch (err) {
        console.error('Failed to start TTS server:', err)
        if (!cancelled) {
          setServerStatus('error')
          setServerError(formatError(err))
        }
      }
    }

    initServer()
    return () => { cancelled = true }
  }, [setTtsServerPort])

  const fetchModels = useCallback(async (retries = 3): Promise<void> => {
    if (!ttsClientRef.current) return
    setModelsLoading(true)
    setModelsError(null)
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const list = await ttsClientRef.current.getModels()
        setModels(list)
        setModelsLoading(false)
        return
      } catch (err) {
        console.error(`Failed to fetch TTS models (attempt ${attempt + 1}/${retries}):`, err)
        if (attempt < retries - 1) {
          // Wait before retrying — server may still be initializing
          await new Promise((r) => setTimeout(r, 2000))
        } else {
          setModelsError(formatError(err))
          setModelsLoading(false)
        }
      }
    }
  }, [])

  // Fetch models when server is ready
  useEffect(() => {
    if (!isServerReady || !ttsClientRef.current) return
    fetchModels()
  }, [isServerReady, fetchModels])

  const downloadModel = useCallback(async (model: TtsModelInfo) => {
    if (!ttsClientRef.current) return
    setLoadingModels((prev) => ({ ...prev, [model.id]: 'downloading' }))
    try {
      await ttsClientRef.current.downloadModel(model.repo_id)
      await fetchModels()
    } catch (err) {
      console.error('Failed to download model:', err)
    } finally {
      setLoadingModels((prev) => {
        const next = { ...prev }
        delete next[model.id]
        return next
      })
    }
  }, [fetchModels])

  const loadModel = useCallback(async (model: TtsModelInfo) => {
    if (!ttsClientRef.current) return
    setLoadingModels((prev) => ({ ...prev, [model.id]: 'loading' }))
    try {
      await ttsClientRef.current.loadModel(model.id)
      updateTtsSettings({ modelId: model.id })
      await fetchModels()
    } catch (err) {
      console.error('Failed to load model:', err)
    } finally {
      setLoadingModels((prev) => {
        const next = { ...prev }
        delete next[model.id]
        return next
      })
    }
  }, [fetchModels, updateTtsSettings])

  const unloadModel = useCallback(async () => {
    if (!ttsClientRef.current) return
    try {
      await ttsClientRef.current.unloadModel()
      updateTtsSettings({ modelId: undefined })
      await fetchModels()
    } catch (err) {
      console.error('Failed to unload model:', err)
    }
  }, [fetchModels, updateTtsSettings])

  const previewVoice = useCallback(async (voice: string) => {
    if (!ttsClientRef.current) return
    // Stop any currently playing preview
    if (previewAudioRef.current) {
      previewAudioRef.current.pause()
      previewAudioRef.current = null
    }
    setIsPreviewPlaying(true)
    try {
      const blob = await ttsClientRef.current.generateAudio(
        'Hello! This is a preview of my voice. How does it sound?',
        { voice, speed: ttsSpeed, instruct: ttsInstruct }
      )
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      previewAudioRef.current = audio
      audio.onended = () => {
        setIsPreviewPlaying(false)
        URL.revokeObjectURL(url)
        previewAudioRef.current = null
      }
      audio.onerror = () => {
        setIsPreviewPlaying(false)
        URL.revokeObjectURL(url)
        previewAudioRef.current = null
      }
      await audio.play()
    } catch (err) {
      console.error('Failed to preview voice:', err)
      setIsPreviewPlaying(false)
    }
  }, [ttsSpeed, ttsInstruct])

  const stopPreview = useCallback(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause()
      previewAudioRef.current = null
    }
    setIsPreviewPlaying(false)
  }, [])

  const updateVoice = useCallback(async (voice: string) => {
    updateTtsSettings({ voice })
    if (ttsClientRef.current) {
      try {
        await ttsClientRef.current.updateSettings({ voice })
      } catch (err) {
        console.error('Failed to sync voice to server:', err)
      }
    }
  }, [updateTtsSettings])

  const updateSpeed = useCallback(async (speed: number) => {
    updateTtsSettings({ speed })
    if (ttsClientRef.current) {
      try {
        await ttsClientRef.current.updateSettings({ speed })
      } catch (err) {
        console.error('Failed to sync speed to server:', err)
      }
    }
  }, [updateTtsSettings])

  const retryServer = useCallback(async () => {
    setServerStatus('starting')
    setServerError(null)
    try {
      const running = await invoke<boolean>('plugin:tts|is_tts_running')
      let port: number
      if (running) {
        port = await invoke<number>('plugin:tts|get_tts_port')
      } else {
        const result = await invoke<{ port: number; pid: number }>('plugin:tts|start_tts_server')
        port = result.port
      }
      setTtsServerPort(port)
      ttsClientRef.current = new TTSClient(port)
      setServerStatus('ready')
    } catch (err) {
      console.error('Failed to start TTS server:', err)
      setServerStatus('error')
      setServerError(err instanceof Error ? err.message : String(err))
    }
  }, [setTtsServerPort])

  return {
    serverStatus,
    serverError,
    isServerReady,
    retryServer,
    models,
    modelsLoading,
    modelsError,
    refetchModels: fetchModels,
    loadingModels,
    downloadModel,
    loadModel,
    unloadModel,
    previewVoice,
    stopPreview,
    isPreviewPlaying,
    ttsVoice,
    ttsSpeed,
    autoSpeakResponses,
    updateVoice,
    updateSpeed,
    setAutoSpeakResponses,
  }
}
