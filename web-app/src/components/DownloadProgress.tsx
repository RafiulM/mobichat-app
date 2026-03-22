import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useDownloadActions } from '@/hooks/useDownloadActions'
import { renderGB, formatSpeed, formatETA } from '@/lib/download-utils'
import { IconX } from '@tabler/icons-react'
import { Loader } from 'lucide-react'
import { useMemo } from 'react'

type DownloadProgressProps = {
  modelId: string
  variant?: 'compact' | 'expanded'
}

export function DownloadProgress({
  modelId,
  variant = 'compact',
}: DownloadProgressProps) {
  const { cancelDownload } = useDownloadActions()

  // Look up by exact key first, then fallback to searching by name
  // to handle cases where the store key differs from the UI's model ID
  const download = useDownloadStore((state) => {
    const exact = state.downloads[modelId]
    if (exact) return exact
    return Object.values(state.downloads).find((d) => d.name === modelId)
  })

  const progress = download?.progress || 0
  const current = download?.current || 0
  const total = download?.total || 0
  const speed = download?.speed || 0
  const hasProgress = total > 0

  const eta = useMemo(() => {
    if (total <= 0 || speed <= 0) return ''
    return formatETA(total - current, speed)
  }, [total, current, speed])

  const handleCancel = () => {
    cancelDownload(modelId)
  }

  if (variant === 'expanded') {
    return (
      <div className="flex flex-col gap-1.5 w-full min-w-[180px]">
        <div className="flex items-center gap-2">
          {hasProgress ? (
            <Progress className="border flex-1" value={progress * 100} />
          ) : (
            <div className="flex-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader className="size-3 animate-spin" />
              <span>Starting download...</span>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleCancel}
            className="shrink-0"
          >
            <IconX size={14} className="text-muted-foreground" />
          </Button>
        </div>
        {hasProgress && (
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {Math.round(progress * 100)}%
              {speed > 0 && ` · ${formatSpeed(speed)}`}
            </span>
            <span>
              {`${renderGB(current)} / ${renderGB(total)} GB`}
              {eta && ` · ${eta}`}
            </span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex items-center gap-2">
        {hasProgress ? (
          <>
            <Progress className="border flex-1" value={progress * 100} />
            <span className="text-xs text-muted-foreground shrink-0 w-8 text-right">
              {Math.round(progress * 100)}%
            </span>
          </>
        ) : (
          <div className="flex-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader className="size-3 animate-spin" />
            <span>Starting...</span>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleCancel}
          className="shrink-0"
        >
          <IconX size={14} className="text-muted-foreground" />
        </Button>
      </div>
      {hasProgress && (
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{`${renderGB(current)} / ${renderGB(total)} GB`}</span>
          <span>{speed > 0 && formatSpeed(speed)}</span>
        </div>
      )}
    </div>
  )
}
