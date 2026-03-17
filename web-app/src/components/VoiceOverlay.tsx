import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { VoiceControlBar } from '@/components/VoiceControlBar'

// ── Types ────────────────────────────────────────────────────────────

interface VoiceOverlayProps {
  isOpen: boolean
  onClose: () => void
  sttState: 'idle' | 'listening' | 'processing' | 'error'
  ttsState: 'idle' | 'loading' | 'speaking'
  chatStatus: string
  currentTranscript: string
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>
  onInterrupt: () => void
  sttError?: string | null
  isSttSupported?: boolean
}

// ── Voice Orb ────────────────────────────────────────────────────────

function VoiceOrb({ isActive }: { isActive: boolean }) {
  const size = 200
  const innerSize = size * 0.74
  const middleSize = size * 0.88

  return (
    <div className="relative flex items-center justify-center" style={{ width: size * 2.5, height: size * 2.5 }}>
      {/* Background glow */}
      <div
        className="absolute rounded-full"
        style={{
          width: size * 2.5,
          height: size * 2.5,
          background: 'radial-gradient(circle, rgba(99,102,241,0.12) 0%, rgba(99,102,241,0.04) 50%, transparent 100%)',
        }}
      />

      {/* Outer ring */}
      <motion.div
        className="absolute rounded-full border-2 border-indigo-500/25"
        style={{ width: size, height: size }}
        animate={isActive ? { scale: [1.0, 1.06, 1.0] } : { scale: 1.0 }}
        transition={isActive ? { duration: 2.0, repeat: Infinity, ease: 'easeInOut' } : undefined}
      />

      {/* Middle ring */}
      <motion.div
        className="absolute rounded-full border-[1.5px] border-indigo-500/15"
        style={{ width: middleSize, height: middleSize }}
        animate={isActive ? { scale: [1.0, 1.03, 1.0] } : { scale: 1.0 }}
        transition={isActive ? { duration: 2.0, repeat: Infinity, ease: 'easeInOut', delay: 0.2 } : undefined}
      />

      {/* Inner sphere */}
      <div
        className="absolute rounded-full"
        style={{
          width: innerSize,
          height: innerSize,
          background: 'radial-gradient(circle at 40% 35%, #A5B4FC, #818CF8, #6366F1, #4F46E5, #3730A3)',
          boxShadow: '0 0 30px rgba(99,102,241,0.35), 0 0 60px rgba(99,102,241,0.15)',
        }}
      />

      {/* Light spot */}
      <div
        className="absolute rounded-full"
        style={{
          width: size * 0.3,
          height: size * 0.3,
          background: 'radial-gradient(circle, rgba(255,255,255,0.15), transparent)',
          transform: `translate(${-size * 0.3 * 0.25}px, ${-size * 0.3 * 0.33}px)`,
        }}
      />
    </div>
  )
}

// ── Waveform Indicator (inline for speaking state in messages) ────────

function InlineWaveform() {
  const bars = [6, 10, 14, 8, 12, 6]
  return (
    <div className="flex items-end gap-[2px] h-4">
      {bars.map((maxH, i) => (
        <motion.div
          key={i}
          className="rounded-sm bg-indigo-500"
          style={{ width: 2 }}
          initial={{ height: 4 }}
          animate={{ height: [4, maxH, 4] }}
          transition={{
            duration: 0.4 + i * 0.05,
            repeat: Infinity,
            repeatType: 'loop',
            ease: 'easeInOut',
            delay: i * 0.08,
          }}
        />
      ))}
    </div>
  )
}

// ── Status text helper ────────────────────────────────────────────────

function getStatusText(
  sttState: VoiceOverlayProps['sttState'],
  chatStatus: string,
  sttError?: string | null,
  isSttSupported?: boolean
): string {
  if (isSttSupported === false && sttState === 'idle') {
    return 'Voice mode — type to chat, tap messages to hear them'
  }
  switch (sttState) {
    case 'listening':
      return 'Listening...'
    case 'processing':
      return 'Thinking...'
    case 'error':
      return sttError ? `Error: ${sttError}` : 'An error occurred'
    default:
      // idle — check if AI is still working
      if (chatStatus === 'submitted' || chatStatus === 'streaming') {
        return 'Thinking...'
      }
      return 'Listening...'
  }
}

// ── Initial / Listening content (no messages yet) ─────────────────────

