import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'

type ThinkingModeState = {
  /** Map of threadId → thinking mode enabled */
  thinkingThreads: Record<string, boolean>

  isThinkingEnabled: (threadId: string) => boolean
  toggleThinking: (threadId: string) => void
  setThinking: (threadId: string, enabled: boolean) => void
  removeThread: (threadId: string) => void
}

export const useThinkingMode = create<ThinkingModeState>()(
  persist(
    (set, get) => ({
      thinkingThreads: {},

      isThinkingEnabled: (threadId) => {
        return get().thinkingThreads[threadId] === true
      },

      toggleThinking: (threadId) => {
        set((state) => ({
          thinkingThreads: {
            ...state.thinkingThreads,
            [threadId]: !state.thinkingThreads[threadId],
          },
        }))
      },

      setThinking: (threadId, enabled) => {
        set((state) => ({
          thinkingThreads: {
            ...state.thinkingThreads,
            [threadId]: enabled,
          },
        }))
      },

      removeThread: (threadId) => {
        set((state) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [threadId]: _removed, ...rest } = state.thinkingThreads
          return { thinkingThreads: rest }
        })
      },
    }),
    {
      name: localStorageKey.thinkingMode,
      storage: createJSONStorage(() => localStorage),
    }
  )
)
