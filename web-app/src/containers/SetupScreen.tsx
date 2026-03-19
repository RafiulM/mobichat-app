import { useModelProvider } from '@/hooks/useModelProvider'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { localStorageKey } from '@/constants/localStorage'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useEffect, useMemo, useCallback, useState, useRef } from 'react'
import { AppEvent, events } from '@janhq/core'
import { Button } from '@/components/ui/button'
import {
  IconCpu,
  IconDeviceDesktop,
  IconServer,
  IconDatabase,
  IconBrandApple,
  IconCheck,
  IconDownload,
  IconMessageCircle,
  IconArrowRight,
} from '@tabler/icons-react'
import { cn, formatMegaBytes } from '@/lib/utils'
import { useHardware } from '@/hooks/useHardware'
import { useModelSources } from '@/hooks/useModelSources'
import { useShallow } from 'zustand/shallow'
import type { CatalogModel, ModelQuant } from '@/services/models/types'
import { DEFAULT_MODEL_QUANTIZATIONS } from '@/constants/models'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'

type Step = 'system' | 'models' | 'done'

const STEPS: { key: Step; label: string }[] = [
  { key: 'system', label: 'System' },
  { key: 'models', label: 'Models' },
  { key: 'done', label: 'Done' },
]

type SelectedModel = {
  catalog: CatalogModel
  variant: ModelQuant
}

