import { cn } from '@/lib/utils'
import { IconMicrophone } from '@tabler/icons-react'
import { motion } from 'framer-motion'

interface VoiceIndicatorProps {
  state: 'listening' | 'speaking' | 'idle'
  className?: string
}

const WAVEFORM_BAR_HEIGHTS = [6, 10, 14, 8, 12, 6]
const WAVEFORM_MIN_HEIGHT = 4
const WAVEFORM_BAR_WIDTH = 2

function ListeningRings() {
  return (
    <div className="relative flex items-center justify-center size-10">
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="absolute rounded-full border border-primary/40"
          initial={{ width: 16, height: 16, opacity: 0.6 }}
          animate={{
            width: [16, 24 + i * 8],
            height: [16, 24 + i * 8],
            opacity: [0.6 - i * 0.15, 0.1],
            scale: [1, 1.1],
          }}
          transition={{
            duration: 1.5,
            repeat: Infinity,
            repeatType: 'loop',
            delay: i * 0.3,
            ease: 'easeOut',
          }}
        />
      ))}
      <div className="size-3 rounded-full bg-primary" />
    </div>
  )
}

function WaveformBars() {
  return (
    <div className="flex items-end gap-[2px] h-4">
      {WAVEFORM_BAR_HEIGHTS.map((maxHeight, index) => (
        <motion.div
          key={index}
          className="rounded-sm bg-primary"
          style={{ width: WAVEFORM_BAR_WIDTH }}
          initial={{ height: WAVEFORM_MIN_HEIGHT }}
          animate={{ height: [WAVEFORM_MIN_HEIGHT, maxHeight, WAVEFORM_MIN_HEIGHT] }}
          transition={{
            duration: 0.4 + index * 0.05,
            repeat: Infinity,
            repeatType: 'loop',
            ease: 'easeInOut',
            delay: index * 0.08,
          }}
        />
      ))}
    </div>
  )
}

export function VoiceIndicator({ state, className }: VoiceIndicatorProps) {
  return (
    <div className={cn('flex items-center justify-center', className)}>
      {state === 'listening' && <ListeningRings />}
      {state === 'speaking' && <WaveformBars />}
      {state === 'idle' && (
        <IconMicrophone size={20} className="text-muted-foreground" />
      )}
    </div>
  )
}
