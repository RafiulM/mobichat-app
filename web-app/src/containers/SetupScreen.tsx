import { useModelProvider } from '@/hooks/useModelProvider'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { localStorageKey } from '@/constants/localStorage'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useEffect, useMemo, useCallback, useState, useRef } from 'react'
import { AppEvent, events } from '@janhq/core'
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

// Model icon color palette
const MODEL_ICON_COLORS = [
  { bg: '#60A5FA1F', stroke: '#60A5FA' }, // blue
  { bg: '#FBBF241F', stroke: '#FBBF24' }, // amber
  { bg: '#F871711F', stroke: '#F87171' }, // red
  { bg: '#8B5CF61F', stroke: '#8B5CF6' }, // violet
  { bg: '#38BDF81F', stroke: '#38BDF8' }, // cyan
  { bg: '#F472B61F', stroke: '#F472B6' }, // pink
  { bg: '#FB923C1F', stroke: '#FB923C' }, // orange
]

function getModelIconColor(index: number) {
  return MODEL_ICON_COLORS[index % MODEL_ICON_COLORS.length]
}

// Derive speed/capability tag from model name
function getModelTags(model: CatalogModel): string[] {
  const tags: string[] = ['Text']

  if ((model.mmproj_models?.length ?? 0) > 0) {
    tags.push('Vision')
  }
  if (model.tools) {
    tags.push('Code')
  }

  // Derive speed/reasoning from model name
  const name = model.model_name.toLowerCase()
  const sizeMatch = name.match(/(\d+\.?\d*)b/i)
  const paramSize = sizeMatch ? parseFloat(sizeMatch[1]) : 0

  if (paramSize > 0 && paramSize <= 3) {
    tags.push('Fast')
  } else if (paramSize > 3 && paramSize <= 8) {
    tags.push('Good reasoning')
  } else if (paramSize > 8 && paramSize <= 30) {
    tags.push('Strong reasoning')
  } else if (paramSize > 30) {
    tags.push('Advanced')
  }

  return tags
}

// Format download count
function formatDownloads(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}

