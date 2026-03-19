/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useModelSources } from '@/hooks/useModelSources'
import { cn } from '@/lib/utils'
import {
  useState,
  useMemo,
  useEffect,
  ChangeEvent,
  useCallback,
  useRef,
  useTransition,
} from 'react'
import { useModelProvider } from '@/hooks/useModelProvider'
import { Card, CardItem } from '@/containers/Card'
import {
  IconSearch,
} from '@tabler/icons-react'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useServiceHub } from '@/hooks/useServiceHub'
import type { CatalogModel } from '@/services/models/types'
import HeaderPage from '@/containers/HeaderPage'
import { ChevronsUpDown, ExternalLink, Loader } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import Fuse from 'fuse.js'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useShallow } from 'zustand/shallow'
import { DEFAULT_MODEL_QUANTIZATIONS } from '@/constants/models'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import ModelGridCard from '@/containers/ModelGridCard'

type SearchParams = {
  repo: string
}

export const Route = createFileRoute(route.hub.index as any)({
  component: HubContent,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    repo: search.repo as SearchParams['repo'],
  }),
})

function HubContent() {
  const [isPending, startTransition] = useTransition()
  const parentRef = useRef(null)
  const { huggingfaceToken, setHuggingfaceToken } = useGeneralSetting()
  const serviceHub = useServiceHub()
  const [isValidatingToken, setIsValidatingToken] = useState(false)

  const { t } = useTranslation()

  const sortOptions = [
    { value: 'newest', name: t('hub:sortNewest') },
    { value: 'most-downloaded', name: t('hub:sortMostDownloaded') },
    ...(IS_MACOS
      ? [
          { value: 'mlx', name: 'MLX' },
          { value: 'gguf', name: 'GGUF' },
        ]
      : []),
  ]
  const searchOptions = useMemo(
    () => ({
      includeScore: true,
      // Search in `author` and in `tags` array
      keys: ['model_name', 'quants.model_id'],
    }),
    []
  )

  const { sources, fetchSources, loading } = useModelSources(
    useShallow((state) => ({
      sources: state.sources,
      fetchSources: state.fetchSources,
      loading: state.loading,
    }))
  )

  const [searchValue, setSearchValue] = useState('')
  const [sortSelected, setSortSelected] = useState('newest')
  const [isSearching, setIsSearching] = useState(false)
  const [showOnlyDownloaded, setShowOnlyDownloaded] = useState(false)
  const [huggingFaceRepo, setHuggingFaceRepo] = useState<CatalogModel | null>(
    null
  )
  const [modelSupportStatus, setModelSupportStatus] = useState<
    Record<string, 'RED' | 'YELLOW' | 'GREEN' | 'LOADING'>
  >({})
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const addModelSourceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  // Sorting functionality
  const sortedModels = useMemo(() => {
    let sorted = [...sources]

    // Apply MLX/GGUF filter first (only on Mac)
    if (sortSelected === 'mlx') {
      sorted = sorted.filter((m) => m.is_mlx)
    } else if (sortSelected === 'gguf') {
      sorted = sorted.filter((m) => !m.is_mlx)
    }

    // Apply sorting
    if (sortSelected === 'most-downloaded') {
      return sorted.sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
    }
    return sorted.sort(
      (a, b) =>
        new Date(b.created_at || 0).getTime() -
        new Date(a.created_at || 0).getTime()
    )
  }, [sortSelected, sources])

  // Filtered models (debounced search)
  const [debouncedSearchValue, setDebouncedSearchValue] = useState(searchValue)

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearchValue(searchValue)
    }, 300)
    return () => clearTimeout(handler)
  }, [searchValue])

  const filteredModels = useMemo(() => {
    let filtered = sortedModels
    // Apply search filter
    if (debouncedSearchValue.length) {
      const fuse = new Fuse(filtered, searchOptions)
      // Remove domain from search value (e.g., "huggingface.co/author/model" -> "author/model")
      const cleanedSearchValue = debouncedSearchValue.replace(
        /^https?:\/\/[^/]+\//,
        ''
      )
      filtered = fuse.search(cleanedSearchValue).map((result) => result.item)
    }
    // Apply downloaded filter
    if (showOnlyDownloaded) {
      filtered = filtered
        ?.map((model) => ({
          ...model,
          quants: model.quants?.filter((variant) => {
            // Check both llamacpp and mlx providers
            const isLlamaCppDownloaded = useModelProvider
              .getState()
              .getProviderByName('llamacpp')
              ?.models.some((m: { id: string }) => m.id === variant.model_id)
            const isMlxDownloaded = useModelProvider
              .getState()
              .getProviderByName('mlx')
              ?.models.some((m: { id: string }) => m.id === variant.model_id)
            return isLlamaCppDownloaded || isMlxDownloaded
          }),
        }))
        .filter((model) => (model.quants?.length ?? 0) > 0)
    }
    // Add HuggingFace repo at the beginning if available
    if (huggingFaceRepo) {
      filtered = [huggingFaceRepo, ...filtered]
    }
    return filtered
  }, [
    sortedModels,
    debouncedSearchValue,
    showOnlyDownloaded,
    huggingFaceRepo,
    searchOptions,
  ])

  useEffect(() => {
    // Use startTransition to keep UI responsive during data fetch
    startTransition(() => {
      fetchSources()
    })
  }, [fetchSources])

  // Reset initial load state after data loads or on filter change
  useEffect(() => {
    if (!isInitialLoad) return

    // Hide skeleton after a short delay to show loading state
    const timer = setTimeout(() => setIsInitialLoad(false), 150)
    return () => clearTimeout(timer)
  }, [isInitialLoad, filteredModels.length])

  const fetchHuggingFaceModel = async (searchValue: string) => {
    if (
      !searchValue.length ||
      (!searchValue.includes('/') && !searchValue.startsWith('http'))
    ) {
      return
    }

    setIsSearching(true)
    if (addModelSourceTimeoutRef.current) {
      clearTimeout(addModelSourceTimeoutRef.current)
    }

    addModelSourceTimeoutRef.current = setTimeout(async () => {
      try {
        const repoInfo = await serviceHub
          .models()
          .fetchHuggingFaceRepo(searchValue, huggingfaceToken)
        if (repoInfo) {
          const catalogModel = serviceHub
            .models()
            .convertHfRepoToCatalogModel(repoInfo)
          if (
            !sources.some(
              (s) =>
                catalogModel.model_name.trim().split('/').pop() ===
                  s.model_name.trim() &&
                catalogModel.developer?.trim() === s.developer?.trim()
            )
          ) {
            setHuggingFaceRepo(catalogModel)
          }
        }
      } catch (error) {
        console.error('Error fetching repository info:', error)
      } finally {
        setIsSearching(false)
      }
    }, 500)
  }

  const handleSearchChange = (e: ChangeEvent<HTMLInputElement>) => {
    setIsSearching(false)
    setSearchValue(e.target.value)
    setHuggingFaceRepo(null) // Clear previous repo info

    if (!showOnlyDownloaded) {
      fetchHuggingFaceModel(e.target.value)
    }
  }

  const navigate = useNavigate()

  const handleUseModel = useCallback(
    (modelId: string) => {
      navigate({
        to: route.home,
        params: {},
        search: {
          threadModel: {
            id: modelId,
            provider: 'llamacpp',
          },
        },
      })
    },
    [navigate]
  )

  const checkModelSupport = useCallback(
    async (variant: any) => {
      const modelKey = variant.model_id

      // Don't check again if already checking or checked
      if (modelSupportStatus[modelKey]) {
        return
      }

      // Set loading state
      setModelSupportStatus((prev) => ({
        ...prev,
        [modelKey]: 'LOADING',
      }))

      try {
        // Use the HuggingFace path for the model
        const modelPath = variant.path
        const supportStatus = await serviceHub
          .models()
          .isModelSupported(modelPath, 8192)

        setModelSupportStatus((prev) => ({
          ...prev,
          [modelKey]: supportStatus,
        }))
      } catch (error) {
        console.error('Error checking model support:', error)
        setModelSupportStatus((prev) => ({
          ...prev,
          [modelKey]: 'RED',
        }))
      }
    },
    [modelSupportStatus, serviceHub]
  )

  // Helper to get default variant for a model
  const getDefaultVariant = useCallback(
    (model: CatalogModel) =>
      model.quants?.find((m) =>
        DEFAULT_MODEL_QUANTIZATIONS.some((e) =>
          m.model_id.toLowerCase().includes(e)
        )
      ) ?? model.quants?.[0],
    []
  )

  // Auto-check compatibility for first batch of models
  useEffect(() => {
    if (!filteredModels.length) return
    const modelsToCheck = filteredModels.slice(0, 15)
    for (const model of modelsToCheck) {
      if (model.is_mlx) continue
      const variant = getDefaultVariant(model)
      if (variant && !modelSupportStatus[variant.model_id]) {
        checkModelSupport(variant)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredModels.length])

  // Format download count for display
  const formatDownloads = useCallback((count: number) => {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
    return String(count)
  }, [])

  const renderFilter = () => {
    return (
      <>
        {/* Sort dropdown - always visible */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {
                sortOptions.find((option) => option.value === sortSelected)
                  ?.name
              }
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end">
            {sortOptions.map((option) => (
              <DropdownMenuItem
                className={cn(
                  'cursor-pointer my-0.5',
                  sortSelected === option.value && 'bg-secondary'
                )}
                key={option.value}
                onClick={() => {
                  setIsInitialLoad(true)
                  setSortSelected(option.value)
                }}
              >
                {option.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex items-center gap-2">
          <Switch
            checked={showOnlyDownloaded}
            onCheckedChange={(checked) => {
              setIsInitialLoad(true)
              setShowOnlyDownloaded(checked)
              if (checked) {
                setHuggingFaceRepo(null)
              } else {
                // Re-trigger HuggingFace search when switching back to "All models"
                fetchHuggingFaceModel(searchValue)
              }
            }}
          />
          <span className="text-xs text-foreground font-medium whitespace-nowrap">
            {t('hub:downloaded')}
          </span>
        </div>
      </>
    )
  }

  return (
    <div className="flex flex-col h-svh w-full">
      <div className="flex flex-col h-full w-full ">
        <HeaderPage>
          <div className={cn("pr-3 py-3  h-10 w-full flex items-center justify-between relative z-20", !IS_MACOS && "pr-30")}>
            <div className="flex items-center gap-2 w-full">
              {isSearching ? (
                <Loader className="shrink-0 size-4 animate-spin text-muted-foreground" />
              ) : (
                <IconSearch
                  className="shrink-0 text-muted-foreground"
                  size={14}
                />
              )}
              <input
                placeholder={t('hub:searchPlaceholder')}
                value={searchValue}
                onChange={handleSearchChange}
                className="w-full focus:outline-none"
              />
            </div>
            <div className="sm:flex items-center gap-2 shrink-0 hidden">
              {renderFilter()}
            </div>
          </div>
        </HeaderPage>
        <div ref={parentRef} className="p-4 w-full h-[calc(100%-60px)] overflow-y-auto! first-step-setup-local-provider">
          <div className="flex flex-col h-full justify-between gap-4 gap-y-3 w-full max-w-[1000px] mx-auto">
            {/* HuggingFace Token */}
            <Card title={t('hub:huggingfaceToken') ?? 'HuggingFace Token'}>
              <CardItem
                title={t('hub:huggingfaceTokenDesc') ?? 'Your HuggingFace API token for accessing gated models.'}
                actions={
                  <div className="flex items-center gap-2">
                    <Input
                      id="hf-token"
                      value={huggingfaceToken || ''}
                      onChange={(e) => setHuggingfaceToken(e.target.value)}
                      placeholder="hf_xxx_xxx"
                      required
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isValidatingToken}
                      onClick={async () => {
                        const token = (huggingfaceToken || '').trim()
                        if (!token) {
                          toast.error('Please enter a HuggingFace token to validate')
                          return
                        }
                        setIsValidatingToken(true)
                        const controller = new AbortController()
                        const timeoutId = setTimeout(() => controller.abort(), 10_000)
                        try {
                          const resp = await fetch('https://huggingface.co/api/whoami-v2', {
                            headers: { Authorization: `Bearer ${token}` },
                            signal: controller.signal,
                          })
                          if (resp.ok) {
                            const data = await resp.json()
                            toast.success('Token is valid', {
                              description: data?.name ? `Signed in as ${data.name}` : 'Your HuggingFace token is valid.',
                            })
                          } else {
                            toast.error('Token invalid', {
                              description: 'The provided HuggingFace token is invalid.',
                            })
                          }
                        } catch (e) {
                          const name = (e as { name?: string })?.name
                          toast.error(name === 'AbortError' ? 'Validation timed out' : 'Validation failed')
                        } finally {
                          clearTimeout(timeoutId)
                          setIsValidatingToken(false)
                        }
                      }}
                    >
                      Verify
                    </Button>
                  </div>
                }
              />
            </Card>
            {/* Show skeleton immediately on navigation, then show actual content when loaded */}
            {(isInitialLoad || (loading && !filteredModels.length)) ? (
              // Skeleton loading state for better perceived performance
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 animate-pulse">
                {[...Array(9)].map((_, i) => (
                  <div
                    key={i}
                    className="bg-card border border-border rounded-[14px] p-3.5 h-[180px]"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="h-4 bg-muted rounded w-24" />
                        <div className="h-3 bg-muted rounded w-14 mt-1.5" />
                      </div>
                      <div className="h-5 bg-muted rounded w-16" />
                    </div>
                    <div className="mt-3 h-3 bg-muted rounded w-full" />
                    <div className="mt-1.5 h-3 bg-muted rounded w-2/3" />
                    <div className="flex items-center gap-1.5 mt-3">
                      <div className="h-4 bg-muted rounded w-12" />
                      <div className="h-4 bg-muted rounded w-10" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredModels.length === 0 ? (
              <div className="flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  {t('hub:noModels')}
                </div>
              </div>
            ) : (
              <div
                className={cn(
                  'flex flex-col pb-2 mb-2 transition-opacity duration-200',
                  isPending ? 'opacity-70' : 'opacity-100'
                )}
              >
                <div className="flex items-center gap-2 justify-end sm:hidden mb-2">
                  {renderFilter()}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                  {filteredModels.map((model) => {
                    const defaultVariant = getDefaultVariant(model)
                    return (
                      <ModelGridCard
                        key={model.model_name}
                        model={model}
                        defaultVariant={defaultVariant}
                        supportStatus={modelSupportStatus[defaultVariant?.model_id ?? '']}
                        handleUseModel={handleUseModel}
                        formatDownloads={formatDownloads}
                        onClick={() =>
                          navigate({
                            to: route.hub.model,
                            params: { modelId: model.model_name },
                          })
                        }
                      />
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
