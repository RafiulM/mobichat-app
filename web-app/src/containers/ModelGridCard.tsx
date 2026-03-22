import { cn } from '@/lib/utils'
import { extractDescription } from '@/lib/models'
import { IconDownload, IconEye, IconTool } from '@tabler/icons-react'
import { Loader } from 'lucide-react'
import { DownloadButtonPlaceholder } from '@/containers/DownloadButton'
import { MlxModelDownloadAction } from '@/containers/MlxModelDownloadAction'
import type { CatalogModel, ModelQuant } from '@/services/models/types'

type Props = {
  model: CatalogModel
  defaultVariant: ModelQuant | undefined
  supportStatus: 'RED' | 'YELLOW' | 'GREEN' | 'LOADING' | undefined
  handleUseModel: (modelId: string) => void
  formatDownloads: (count: number) => string
  onClick: () => void
}

function getDisplayName(model: CatalogModel) {
  const name = model.model_name
  return name
    .replace(/^.*\//, '')
    .replace(/-GGUF$/i, '')
    .replace(/-gguf$/i, '')
}

function getPlainDescription(model: CatalogModel): string {
  const raw = extractDescription(model.description)
  if (!raw) return 'General-purpose language model'
  // Strip remaining markdown
  return raw.replace(/[#*_\[\]]/g, '').replace(/\(.*?\)/g, '').trim()
}

function getSupportChip(status: Props['supportStatus']) {
  if (!status || status === 'LOADING') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground whitespace-nowrap">
        {status === 'LOADING' ? (
          <span className="inline-flex items-center gap-1">
            <Loader className="size-2.5 animate-spin" />
            Checking
          </span>
        ) : (
          'Checking...'
        )}
      </span>
    )
  }
  const config: Record<string, { label: string; classes: string }> = {
    GREEN: {
      label: 'Compatible',
      classes: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    },
    YELLOW: {
      label: 'Marginal',
      classes: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    },
    RED: {
      label: 'Too large',
      classes: 'bg-red-500/10 text-red-600 dark:text-red-400',
    },
  }
  const c = config[status]
  return (
    <span className={cn('text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap', c.classes)}>
      {c.label}
    </span>
  )
}

export default function ModelGridCard({
  model,
  defaultVariant,
  supportStatus,
  handleUseModel,
  formatDownloads,
  onClick,
}: Props) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'relative flex flex-col bg-card border border-border rounded-[14px] p-3.5 gap-2.5 cursor-pointer transition-all',
        'hover:border-foreground/20 hover:shadow-sm',
        supportStatus === 'RED' && 'opacity-50'
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate">
            {getDisplayName(model)}
          </h3>
          {defaultVariant?.file_size && (
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {defaultVariant.file_size}
            </p>
          )}
        </div>
        {!model.is_mlx && (
          <div className="shrink-0">{getSupportChip(supportStatus)}</div>
        )}
      </div>

      {/* Description */}
      <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
        {getPlainDescription(model)}
      </p>

      {/* Badges row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {(model.num_mmproj ?? 0) > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
            <IconEye size={10} />
            Vision
          </span>
        )}
        {model.tools && (
          <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
            <IconTool size={10} />
            Tools
          </span>
        )}
        <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
          {model.is_mlx ? 'MLX' : 'GGUF'}
        </span>
        {model.downloads > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
            <IconDownload size={10} />
            {formatDownloads(model.downloads)}
          </span>
        )}
      </div>

      {/* Download action */}
      <div
        className="mt-auto pt-1"
        onClick={(e) => e.stopPropagation()}
      >
        {model.is_mlx ? (
          <MlxModelDownloadAction model={model} />
        ) : (
          <DownloadButtonPlaceholder
            model={model}
            handleUseModel={handleUseModel}
          />
        )}
      </div>
    </div>
  )
}
