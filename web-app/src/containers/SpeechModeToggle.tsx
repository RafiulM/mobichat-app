import { memo, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { IconMicrophone } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useSpeechStore } from '@/stores/speech-store'

const SpeechModeToggle = memo(function SpeechModeToggle() {
  const isActive = useSpeechStore((s) => s.isVoiceModeActive)
  const toggleVoiceMode = useSpeechStore((s) => s.toggleVoiceMode)
  const setOverlayOpen = useSpeechStore((s) => s.setOverlayOpen)

  const handleToggle = useCallback(() => {
    toggleVoiceMode()
    if (!isActive) {
      setOverlayOpen(true)
    }
  }, [isActive, toggleVoiceMode, setOverlayOpen])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'gap-1.5 text-xs font-medium',
            isActive
              ? 'text-primary bg-primary/10 hover:bg-primary/15'
              : 'text-muted-foreground'
          )}
          onClick={handleToggle}
        >
          <IconMicrophone size={16} />
          Voice
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>
          {isActive
            ? 'Voice mode active — tap to disable'
            : 'Enable voice conversation mode'}
        </p>
      </TooltipContent>
    </Tooltip>
  )
})

export default SpeechModeToggle