function SetupScreen() {
  const navigate = useNavigate()
  const { selectModelProvider, setProviders } = useModelProvider()
  const { downloads, localDownloadingModels, addLocalDownloadingModel } =
    useDownloadStore()
  const serviceHub = useServiceHub()
  const { hardwareData, systemUsage } = useHardware()
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)

  const { sources, fetchSources, loading: sourcesLoading } = useModelSources(
    useShallow((state) => ({
      sources: state.sources,
      fetchSources: state.fetchSources,
      loading: state.loading,
    }))
  )

  const [currentStep, setCurrentStep] = useState<Step>('system')
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [modelSupport, setModelSupport] = useState<
    Record<string, 'RED' | 'YELLOW' | 'GREEN' | 'GREY' | 'LOADING'>
  >({})
  const [downloadsStarted, setDownloadsStarted] = useState(false)
  const importedModelsRef = useRef<Set<string>>(new Set())

  // Fetch model catalog on mount
  useEffect(() => {
    fetchSources()
  }, [fetchSources])

  // Fetch system usage on mount
  useEffect(() => {
    serviceHub
      .hardware()
      .getSystemUsage()
      .then((data) => {
        if (data) {
          useHardware.getState().updateSystemUsage(data)
        }
      })
      .catch(console.error)

    serviceHub
      .hardware()
      .getHardwareInfo()
      .then((data) => {
        if (data) {
          useHardware.getState().setHardwareData(data)
        }
      })
      .catch(console.error)
  }, [serviceHub])

  // Calculate capability score (0-100)
  const capabilityScore = useMemo(() => {
    const totalRamMB = hardwareData.total_memory
    if (!totalRamMB) return 0
    const totalRamGB = totalRamMB / 1024
    // Score based on RAM: 8GB=40, 16GB=65, 32GB=85, 64GB+=100
    const ramScore = Math.min(100, Math.max(0, (totalRamGB / 64) * 100))
    const coreScore = Math.min(
      100,
      Math.max(0, (hardwareData.cpu.core_count / 16) * 100)
    )
    return Math.round(ramScore * 0.7 + coreScore * 0.3)
  }, [hardwareData])

  const capabilityLabel = useMemo(() => {
    if (capabilityScore >= 70) return { text: 'Good', color: 'bg-emerald-500' }
    if (capabilityScore >= 40)
      return { text: 'Moderate', color: 'bg-amber-500' }
    return { text: 'Limited', color: 'bg-red-500' }
  }, [capabilityScore])

  const availableRamMB = useMemo(() => {
    if (!hardwareData.total_memory || !systemUsage.used_memory) return 0
    return hardwareData.total_memory - systemUsage.used_memory
  }, [hardwareData.total_memory, systemUsage.used_memory])

  // Get models suitable for the grid — filter to non-MLX GGUF models, sorted by downloads
  const gridModels = useMemo(() => {
    return sources
      .filter((m) => !m.is_mlx && (m.quants?.length ?? 0) > 0)
      .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
      .slice(0, 9)
  }, [sources])

  // Get default variant for a model
  const getDefaultVariant = useCallback(
    (model: CatalogModel): ModelQuant | undefined => {
      for (const q of DEFAULT_MODEL_QUANTIZATIONS) {
        const variant = model.quants?.find((v) =>
          v.model_id.toLowerCase().includes(q)
        )
        if (variant) return variant
      }
      return model.quants?.[0]
    },
    []
  )

  // Check model support for grid models
  useEffect(() => {
    if (gridModels.length === 0) return

    const checkSupport = async () => {
      for (const model of gridModels) {
        const variant = getDefaultVariant(model)
        if (!variant) continue
        const key = variant.model_id
        if (modelSupport[key] && modelSupport[key] !== 'LOADING') continue

        setModelSupport((prev) => ({ ...prev, [key]: 'LOADING' }))
        try {
          const status = await serviceHub
            .models()
            .isModelSupported(variant.path)
          setModelSupport((prev) => ({ ...prev, [key]: status }))
        } catch {
          setModelSupport((prev) => ({ ...prev, [key]: 'GREY' }))
        }
      }
    }

    checkSupport()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridModels, serviceHub])

  // Toggle model selection
  const toggleModel = useCallback(
    (modelName: string) => {
      setSelectedModels((prev) => {
        const next = new Set(prev)
        if (next.has(modelName)) {
          next.delete(modelName)
        } else {
          next.add(modelName)
        }
        return next
      })
    },
    []
  )

  // Get selected model details for download
  const selectedModelDetails = useMemo((): SelectedModel[] => {
    return gridModels
      .filter((m) => selectedModels.has(m.model_name))
      .map((m) => ({
        catalog: m,
        variant: getDefaultVariant(m)!,
      }))
      .filter((m) => m.variant)
  }, [gridModels, selectedModels, getDefaultVariant])

  // Total download size
  const totalDownloadSize = useMemo(() => {
    return selectedModelDetails.reduce((acc, m) => {
      const sizeStr = m.variant.file_size || '0'
      const match = sizeStr.match(/([\d.]+)\s*(GB|MB)/i)
      if (match) {
        const value = parseFloat(match[1])
        const unit = match[2].toUpperCase()
        return acc + (unit === 'GB' ? value : value / 1024)
      }
      return acc
    }, 0)
  }, [selectedModelDetails])

  // Start downloads for selected models
  const startDownloads = useCallback(() => {
    setDownloadsStarted(true)
    for (const { catalog, variant } of selectedModelDetails) {
      addLocalDownloadingModel(variant.model_id)
      const mmprojPath = (
        catalog.mmproj_models?.find(
          (e) => e.model_id.toLowerCase() === 'mmproj-f16'
        ) || catalog.mmproj_models?.[0]
      )?.path
      serviceHub
        .models()
        .pullModelWithMetadata(
          variant.model_id,
          variant.path,
          mmprojPath,
          huggingfaceToken,
          true
        )
    }
    setCurrentStep('done')
  }, [
    selectedModelDetails,
    addLocalDownloadingModel,
    serviceHub,
    huggingfaceToken,
  ])

  // Track download progress for selected models
  const downloadProgress = useMemo(() => {
    return selectedModelDetails.map(({ variant }) => {
      const dl = Object.values(downloads).find(
        (d) => d.name === variant.model_id
      )
      const isActive =
        localDownloadingModels.has(variant.model_id) || !!dl
      return {
        modelId: variant.model_id,
        isActive,
        progress: dl?.progress ?? 0,
        current: dl?.current ?? 0,
        total: dl?.total ?? 0,
        imported: importedModelsRef.current.has(variant.model_id),
      }
    })
  }, [selectedModelDetails, downloads, localDownloadingModels])

  const allDownloadsComplete = useMemo(() => {
    if (!downloadsStarted || selectedModelDetails.length === 0) return false
    return selectedModelDetails.every((m) =>
      importedModelsRef.current.has(m.variant.model_id)
    )
  }, [downloadsStarted, selectedModelDetails])

  // Listen for model import events
  useEffect(() => {
    const onModelImported = async (payload: { modelId: string }) => {
      importedModelsRef.current.add(payload.modelId)

      // Refresh providers
      const providers = await serviceHub.providers().getProviders()
      setProviders(providers)
    }

    events.on(AppEvent.onModelImported, onModelImported)
    return () => {
      events.off(AppEvent.onModelImported, onModelImported)
    }
  }, [serviceHub, setProviders])

  // Finish setup and navigate home
  const finishSetup = useCallback(() => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')

    // Try to select the first imported model
    const firstImported = selectedModelDetails.find((m) =>
      importedModelsRef.current.has(m.variant.model_id)
    )
    if (firstImported) {
      const catalogId = firstImported.variant.model_id
      const backslashId = catalogId.replace(/\//g, '\\')
      const found =
        selectModelProvider('llamacpp', catalogId) ||
        selectModelProvider('llamacpp', backslashId)
      const modelId = found ? found.id : catalogId
      localStorage.setItem(
        localStorageKey.lastUsedModel,
        JSON.stringify({ provider: 'llamacpp', model: modelId })
      )
      navigate({
        to: route.home,
        replace: true,
        search: { threadModel: { id: modelId, provider: 'llamacpp' } },
      })
    } else {
      navigate({ to: route.home, replace: true })
    }
  }, [selectedModelDetails, selectModelProvider, navigate])

  // Skip setup
  const skipSetup = useCallback(() => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    navigate({ to: route.home, replace: true })
  }, [navigate])

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0'
    const gb = bytes / (1024 * 1024 * 1024)
    if (gb >= 1) return `${gb.toFixed(1)} GB`
    const mb = bytes / (1024 * 1024)
    return `${mb.toFixed(0)} MB`
  }

  // System specs data
  const specs = useMemo(
    () => [
      {
        icon: IconServer,
        label: 'RAM',
        value: formatMegaBytes(hardwareData.total_memory),
      },
      {
        icon: IconCpu,
        label: 'Chip',
        value:
          hardwareData.cpu.name?.split(' ').slice(0, 3).join(' ') || 'Unknown',
      },
      {
        icon: IconDatabase,
        label: 'Available RAM',
        value: formatMegaBytes(availableRamMB),
      },
      {
        icon: IconDeviceDesktop,
        label: 'CPU Cores',
        value: `${hardwareData.cpu.core_count} cores`,
      },
      {
        icon: IconBrandApple,
        label: 'OS',
        value: hardwareData.os_name || 'Unknown',
      },
      {
        icon: IconCpu,
        label: 'Architecture',
        value: hardwareData.cpu.arch || 'Unknown',
      },
    ],
    [hardwareData, availableRamMB]
  )

  const stepIndex = STEPS.findIndex((s) => s.key === currentStep)

  return (
    <div className="relative flex flex-col h-svh w-full overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center justify-end h-12 px-6 shrink-0">
        <button
          onClick={skipSetup}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          Skip setup
        </button>
      </div>

      {/* Step indicators */}
      <div className="flex items-center justify-center gap-6 py-3 shrink-0">
        {STEPS.map((step, i) => (
          <div key={step.key} className="flex items-center gap-2">
            <div
              className={cn(
                'size-2 rounded-full transition-colors',
                i < stepIndex
                  ? 'bg-emerald-500'
                  : i === stepIndex
                    ? 'bg-primary'
                    : 'bg-muted-foreground/30'
              )}
            />
            <span
              className={cn(
                'text-xs font-medium transition-colors',
                i === stepIndex
                  ? 'text-foreground'
                  : 'text-muted-foreground/60'
              )}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex items-center justify-center min-h-full px-6 py-8">
          {currentStep === 'system' && (
            <SystemStep
              specs={specs}
              capabilityScore={capabilityScore}
              capabilityLabel={capabilityLabel}
              onNext={() => setCurrentStep('models')}
            />
          )}
          {currentStep === 'models' && (
            <ModelsStep
              models={gridModels}
              selectedModels={selectedModels}
              modelSupport={modelSupport}
              getDefaultVariant={getDefaultVariant}
              toggleModel={toggleModel}
              totalDownloadSize={totalDownloadSize}
              selectedCount={selectedModels.size}
              sourcesLoading={sourcesLoading}
              onDownload={startDownloads}
              onBack={() => setCurrentStep('system')}
            />
          )}
          {currentStep === 'done' && (
            <DoneStep
              downloadProgress={downloadProgress}
              selectedModelDetails={selectedModelDetails}
              allDownloadsComplete={allDownloadsComplete}
              formatBytes={formatBytes}
              onFinish={finishSetup}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// --- Step Components ---

function SystemStep({
  specs,
  capabilityScore,
  capabilityLabel,
  onNext,
}: {
  specs: { icon: React.ElementType; label: string; value: string }[]
  capabilityScore: number
  capabilityLabel: { text: string; color: string }
  onNext: () => void
}) {
  return (
    <div className="w-full max-w-[480px]">
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-secondary mb-4">
          <IconDeviceDesktop className="size-7 text-foreground" />
        </div>
        <h1 className="text-2xl font-semibold mb-2">
          Your system at a glance
        </h1>
        <p className="text-muted-foreground text-sm">
          Here&apos;s what Jan detected about your device.
        </p>
      </div>

      {/* Capability bar */}
      <div className="my-8">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-muted-foreground">
            Device capability
          </span>
          <span
            className={cn(
              'text-xs font-medium px-2 py-0.5 rounded-full text-white',
              capabilityLabel.color
            )}
          >
            {capabilityLabel.text}
          </span>
        </div>
        <div className="h-2 rounded-full bg-secondary overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-700',
              capabilityLabel.color
            )}
            style={{ width: `${Math.max(capabilityScore, 5)}%` }}
          />
        </div>
      </div>

      {/* Spec grid */}
      <div className="grid grid-cols-2 gap-3">
        {specs.map(({ icon: Icon, label, value }) => (
          <div
            key={label}
            className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50"
          >
            <Icon className="size-4 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-sm font-medium truncate">{value}</p>
            </div>
          </div>
        ))}
      </div>

      <Button
        onClick={onNext}
        className="w-full mt-8 gap-2"
      >
        Explore compatible models
        <IconArrowRight className="size-4" />
      </Button>
    </div>
  )
}

function ModelsStep({
  models,
  selectedModels,
  modelSupport,
  getDefaultVariant,
  toggleModel,
  totalDownloadSize,
  selectedCount,
  sourcesLoading,
  onDownload,
  onBack,
}: {
  models: CatalogModel[]
  selectedModels: Set<string>
  modelSupport: Record<string, string>
  getDefaultVariant: (m: CatalogModel) => ModelQuant | undefined
  toggleModel: (name: string) => void
  totalDownloadSize: number
  selectedCount: number
  sourcesLoading: boolean
  onDownload: () => void
  onBack: () => void
}) {
  // Extract model display name
  const getDisplayName = (model: CatalogModel) => {
    const name = model.model_name
    // Clean up common HuggingFace name patterns
    return name
      .replace(/^.*\//, '')
      .replace(/-GGUF$/i, '')
      .replace(/-gguf$/i, '')
  }

  const getModelDescription = (model: CatalogModel): string => {
    if (model.description) {
      // Truncate long descriptions
      const clean = model.description.replace(/[#*_]/g, '').trim()
      return clean.length > 60 ? clean.slice(0, 57) + '...' : clean
    }
    return 'General-purpose language model'
  }

  const getSupportChip = (variant: ModelQuant | undefined) => {
    if (!variant) return null
    const status = modelSupport[variant.model_id]
    if (!status || status === 'LOADING') {
      return (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
          Checking...
        </span>
      )
    }
    const config: Record<string, { label: string; classes: string }> = {
      GREEN: {
        label: 'Compatible',
        classes:
          'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      },
      YELLOW: {
        label: 'Marginal',
        classes: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
      },
      RED: {
        label: 'Too large',
        classes: 'bg-red-500/10 text-red-600 dark:text-red-400',
      },
      GREY: {
        label: 'Unknown',
        classes: 'bg-muted text-muted-foreground',
      },
    }
    const c = config[status] || config.GREY
    return (
      <span className={cn('text-[10px] px-1.5 py-0.5 rounded', c.classes)}>
        {c.label}
      </span>
    )
  }

  return (
    <div className="w-full max-w-[700px]">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-semibold mb-2">Choose your models</h1>
        <p className="text-muted-foreground text-sm">
          Select models to download. They&apos;ll run locally on your device.
        </p>
      </div>

      {sourcesLoading && models.length === 0 ? (
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <div
              key={i}
              className="h-[140px] rounded-lg bg-secondary/50 animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {models.map((model) => {
            const variant = getDefaultVariant(model)
            const isSelected = selectedModels.has(model.model_name)

            return (
              <button
                key={model.model_name}
                onClick={() => toggleModel(model.model_name)}
                className={cn(
                  'relative text-left p-3 rounded-lg border transition-all cursor-pointer',
                  'hover:border-foreground/20 hover:shadow-sm',
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-secondary/30'
                )}
              >
                {/* Compatibility chip - top right */}
                <div className="absolute top-2 right-2">
                  {getSupportChip(variant)}
                </div>

                {/* Selection indicator */}
                {isSelected && (
                  <div className="absolute -top-1.5 -left-1.5 size-5 rounded-full bg-primary flex items-center justify-center">
                    <IconCheck className="size-3 text-primary-foreground" />
                  </div>
                )}

                {/* Model info */}
                <div className="pr-16">
                  <h3 className="text-sm font-semibold truncate">
                    {getDisplayName(model)}
                  </h3>
                  {variant && (
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {variant.file_size}
                    </p>
                  )}
                </div>

                <p className="text-xs text-muted-foreground mt-2 line-clamp-2 leading-relaxed">
                  {getModelDescription(model)}
                </p>

                {/* Badges row */}
                <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
                  {(model.mmproj_models?.length ?? 0) > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                      Vision
                    </span>
                  )}
                  {model.tools && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                      Tools
                    </span>
                  )}
                  {model.downloads > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                      <IconDownload className="size-2.5" />
                      {model.downloads >= 1000
                        ? `${(model.downloads / 1000).toFixed(0)}k`
                        : model.downloads}
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      <div className="flex items-center gap-3 mt-6">
        <Button variant="outline" onClick={onBack} className="px-6">
          Back
        </Button>
        <Button
          onClick={onDownload}
          disabled={selectedCount === 0}
          className="flex-1 gap-2"
        >
          {selectedCount > 0
            ? `Download ${selectedCount} model${selectedCount > 1 ? 's' : ''} (${totalDownloadSize.toFixed(1)} GB) and continue`
            : 'Select models to continue'}
        </Button>
      </div>
    </div>
  )
}

function DoneStep({
  downloadProgress,
  selectedModelDetails,
  allDownloadsComplete,
  formatBytes,
  onFinish,
}: {
  downloadProgress: {
    modelId: string
    isActive: boolean
    progress: number
    current: number
    total: number
    imported: boolean
  }[]
  selectedModelDetails: SelectedModel[]
  allDownloadsComplete: boolean
  formatBytes: (bytes: number) => string
  onFinish: () => void
}) {
  return (
    <div className="w-full max-w-[480px]">
      <div className="text-center mb-8">
        <div
          className={cn(
            'inline-flex items-center justify-center size-14 rounded-2xl mb-4',
            allDownloadsComplete ? 'bg-emerald-500/10' : 'bg-secondary'
          )}
        >
          {allDownloadsComplete ? (
            <IconCheck className="size-7 text-emerald-500" />
          ) : (
            <IconDownload className="size-7 text-foreground" />
          )}
        </div>
        <h1 className="text-2xl font-semibold mb-2">
          {allDownloadsComplete ? 'You\'re all set!' : 'Downloading models...'}
        </h1>
        <p className="text-muted-foreground text-sm">
          {allDownloadsComplete
            ? 'Your models are ready. Start chatting now.'
            : 'This may take a few minutes. You can start chatting while models download.'}
        </p>
      </div>

      {/* Download progress list */}
      <div className="flex flex-col gap-3 mb-8">
        {selectedModelDetails.map(({ catalog, variant }, i) => {
          const progress = downloadProgress[i]
          const name = catalog.model_name
            .replace(/^.*\//, '')
            .replace(/-GGUF$/i, '')

          return (
            <div
              key={variant.model_id}
              className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-medium truncate">{name}</p>
                  {progress?.imported ? (
                    <IconCheck className="size-4 text-emerald-500 shrink-0" />
                  ) : progress?.isActive ? (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {progress.total > 0
                        ? `${formatBytes(progress.current)} / ${formatBytes(progress.total)}`
                        : 'Starting...'}
                    </span>
                  ) : null}
                </div>
                {progress?.isActive && !progress.imported && (
                  <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300"
                      style={{
                        width: `${Math.max(progress.progress ?? 0, 2)}%`,
                      }}
                    />
                  </div>
                )}
                {progress?.imported && (
                  <p className="text-xs text-emerald-500">Ready</p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <Button onClick={onFinish} className="w-full gap-2">
        <IconMessageCircle className="size-4" />
        {allDownloadsComplete ? 'Start chatting' : 'Start chatting'}
      </Button>
    </div>
  )
}

export default SetupScreen