function ListeningContent({
  sttState,
  chatStatus,
  currentTranscript,
  sttError,
  isSttSupported,
}: {
  sttState: VoiceOverlayProps['sttState']
  chatStatus: string
  currentTranscript: string
  sttError?: string | null
  isSttSupported?: boolean
}) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 px-6">
      {/* Title */}
      <h1 className="text-4xl font-bold tracking-tight text-foreground mb-10">
        Jan
      </h1>

      {/* Voice orb */}
      <VoiceOrb isActive={sttState === 'listening'} />

      {/* Status indicator */}
      <div className="flex items-center gap-2 mt-8">
        <div
          className={cn(
            'size-2 rounded-full',
            sttState === 'error'
              ? 'bg-destructive shadow-[0_0_6px] shadow-destructive/60'
              : 'bg-indigo-500 shadow-[0_0_6px] shadow-indigo-500/60'
          )}
        />
        <span
          className={cn(
            'text-base font-medium',
            sttState === 'error' ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {getStatusText(sttState, chatStatus, sttError, isSttSupported)}
        </span>
      </div>

      {/* Live transcript */}
      {currentTranscript && (
        <p className="text-sm text-muted-foreground mt-4 text-center max-w-[400px] line-clamp-2">
          {currentTranscript}
        </p>
      )}
    </div>
  )
}

// ── Conversation content (has messages) ───────────────────────────────

function ConversationContent({
  sttState,
  ttsState,
  chatStatus,
  currentTranscript,
  messages,
  sttError,
  isSttSupported,
}: {
  sttState: VoiceOverlayProps['sttState']
  ttsState: VoiceOverlayProps['ttsState']
  chatStatus: string
  currentTranscript: string
  messages: VoiceOverlayProps['messages']
  sttError?: string | null
  isSttSupported?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const isSpeaking = ttsState === 'speaking' || ttsState === 'loading'

  // Determine header text
  const headerText = isSpeaking
    ? 'Jan is speaking'
    : getStatusText(sttState, chatStatus, sttError, isSttSupported)

  // Auto-scroll to bottom when messages change or transcript updates
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, currentTranscript])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Top status bar */}
      <div className="flex items-center justify-center gap-2 pt-14 pb-4 shrink-0">
        <div className="size-2 rounded-full bg-indigo-500 shadow-[0_0_6px] shadow-indigo-500/60" />
        <span className="text-sm font-medium text-muted-foreground">
          {headerText}
        </span>
      </div>

      {/* Scrollable message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 pb-32">
        <div className="max-w-[600px] mx-auto space-y-5">
          {messages.map((msg, index) => {
            const isLast = index === messages.length - 1
            const isAssistantSpeaking = isLast && msg.role === 'assistant' && isSpeaking

            if (msg.role === 'user') {
              return (
                <div key={msg.id} className="flex justify-end">
                  <div className="bg-secondary text-foreground px-4 py-2.5 rounded-[22px] max-w-[80%] text-[15px]">
                    {msg.text}
                  </div>
                </div>
              )
            }

            // Assistant message
            return (
              <div key={msg.id} className="flex items-start gap-2.5">
                {/* Jan avatar */}
                <div
                  className="size-7 rounded-full shrink-0 mt-0.5"
                  style={{
                    background: 'radial-gradient(circle, #818CF8, #4F46E5)',
                  }}
                />
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-sm font-medium text-foreground">
                    Jan
                  </span>
                  {isAssistantSpeaking ? (
                    <div className="flex items-center gap-1.5 pt-1">
                      <InlineWaveform />
                      <span className="text-xs font-medium text-indigo-500">
                        Speaking...
                      </span>
                    </div>
                  ) : (
                    msg.text && (
                      <p className="text-[15px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
                        {msg.text}
                      </p>
                    )
                  )}
                </div>
              </div>
            )
          })}

          {/* Live transcript as draft user message */}
          {sttState === 'listening' && currentTranscript && (
            <div className="flex justify-end">
              <div className="bg-secondary/60 text-foreground/60 px-4 py-2.5 rounded-[22px] max-w-[80%] text-[15px] italic">
                {currentTranscript}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  )
}

// ── Main overlay ──────────────────────────────────────────────────────

export function VoiceOverlay({
  isOpen,
  onClose,
  sttState,
  ttsState,
  chatStatus,
  currentTranscript,
  messages,
  onInterrupt,
  sttError,
  isSttSupported,
}: VoiceOverlayProps) {
  const hasConversation = messages.length > 0

  const overlay = (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-xl"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          {/* Content area */}
          {hasConversation ? (
            <ConversationContent
              sttState={sttState}
              ttsState={ttsState}
              chatStatus={chatStatus}
              currentTranscript={currentTranscript}
              messages={messages}
              sttError={sttError}
              isSttSupported={isSttSupported}
            />
          ) : (
            <ListeningContent
              sttState={sttState}
              chatStatus={chatStatus}
              currentTranscript={currentTranscript}
              sttError={sttError}
              isSttSupported={isSttSupported}
            />
          )}

          {/* Control bar */}
          <div className="shrink-0">
            <VoiceControlBar
              ttsState={ttsState}
              onInterrupt={onInterrupt}
              onClose={onClose}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  return createPortal(overlay, document.body)
}
