/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useSearch } from '@tanstack/react-router'
import ChatInput from '@/containers/ChatInput'
import HeaderPage from '@/containers/HeaderPage'
import { useTools } from '@/hooks/useTools'
import { cn, getModelDisplayName, getProviderTitle } from '@/lib/utils'

import { useModelProvider } from '@/hooks/useModelProvider'
import { route } from '@/constants/routes'

type ThreadModel = {
  id: string
  provider: string
}

type SearchParams = {
  threadModel?: ThreadModel
  projectId?: string
}
import { useCallback, useEffect, useMemo } from 'react'
import { useThreads } from '@/hooks/useThreads'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import { FolderIcon, X } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useSpeechMode } from '@/hooks/useSpeechMode'
import { VoiceOverlay } from '@/components/VoiceOverlay'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { usePrompt } from '@/hooks/usePrompt'

const LOCAL_PROVIDERS = ['llamacpp', 'jan', 'mlx']

export const Route = createFileRoute(route.home as any)({
  component: Index,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const result: SearchParams = {
      threadModel: search.threadModel as ThreadModel | undefined,
      projectId: search.projectId as string | undefined,
    }

    return result
  },
})

function Index() {
  const { selectedModel, selectedProvider } = useModelProvider()
  const search = useSearch({ from: route.home as any })
  const threadModel = search.threadModel
  const projectId = search.projectId
  const { setCurrentThreadId } = useThreads()
  const { getFolderById } = useThreadManagement()
  const navigate = useNavigate()
  useTools()

  const setPrompt = usePrompt((state) => state.setPrompt)

  const speechMode = useSpeechMode({
    threadId: TEMPORARY_CHAT_ID,
    chatMessages: [],
    chatStatus: 'ready',
    onSubmit: useCallback(
      (transcript: string) => {
        setPrompt(transcript)
      },
      [setPrompt]
    ),
  })

  useEffect(() => {
    setCurrentThreadId(undefined)
  }, [setCurrentThreadId])

  const project = useMemo(() => {
    if (!projectId) return null
    return getFolderById(projectId) ?? null
  }, [projectId, getFolderById])

  const modelSubtitle = useMemo(() => {
    if (!selectedModel) return null
    const parts: string[] = []
    parts.push(getModelDisplayName(selectedModel))
    if (LOCAL_PROVIDERS.includes(selectedProvider)) {
      parts.push('Running locally')
    } else {
      parts.push(getProviderTitle(selectedProvider))
    }
    return parts.join(' \u00b7 ')
  }, [selectedModel, selectedProvider])

  return (
    <div className="flex h-full flex-col justify-center">
      <HeaderPage>
        <DropdownModelProvider model={threadModel} useLastUsedModel minimal />
      </HeaderPage>
      <div
        className={cn(
          'h-full overflow-y-auto inline-flex flex-col gap-2 justify-center px-3'
        )}
      >
        <div
          className={cn(
            'mx-auto w-full md:w-4/5 xl:w-4/6 -mt-20',
          )}
        >
          <div className={cn('text-center mb-4')}>
            <h1
              className="text-5xl mt-2 font-medium leading-tight"
              style={{ fontFamily: '"Instrument Serif", Georgia, serif' }}
            >
              What can I help
              <br />
              you <span className="italic text-[#C4A882]">think</span> about?
            </h1>
            {modelSubtitle && (
              <p className="text-sm text-muted-foreground mt-3">
                {modelSubtitle}
              </p>
            )}
          </div>
          {project && (
            <div className="flex items-center justify-center mb-3">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-sm text-foreground">
                <FolderIcon className="size-3.5 text-muted-foreground" />
                <span>{project.name}</span>
                <button
                  className="ml-1 rounded-full p-0.5 hover:bg-foreground/10 cursor-pointer"
                  onClick={() => navigate({ to: route.home })}
                >
                  <X className="size-3 text-muted-foreground" />
                </button>
              </div>
            </div>
          )}
          <div className="flex-1 shrink-0">
            <ChatInput
              showSpeedToken={false}
              model={threadModel}
              initialMessage={true}
              projectId={projectId}
              speechMode={speechMode}
            />
          </div>
        </div>
      </div>

      <VoiceOverlay
        isOpen={speechMode.isOverlayOpen}
        onClose={() => speechMode.setOverlayOpen(false)}
        sttState={speechMode.sttState}
        sttError={speechMode.sttError}
        isSttSupported={speechMode.isSttSupported}
        ttsState={speechMode.ttsState}
        chatStatus="ready"
        currentTranscript={speechMode.currentTranscript}
        messages={[]}
        onInterrupt={speechMode.stopSpeaking}
      />
    </div>
  )
}
