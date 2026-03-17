import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'

export interface SpeechState {
  // Voice mode
  isVoiceModeActive: boolean
  isOverlayOpen: boolean

  // STT state
  sttState: 'idle' | 'listening' | 'processing' | 'error'
  currentTranscript: string
  sttError: string | null

  // TTS state
  ttsState: 'idle' | 'loading' | 'speaking'
  ttsServerPort: number | null
  ttsModelLoaded: boolean
  speakingMessageId: string | null

  // Settings (persisted)
  ttsVoice: string
  ttsSpeed: number
  ttsInstruct: string
  ttsModelId: string | null
  autoSpeakResponses: boolean

  // Actions
  toggleVoiceMode: () => void
  setOverlayOpen: (open: boolean) => void
  setSttState: (state: SpeechState['sttState']) => void
  setCurrentTranscript: (transcript: string) => void
  setSttError: (error: string | null) => void
  setTtsState: (state: SpeechState['ttsState']) => void
  setTtsServerPort: (port: number | null) => void
  setTtsModelLoaded: (loaded: boolean) => void
  setSpeakingMessageId: (id: string | null) => void
  updateTtsSettings: (settings: {
    voice?: string
    speed?: number
    instruct?: string
    modelId?: string
  }) => void
  setAutoSpeakResponses: (auto: boolean) => void
  reset: () => void
}

const defaultState = {
  // Voice mode
  isVoiceModeActive: false,
  isOverlayOpen: false,

  // STT state
  sttState: 'idle' as const,
  currentTranscript: '',
  sttError: null,

  // TTS state
  ttsState: 'idle' as const,
  ttsServerPort: null,
  ttsModelLoaded: false,
  speakingMessageId: null,

  // Settings (persisted)
  ttsVoice: 'serena',
  ttsSpeed: 1.0,
  ttsInstruct: 'Normal tone',
  ttsModelId: null,
  autoSpeakResponses: true,
}

export const useSpeechStore = create<SpeechState>()(
  persist(
    (set) => ({
      ...defaultState,

      toggleVoiceMode: () =>
        set((state) => ({
          isVoiceModeActive: !state.isVoiceModeActive,
          // When activating voice mode, open the overlay
          isOverlayOpen: !state.isVoiceModeActive ? true : state.isOverlayOpen,
        })),

      setOverlayOpen: (open) => set({ isOverlayOpen: open }),

      setSttState: (sttState) => set({ sttState }),

      setCurrentTranscript: (currentTranscript) => set({ currentTranscript }),

      setSttError: (sttError) => set({ sttError }),

      setTtsState: (ttsState) => set({ ttsState }),

      setTtsServerPort: (ttsServerPort) => set({ ttsServerPort }),

      setTtsModelLoaded: (ttsModelLoaded) => set({ ttsModelLoaded }),

      setSpeakingMessageId: (speakingMessageId) => set({ speakingMessageId }),

      updateTtsSettings: (settings) =>
        set((state) => ({
          ...(settings.voice !== undefined && { ttsVoice: settings.voice }),
          ...(settings.speed !== undefined && { ttsSpeed: settings.speed }),
          ...(settings.instruct !== undefined && {
            ttsInstruct: settings.instruct,
          }),
          ...(settings.modelId !== undefined && {
            ttsModelId: settings.modelId,
          }),
          // Preserve existing values for fields not provided
          ttsVoice: settings.voice ?? state.ttsVoice,
          ttsSpeed: settings.speed ?? state.ttsSpeed,
          ttsInstruct: settings.instruct ?? state.ttsInstruct,
          ttsModelId:
            settings.modelId !== undefined
              ? settings.modelId
              : state.ttsModelId,
        })),

      setAutoSpeakResponses: (autoSpeakResponses) =>
        set({ autoSpeakResponses }),

      reset: () =>
        set({
          // Reset runtime state but keep persisted settings
          isVoiceModeActive: false,
          isOverlayOpen: false,
          sttState: 'idle',
          currentTranscript: '',
          sttError: null,
          ttsState: 'idle',
          ttsServerPort: null,
          ttsModelLoaded: false,
          speakingMessageId: null,
        }),
    }),
    {
      name: localStorageKey.speechSettings,
      storage: createJSONStorage(() => localStorage),
      // Only persist settings fields to localStorage
      partialize: (state) => ({
        ttsVoice: state.ttsVoice,
        ttsSpeed: state.ttsSpeed,
        ttsInstruct: state.ttsInstruct,
        ttsModelId: state.ttsModelId,
        autoSpeakResponses: state.autoSpeakResponses,
      }),
    }
  )
)
