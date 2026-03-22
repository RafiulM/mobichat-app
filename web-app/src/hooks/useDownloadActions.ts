import { useServiceHub } from '@/hooks/useServiceHub'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useCallback } from 'react'

export function useDownloadActions() {
  const serviceHub = useServiceHub()
  const removeDownload = useDownloadStore((state) => state.removeDownload)
  const removeLocalDownloadingModel = useDownloadStore(
    (state) => state.removeLocalDownloadingModel
  )

  const cancelDownload = useCallback(
    async (downloadId: string) => {
      if (
        downloadId.startsWith('llamacpp') ||
        downloadId.startsWith('mlx')
      ) {
        const downloadManager =
          window.core.extensionManager.getByName('@janhq/download-extension')
        downloadManager.cancelDownload(downloadId)
      } else {
        await serviceHub.models().abortDownload(downloadId)
      }
      removeDownload(downloadId)
      removeLocalDownloadingModel(downloadId)
    },
    [serviceHub, removeDownload, removeLocalDownloadingModel]
  )

  return { cancelDownload }
}