// Get display name from model
function getDisplayName(model: CatalogModel) {
  return model.model_name
    .replace(/^.*\//, '')
    .replace(/-GGUF$/i, '')
    .replace(/-gguf$/i, '')
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
  const [storageInfo, setStorageInfo] = useState<string>('')

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

  // Estimate storage
  useEffect(() => {
    if (navigator.storage?.estimate) {
      navigator.storage.estimate().then((estimate) => {
        const quotaGB = (estimate.quota ?? 0) / (1024 * 1024 * 1024)
        const usageGB = (estimate.usage ?? 0) / (1024 * 1024 * 1024)
        const freeGB = quotaGB - usageGB
        if (freeGB > 0) {
          setStorageInfo(`${Math.round(freeGB)} GB free`)
        }
      }).catch(() => {})
    }
  }, [])

  // Calculate capability score (0-100)
  const capabilityScore = useMemo(() => {
    const totalRamMB = hardwareData.total_memory
    if (!totalRamMB) return 0
    const totalRamGB = totalRamMB / 1024
    const ramScore = Math.min(100, Math.max(0, (totalRamGB / 64) * 100))
    const coreScore = Math.min(
      100,
      Math.max(0, (hardwareData.cpu.core_count / 16) * 100)
    )
    return Math.round(ramScore * 0.7 + coreScore * 0.3)
  }, [hardwareData])

  const capabilityLabel = useMemo(() => {
    if (capabilityScore >= 70)
      return {
        text: 'Good',
        description: 'Your device can run small & medium models smoothly',
        dotColor: '#4ADE80',
        badgeBg: '#4ADE801A',
        badgeBorder: '#4ADE8033',
        barColor: '#4ADE80',
      }
    if (capabilityScore >= 40)
      return {
        text: 'Moderate',
        description: 'Your device can run small models',
        dotColor: '#F59E0B',
        badgeBg: '#F59E0B1A',
        badgeBorder: '#F59E0B33',
        barColor: '#F59E0B',
      }
    return {
      text: 'Limited',
      description: 'Your device can run lightweight models',
      dotColor: '#EF4444',
      badgeBg: '#EF44441A',
      badgeBorder: '#EF444433',
      barColor: '#EF4444',
    }
  }, [capabilityScore])

  const availableRamMB = useMemo(() => {
    if (!hardwareData.total_memory || !systemUsage.used_memory) return 0
    return hardwareData.total_memory - systemUsage.used_memory
  }, [hardwareData.total_memory, systemUsage.used_memory])

  // Get models suitable for the grid
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
  const toggleModel = useCallback((modelName: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev)
      if (next.has(modelName)) {
        next.delete(modelName)
      } else {
        next.add(modelName)
      }
      return next
    })
  }, [])

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

  // System specs data
  const specs = useMemo(
    () => [
      {
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="4" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M5 8H11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        ),
        label: 'RAM',
        value: formatMegaBytes(hardwareData.total_memory),
      },
      {
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="3" y="4" width="10" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M6 8L8 10L10 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ),
        label: 'CHIP',
        value:
          hardwareData.cpu.name?.split(' ').slice(0, 3).join(' ') || 'Unknown',
      },
      {
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="3" y="2" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <circle cx="8" cy="10" r="1" fill="currentColor" />
          </svg>
        ),
        label: 'STORAGE',
        value: storageInfo || 'N/A',
      },
      {
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="4" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M5 8H11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        ),
        label: 'AVAILABLE RAM',
        value: formatMegaBytes(availableRamMB),
      },
      {
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="3" y="4" width="10" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M6 8L8 10L10 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ),
        label: 'CPU CORES',
        value: `${hardwareData.cpu.core_count} cores`,
      },
      {
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="3" y="2" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <circle cx="8" cy="10" r="1" fill="currentColor" />
          </svg>
        ),
        label: 'OS',
        value: hardwareData.os_name || 'Unknown',
      },
    ],
    [hardwareData, availableRamMB, storageInfo]
  )

  const stepIndex = STEPS.findIndex((s) => s.key === currentStep)

  return (
    <div className="relative flex flex-col h-svh w-full overflow-hidden bg-[#0C0C10]">
      {/* Background glow */}
      <div
        className="pointer-events-none absolute left-1/2 top-[60px] -translate-x-1/2 w-[600px] h-[400px] rounded-full"
        style={{
          background:
            'radial-gradient(circle, rgba(134,94,234,0.06) 0%, transparent 70%)',
        }}
      />

      {/* Top bar with step indicator and skip */}
      <div className="relative flex items-center justify-center h-[72px] px-6 shrink-0">
        {/* Step indicator */}
        <div className="flex items-center gap-0">
          {STEPS.map((step, i) => (
            <div key={step.key} className="flex items-center">
              <div className="flex items-center gap-1.5">
                <div
                  className="size-[7px] rounded-full"
                  style={{
                    backgroundColor:
                      i < stepIndex
                        ? '#4ADE80'
                        : i === stepIndex
                          ? '#865EEA'
                          : '#2A2A35',
                  }}
                />
                <span
                  className={cn(
                    'text-[13px]',
                    i === stepIndex
                      ? 'text-white font-semibold'
                      : 'text-[#6E6E7A]'
                  )}
                >
                  {step.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className="w-6 h-px mx-3"
                  style={{
                    backgroundColor:
                      i < stepIndex ? '#4ADE80' : '#2A2A35',
                  }}
                />
              )}
            </div>
          ))}
        </div>

        {/* Skip setup */}
        {currentStep !== 'done' && (
          <button
            onClick={skipSetup}
            className="absolute right-6 text-[13px] text-[#6E6E7A] hover:text-white transition-colors cursor-pointer"
          >
            Skip setup
          </button>
        )}
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
            />
          )}
          {currentStep === 'done' && (
            <DoneStep
              downloadProgress={downloadProgress}
              selectedModelDetails={selectedModelDetails}
              allDownloadsComplete={allDownloadsComplete}
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
  specs: { icon: React.ReactNode; label: string; value: string }[]
  capabilityScore: number
  capabilityLabel: {
    text: string
    description: string
    dotColor: string
    badgeBg: string
    badgeBorder: string
    barColor: string
  }
  onNext: () => void
}) {
  return (
    <div className="w-full max-w-[560px]">
      {/* Header */}
      <div className="text-center mb-8">
        <div
          className="inline-flex items-center justify-center size-14 rounded-2xl mb-4"
          style={{
            background:
              'linear-gradient(135deg, rgba(134,94,234,0.2), rgba(134,94,234,0.05))',
            border: '1px solid #865EEA40',
          }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 8V6a2 2 0 0 1 2-2h2" />
            <path d="M4 16v2a2 2 0 0 0 2 2h2" />
            <path d="M16 4h2a2 2 0 0 1 2 2v2" />
            <path d="M16 20h2a2 2 0 0 0 2-2v-2" />
            <rect x="9" y="9" width="6" height="6" rx="1" />
          </svg>
        </div>
        <h1 className="text-[28px] font-bold text-white tracking-tight mb-2">
          Let&apos;s check your system
        </h1>
        <p className="text-[15px] text-[#6E6E7A]">
          We&apos;ll scan your hardware to find the best AI models for your
          machine.
        </p>
      </div>

      {/* Spec grid — 3 columns */}
      <div className="grid grid-cols-3 gap-3">
        {specs.map(({ icon, label, value }) => (
          <div
            key={label}
            className="flex flex-col gap-1.5 rounded-xl p-4"
            style={{
              backgroundColor: '#111118',
              border: '1px solid #1E1E28',
            }}
          >
            <div className="flex items-center gap-1.5 text-[#6E6E7A]">
              {icon}
              <span className="text-[11px] font-medium tracking-wider text-[#7A7A88] uppercase">
                {label}
              </span>
            </div>
            <p className="text-lg font-semibold text-[#F0F0F2]">{value}</p>
          </div>
        ))}
      </div>

      {/* Capability summary */}
      <div className="mt-6">
        <div className="flex items-center gap-3 mb-3">
          <div
            className="flex items-center gap-1.5 rounded-full px-3 py-[5px]"
            style={{
              backgroundColor: capabilityLabel.badgeBg,
              border: `1px solid ${capabilityLabel.badgeBorder}`,
            }}
          >
            <div
              className="size-1.5 rounded-full"
              style={{ backgroundColor: capabilityLabel.dotColor }}
            />
            <span
              className="text-[13px] font-semibold"
              style={{ color: capabilityLabel.dotColor }}
            >
              {capabilityLabel.text}
            </span>
          </div>
          <span className="text-[13px] text-[#6E6E7A]">
            {capabilityLabel.description}
          </span>
        </div>
        <div
          className="h-1 w-full rounded-full"
          style={{ backgroundColor: '#1E1E28' }}
        >
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${Math.max(capabilityScore, 5)}%`,
              backgroundColor: capabilityLabel.barColor,
            }}
          />
        </div>
      </div>

      {/* CTA */}
      <button
        onClick={onNext}
        className="w-full mt-8 rounded-full py-3 px-8 text-[15px] font-semibold text-white cursor-pointer transition-colors"
        style={{ backgroundColor: '#865EEA' }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.backgroundColor = '#7A52D9')
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.backgroundColor = '#865EEA')
        }
      >
        Explore compatible models
      </button>
      <p className="text-center text-[13px] text-[#55555E] mt-3">
        You can download models later in Settings
      </p>
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
}) {
  return (
    <div className="w-full max-w-[960px]">
      <div className="text-center mb-8">
        <h1 className="text-[32px] font-bold text-white tracking-tight mb-2">
          Choose your models
        </h1>
        <p className="text-[16px] text-[#8E8E9A]">
          Select models to download. They&apos;ll be ready to use when setup is
          complete.
        </p>
      </div>

      {sourcesLoading && models.length === 0 ? (
        <div className="grid grid-cols-3 gap-2.5">
          {Array.from({ length: 9 }).map((_, i) => (
            <div
              key={i}
              className="h-[138px] rounded-[14px] animate-pulse"
              style={{ backgroundColor: '#111118' }}
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2.5">
          {models.map((model, modelIndex) => {
            const variant = getDefaultVariant(model)
            const isSelected = selectedModels.has(model.model_name)
            const status = variant ? modelSupport[variant.model_id] : undefined
            const iconColor = getModelIconColor(modelIndex)
            const tags = getModelTags(model)
            const isFirstModel = modelIndex === 0

            return (
              <button
                key={model.model_name}
                onClick={() => toggleModel(model.model_name)}
                className={cn(
                  'relative flex flex-col text-left rounded-[14px] p-3.5 gap-2.5 cursor-pointer transition-all',
                  status === 'RED' && 'opacity-50'
                )}
                style={{
                  backgroundColor: '#111118',
                  border: isSelected
                    ? '1.5px solid #865EEA'
                    : '1px solid #1E1E28',
                }}
              >
                {/* Recommended badge */}
                {isFirstModel && (
                  <div
                    className="absolute rounded-full px-2.5 py-0.5"
                    style={{
                      top: '-9px',
                      left: '14px',
                      backgroundColor: '#865EEA',
                    }}
                  >
                    <span className="text-[11px] font-medium text-white">
                      Recommended
                    </span>
                  </div>
                )}

                {/* Header row */}
                <div
                  className="flex items-center justify-between"
                  style={{ paddingTop: isFirstModel ? '4px' : '0' }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Model icon */}
                    <div
                      className="flex items-center justify-center shrink-0 rounded-md"
                      style={{
                        width: '22px',
                        height: '22px',
                        backgroundColor: iconColor.bg,
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 16 16"
                        fill="none"
                      >
                        <path
                          d="M4 2L8 4L12 2V10L8 12L4 10V2Z"
                          stroke={iconColor.stroke}
                          strokeWidth="1.3"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M8 4V12"
                          stroke={iconColor.stroke}
                          strokeWidth="1.3"
                        />
                      </svg>
                    </div>
                    {/* Name + size */}
                    <div className="flex flex-col gap-px min-w-0">
                      <span className="text-[14px] font-semibold text-white truncate">
                        {getDisplayName(model)}
                      </span>
                      {variant && (
                        <span className="text-[11px] text-[#55555E]">
                          {variant.file_size
                            ? `${variant.file_size}`
                            : ''}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Compatibility pill */}
                  {variant && (
                    <CompatibilityPill status={status} />
                  )}
                </div>

                {/* Description */}
                <p className="text-[12px] text-[#6E6E7A] line-clamp-2 leading-[16px]">
                  {model.description
                    ? model.description
                        .replace(/[#*_]/g, '')
                        .trim()
                        .slice(0, 80)
                    : 'General-purpose language model'}
                </p>

                {/* Tag chips */}
                <div className="flex items-center gap-[5px] flex-wrap">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-[3px] text-[10px] font-medium text-[#8E8E9A]"
                      style={{ backgroundColor: '#1A1A22' }}
                    >
                      <TagIcon tag={tag} />
                      {tag}
                    </span>
                  ))}
                  {model.downloads > 0 && (
                    <span
                      className="inline-flex items-center gap-1 rounded-md px-2 py-[3px] text-[10px] font-medium text-[#8E8E9A]"
                      style={{ backgroundColor: '#1A1A22' }}
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 16 16"
                        fill="none"
                      >
                        <path
                          d="M3 13V5L8 2L13 5V13"
                          stroke="#6E6E7A"
                          strokeWidth="1.2"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M6 13V9H10V13"
                          stroke="#6E6E7A"
                          strokeWidth="1.2"
                        />
                      </svg>
                      {formatDownloads(model.downloads)}
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* CTA */}
      <button
        onClick={onDownload}
        disabled={selectedCount === 0}
        className={cn(
          'w-full mt-8 rounded-full py-3 px-8 text-[15px] font-semibold text-white cursor-pointer transition-colors',
          selectedCount === 0 && 'opacity-50 cursor-not-allowed'
        )}
        style={{ backgroundColor: '#865EEA' }}
        onMouseEnter={(e) => {
          if (selectedCount > 0)
            e.currentTarget.style.backgroundColor = '#7A52D9'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = '#865EEA'
        }}
      >
        {selectedCount > 0
          ? `Download ${selectedCount} model${selectedCount > 1 ? 's' : ''} (${totalDownloadSize.toFixed(1)} GB) and continue`
          : 'Select models to continue'}
      </button>
      <p className="text-center text-[13px] text-[#55555E] mt-3">
        Models will download in the background
      </p>
    </div>
  )
}

function DoneStep({
  downloadProgress,
  selectedModelDetails,
  allDownloadsComplete,
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
  onFinish: () => void
}) {
  return (
    <div className="w-full max-w-[440px]">
      {/* Header */}
      <div className="text-center mb-8">
        <div
          className="inline-flex items-center justify-center size-16 rounded-full mb-4"
          style={{ backgroundColor: '#865EEA1F' }}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12l5 5L20 7" />
          </svg>
        </div>
        <h1 className="text-[32px] font-bold text-white tracking-tight mb-2">
          {allDownloadsComplete ? "You're all set!" : "You're all set!"}
        </h1>
        <p className="text-[15px] text-[#6E6E7A]">
          {allDownloadsComplete
            ? 'Your models are ready. Start chatting now.'
            : 'Your models are downloading in the background. Start chatting now.'}
        </p>
      </div>

      {/* Download status list */}
      <div className="flex flex-col gap-2.5 mb-8">
        {selectedModelDetails.map(({ catalog, variant }, i) => {
          const progress = downloadProgress[i]
          const name = getDisplayName(catalog)
          const isDownloading = progress?.isActive && !progress?.imported
          const isQueued = !progress?.isActive && !progress?.imported

          return (
            <div
              key={variant.model_id}
              className="flex items-center gap-3 rounded-[10px]"
              style={{
                backgroundColor: '#16161D',
                border: '1px solid #2A2A35',
                padding: '14px 18px',
              }}
            >
              {/* Status circle */}
              {progress?.imported ? (
                <div className="size-[18px] rounded-full bg-[#4ADE80] flex items-center justify-center shrink-0">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M3 8L7 12L13 4"
                      stroke="white"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              ) : isDownloading ? (
                <div className="size-[18px] rounded-full bg-[#4ADE80] flex items-center justify-center shrink-0">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M3 8L7 12L13 4"
                      stroke="white"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              ) : (
                <div
                  className="size-[18px] rounded-full shrink-0"
                  style={{ border: '1.5px solid #55555E' }}
                />
              )}

              {/* Model name */}
              <span className="text-[14px] font-medium text-white flex-1 min-w-0 truncate">
                {name}
              </span>

              {/* Status text */}
              {progress?.imported ? (
                <span className="text-[13px] text-[#4ADE80] shrink-0">
                  Complete
                </span>
              ) : isDownloading ? (
                <span className="text-[13px] text-[#4ADE80] shrink-0">
                  Downloading{progress.progress > 0 ? ` \u00B7 ${Math.round(progress.progress)}%` : ''}
                </span>
              ) : isQueued ? (
                <span className="text-[13px] text-[#55555E] shrink-0">
                  Queued
                </span>
              ) : null}
            </div>
          )
        })}
      </div>

      {/* CTA */}
      <button
        onClick={onFinish}
        className="w-full rounded-full py-3 px-8 text-[15px] font-semibold text-white cursor-pointer transition-colors"
        style={{ backgroundColor: '#865EEA' }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.backgroundColor = '#7A52D9')
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.backgroundColor = '#865EEA')
        }
      >
        Start chatting
      </button>
    </div>
  )
}

// --- Small utility components ---

function CompatibilityPill({
  status,
}: {
  status: string | undefined
}) {
  if (!status || status === 'LOADING') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[10px] font-medium shrink-0"
        style={{ backgroundColor: '#1A1A22', color: '#6E6E7A' }}
      >
        <span className="size-1 rounded-full bg-[#6E6E7A] animate-pulse" />
        Checking
      </span>
    )
  }

  const config: Record<
    string,
    { label: string; dotColor: string; bgColor: string; textColor: string }
  > = {
    GREEN: {
      label: 'Compatible',
      dotColor: '#4ADE80',
      bgColor: '#4ADE801A',
      textColor: '#4ADE80',
    },
    YELLOW: {
      label: 'Marginal',
      dotColor: '#F59E0B',
      bgColor: '#F59E0B1A',
      textColor: '#F59E0B',
    },
    RED: {
      label: 'Too large',
      dotColor: '#EF4444',
      bgColor: '#EF44441A',
      textColor: '#EF4444',
    },
    GREY: {
      label: 'Unknown',
      dotColor: '#6E6E7A',
      bgColor: '#1A1A22',
      textColor: '#6E6E7A',
    },
  }

  const c = config[status] || config.GREY
  return (
    <span
      className="inline-flex items-center gap-[5px] rounded-full px-2 py-[3px] text-[10px] font-medium shrink-0"
      style={{ backgroundColor: c.bgColor, color: c.textColor }}
    >
      <span
        className="size-[5px] rounded-full shrink-0"
        style={{ backgroundColor: c.dotColor }}
      />
      {c.label}
    </span>
  )
}

function TagIcon({ tag }: { tag: string }) {
  switch (tag) {
    case 'Text':
    case 'Code':
      return (
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
          <path
            d="M3 8L7 12L13 4"
            stroke="#6E6E7A"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'Vision':
      return (
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
          <path
            d="M2 8C2 8 5 4 8 4C11 4 14 8 14 8C14 8 11 12 8 12C5 12 2 8 2 8Z"
            stroke="#6E6E7A"
            strokeWidth="1.2"
          />
          <circle cx="8" cy="8" r="2" stroke="#6E6E7A" strokeWidth="1.2" />
        </svg>
      )
    case 'Fast':
    case 'Very fast':
      return (
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
          <circle
            cx="8"
            cy="8"
            r="5"
            stroke="#6E6E7A"
            strokeWidth="1.2"
          />
          <path
            d="M8 5V8L10 10"
            stroke="#6E6E7A"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'Good reasoning':
    case 'Strong reasoning':
    case 'Advanced':
      return (
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
          <path
            d="M4 12L8 4L12 12"
            stroke="#6E6E7A"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M5.5 10H10.5"
            stroke="#6E6E7A"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      )
    default:
      return null
  }
}

export default SetupScreen
