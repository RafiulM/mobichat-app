import { useState, useEffect, useCallback, useRef } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { route } from '@/constants/routes'
import SettingsMenu from '@/containers/SettingsMenu'
import HeaderPage from '@/containers/HeaderPage'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTtsSettings } from '@/hooks/useTtsSettings'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  IconLoader2,
  IconPlayerPlay,
  IconPlayerStop,
  IconDownload,
  IconCheck,
  IconAlertTriangle,
  IconRefresh,
  IconMicrophone,
  IconExternalLink,
} from '@tabler/icons-react'
import { ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TtsModelInfo } from '@/lib/speech/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.speech as any)({
  component: SpeechSettings,
})

const VOICES = [
  'ryan', 'aiden', 'serena', 'vivian', 'uncle_fu',
  'dylan', 'eric', 'ono_anna', 'sohee',
]

function voiceLabel(voice: string) {
  return voice
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function ModelActions({
  model,
  loadingModels,
  onDownload,
  onLoad,
  onUnload,
}: {
  model: TtsModelInfo
  loadingModels: Record<string, string>
  onDownload: (m: TtsModelInfo) => void
  onLoad: (m: TtsModelInfo) => void
  onUnload: () => void
}) {
  const loadingState = loadingModels[model.id]

  if (loadingState) {
    return (
      <Button variant="outline" size="sm" disabled>
        <IconLoader2 size={14} className="animate-spin mr-1.5" />
        {loadingState === 'downloading' ? 'Downloading...' : 'Loading...'}
      </Button>
    )
  }

  if (model.is_loaded) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <IconCheck size={14} />
          Loaded
        </span>
        <Button variant="outline" size="sm" onClick={onUnload}>
          Unload
        </Button>
      </div>
    )
  }

  if (model.is_downloaded) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Downloaded</span>
        <Button variant="outline" size="sm" onClick={() => onLoad(model)}>
          Load
        </Button>
      </div>
    )
  }

  return (
    <Button variant="outline" size="sm" onClick={() => onDownload(model)}>
      <IconDownload size={14} className="mr-1.5" />
      Download
    </Button>
  )
}

type MicStatus = 'authorized' | 'not_determined' | 'denied' | 'restricted' | 'not_applicable' | 'loading'

const MIC_HELPER_GRANTED_KEY = 'mic-helper-granted'

function useMicrophoneStatus() {
  const [micStatus, setMicStatus] = useState<MicStatus>('loading')
  const [micRequesting, setMicRequesting] = useState(false)
  const [grantFailed, setGrantFailed] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchMicStatus = useCallback(async () => {
    if (!IS_TAURI || !IS_MACOS) {
      setMicStatus('not_applicable')
      return
    }
    try {
      const status = await invoke<string>('plugin:tts|get_microphone_status')
      // In dev builds, the native status stays "not_determined" even after
      // granting via the helper .app. Check localStorage for the persisted state.
      if (status === 'not_determined' && localStorage.getItem(MIC_HELPER_GRANTED_KEY) === 'true') {
        setMicStatus('authorized')
        return 'authorized'
      }
      setMicStatus(status as MicStatus)
      return status
    } catch {
      setMicStatus('not_applicable')
      return 'not_applicable'
    }
  }, [])

  useEffect(() => {
    fetchMicStatus()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [fetchMicStatus])

  const handleGrantAccess = useCallback(async () => {
    setMicRequesting(true)
    setGrantFailed(false)

    // Strategy 1: Try native TCC request (works in signed .app builds)
    try {
      const granted = await invoke<boolean>('plugin:tts|request_microphone_permission')
      if (granted) {
        await fetchMicStatus()
        setMicRequesting(false)
        return
      }
    } catch {
      // Native request failed — try helper next
    }

    // Strategy 2: Launch a helper .app bundle to trigger the TCC dialog.
    // On macOS Sequoia, non-bundled binaries (cargo tauri dev) cannot
    // trigger the TCC permission dialog. The helper is a proper .app
    // with bundle ID jan.ai.app, which macOS accepts.
    try {
      await invoke<boolean>('plugin:tts|request_microphone_via_helper')
      const newStatus = await fetchMicStatus()
      // The native status may still show "not_determined" for the dev binary
      // because TCC tracks non-bundled binaries separately. But the permission
      // IS granted for jan.ai.app — production builds will see "authorized".
      if (newStatus === 'authorized') {
        setMicRequesting(false)
        return
      }
      // For dev builds: permission was granted via the helper but the dev
      // binary can't see it. Persist so it survives page navigation.
      localStorage.setItem(MIC_HELPER_GRANTED_KEY, 'true')
      setMicStatus('authorized')
      setMicRequesting(false)
      return
    } catch {
      // Helper also failed
    }

    // All strategies failed
    const newStatus = await fetchMicStatus()
    if (newStatus === 'not_determined') {
      setGrantFailed(true)
    }
    setMicRequesting(false)
  }, [fetchMicStatus])

  const handleOpenSettings = useCallback(async () => {
    try {
      await invoke('plugin:tts|open_microphone_settings')
    } catch {
      // ignore
    }
    // Poll for status change after user returns from System Settings
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => fetchMicStatus(), 2000)
    setTimeout(() => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }, 30000)
  }, [fetchMicStatus])

  return { micStatus, micRequesting, grantFailed, handleGrantAccess, handleOpenSettings }
}

