import { cn } from '@/lib/utils'
import { IconX, IconHandStop } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'

interface VoiceControlBarProps {
  ttsState: 'idle' | 'loading' | 'speaking'
  onInterrupt: () => void
  onClose: () => void
}

export function VoiceControlBar({
  ttsState,
  onInterrupt,
  onClose,
}: VoiceControlBarProps) {
  const isSpeaking = ttsState === 'speaking' || ttsState === 'loading'

  return (
    <div className="flex items-center justify-center gap-4 w-full max-w-[480px] mx-auto px-6 pb-12">
      {/* Spacer to balance close button */}
      <div className="flex-1" />

      {/* Interrupt button - center */}
      {isSpeaking && (
        <button
          onClick={onInterrupt}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-full',
            'text-sm font-medium text-primary',
            'hover:bg-primary/10 transition-colors'
          )}
        >
          <IconHandStop size={16} />
          <span>Tap to interrupt</span>
        </button>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Close button - right */}
      <Button
        variant="ghost"
        size="icon-lg"
        onClick={onClose}
        className="bg-secondary/80 hover:bg-secondary text-muted-foreground"
      >
        <IconX size={18} />
      </Button>
    </div>
  )
}
