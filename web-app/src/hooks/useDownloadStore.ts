import { create } from 'zustand'

export interface DownloadProgressProps {
  id: string
  progress: number
  name: string
  current: number
  total: number
  speed: number
  lastUpdated: number
}

// Zustand store for thinking block state
export type DownloadState = {
  downloads: { [id: string]: DownloadProgressProps }
  localDownloadingModels: Set<string>
  removeDownload: (id: string) => void
  updateProgress: (
    id: string,
    progress: number,
    name?: string,
    current?: number,
    total?: number
  ) => void
  addLocalDownloadingModel: (modelId: string) => void
  removeLocalDownloadingModel: (modelId: string) => void
}

/**
 * This store is used to manage the download progress of files.
 */
export const useDownloadStore = create<DownloadState>((set) => ({
  downloads: {},
  localDownloadingModels: new Set(),
  removeDownload: (id: string) =>
    set((state) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [id]: _, ...rest } = state.downloads
      return { downloads: rest }
    }),

  updateProgress: (id, progress, name, current, total) =>
    set((state) => {
      const prev = state.downloads[id]
      const now = Date.now()
      const prevCurrent = prev?.current || 0
      const prevTime = prev?.lastUpdated || now
      const timeDelta = (now - prevTime) / 1000
      const bytesDelta = (current || 0) - prevCurrent
      const speed =
        timeDelta > 0 && bytesDelta > 0
          ? bytesDelta / timeDelta
          : prev?.speed || 0

      return {
        downloads: {
          ...state.downloads,
          [id]: {
            ...prev,
            id,
            name: name || prev?.name || '',
            progress,
            current: current || prev?.current || 0,
            total: total || prev?.total || 0,
            speed,
            lastUpdated: now,
          },
        },
      }
    }),

  addLocalDownloadingModel: (modelId: string) =>
    set((state) => ({
      localDownloadingModels: new Set(state.localDownloadingModels).add(
        modelId
      ),
    })),

  removeLocalDownloadingModel: (modelId: string) =>
    set((state) => {
      const newSet = new Set(state.localDownloadingModels)
      newSet.delete(modelId)
      return { localDownloadingModels: newSet }
    }),
}))