function SpeechSettings() {
  const { t } = useTranslation()
  const {
    serverStatus,
    serverError,
    isServerReady,
    retryServer,
    models,
    modelsLoading,
    modelsError,
    refetchModels,
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
  } = useTtsSettings()

  const { micStatus, micRequesting, grantFailed, handleGrantAccess, handleOpenSettings } =
    useMicrophoneStatus()

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className="font-medium text-base font-studio">
            {t('common:settings')}
          </span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
            {/* Microphone Permission */}
            {IS_TAURI && IS_MACOS && micStatus !== 'loading' && (
              <Card title="Microphone">
                <CardItem
                  title="Microphone Access"
                  description={
                    micStatus === 'authorized'
                      ? 'Microphone access is granted'
                      : micStatus === 'denied'
                        ? 'Microphone access was denied. Enable it in System Settings.'
                        : micStatus === 'not_determined' && grantFailed
                          ? 'Could not trigger the permission dialog. Enable microphone access in System Settings → Privacy & Security → Microphone.'
                          : micStatus === 'not_determined'
                            ? 'Grant microphone access for voice input'
                            : 'Microphone access is restricted by system policy'
                  }
                  actions={
                    micStatus === 'authorized' ? (
                      <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                        <IconCheck size={14} />
                        Granted
                      </span>
                    ) : micStatus === 'not_determined' && !grantFailed ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleGrantAccess}
                        disabled={micRequesting}
                      >
                        {micRequesting ? (
                          <IconLoader2 size={14} className="animate-spin mr-1.5" />
                        ) : (
                          <IconMicrophone size={14} className="mr-1.5" />
                        )}
                        Grant Access
                      </Button>
                    ) : micStatus === 'denied' || (micStatus === 'not_determined' && grantFailed) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleOpenSettings}
                      >
                        <IconExternalLink size={14} className="mr-1.5" />
                        Open System Settings
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        Restricted
                      </span>
                    )
                  }
                />
              </Card>
            )}

            {/* Server Status — only shown when not ready */}
            {serverStatus === 'starting' && (
              <Card>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <IconLoader2 size={16} className="animate-spin" />
                  <span>Starting TTS server...</span>
                </div>
              </Card>
            )}
            {serverStatus === 'error' && (
              <Card>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-destructive">
                    <IconAlertTriangle size={16} />
                    <span>
                      Failed to start TTS server
                      {serverError && (
                        <span className="text-muted-foreground text-sm ml-1">
                          — {serverError}
                        </span>
                      )}
                    </span>
                  </div>
                  <Button variant="outline" size="sm" onClick={retryServer}>
                    <IconRefresh size={14} className="mr-1.5" />
                    Retry
                  </Button>
                </div>
              </Card>
            )}

            {/* Models */}
            <Card title="Models">
              {serverStatus === 'starting' || modelsLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <IconLoader2 size={14} className="animate-spin" />
                  <span>
                    {serverStatus === 'starting'
                      ? 'Waiting for server...'
                      : 'Loading models...'}
                  </span>
                </div>
              ) : serverStatus === 'error' ? (
                <span className="text-muted-foreground">
                  TTS server is not running. Start the server to manage models.
                </span>
              ) : modelsError ? (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    Failed to load models: {modelsError}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetchModels()}
                  >
                    <IconRefresh size={14} className="mr-1.5" />
                    Retry
                  </Button>
                </div>
              ) : models.length === 0 ? (
                <span className="text-muted-foreground">
                  No models available
                </span>
              ) : (
                models.map((model) => (
                  <CardItem
                    key={model.id}
                    title={model.name}
                    description={model.size}
                    actions={
                      <ModelActions
                        model={model}
                        loadingModels={loadingModels}
                        onDownload={downloadModel}
                        onLoad={loadModel}
                        onUnload={unloadModel}
                      />
                    }
                  />
                ))
              )}
            </Card>

            {/* Voice */}
            <Card title="Voice">
              <CardItem
                title="Voice"
                description="Select the voice for text-to-speech"
                actions={
                  <div className="flex items-center gap-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-40 justify-between"
                        >
                          {voiceLabel(ttsVoice)}
                          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {VOICES.map((voice) => (
                          <DropdownMenuItem
                            key={voice}
                            className={cn(
                              'cursor-pointer my-0.5',
                              ttsVoice === voice &&
                                'bg-secondary-foreground/8'
                            )}
                            onClick={() => updateVoice(voice)}
                          >
                            {voiceLabel(voice)}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        isPreviewPlaying
                          ? stopPreview()
                          : previewVoice(ttsVoice)
                      }
                      disabled={!isServerReady}
                    >
                      {isPreviewPlaying ? (
                        <IconPlayerStop size={14} />
                      ) : (
                        <IconPlayerPlay size={14} />
                      )}
                    </Button>
                  </div>
                }
              />
            </Card>

            {/* Speed */}
            <Card title="Speed">
              <CardItem
                title="Playback speed"
                description="Adjust the speed of text-to-speech playback"
                actions={
                  <div className="flex items-center gap-3 w-48">
                    <Slider
                      min={0.5}
                      max={2}
                      step={0.1}
                      value={[ttsSpeed]}
                      onValueChange={([value]) => updateSpeed(value)}
                    />
                    <span className="text-sm font-medium w-10 text-right tabular-nums">
                      {ttsSpeed.toFixed(1)}x
                    </span>
                  </div>
                }
              />
            </Card>

            {/* Behavior */}
            <Card title="Behavior">
              <CardItem
                title="Auto-speak responses"
                description="Automatically read assistant responses aloud in voice mode"
                actions={
                  <Switch
                    checked={autoSpeakResponses}
                    onCheckedChange={setAutoSpeakResponses}
                  />
                }
              />
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
