import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

const PROJECT_COLORS = [
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#64748b', // slate
  '#78716c', // stone
]

interface AddProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingKey: string | null
  initialData?: {
    id: string
    name: string
    updated_at: number
    assistantId?: string
    color?: string
  }
  onSave: (name: string, assistantId?: string) => void
}

export default function AddProjectDialog({
  open,
  onOpenChange,
  editingKey,
  initialData,
  onSave,
}: AddProjectDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(initialData?.name || '')
  const [selectedColor, setSelectedColor] = useState(initialData?.color || PROJECT_COLORS[0])
  const { folders } = useThreadManagement()

  useEffect(() => {
    if (open) {
      setName(initialData?.name || '')
      setSelectedColor(initialData?.color || PROJECT_COLORS[0])
    }
  }, [open, initialData])

  const handleSave = () => {
    if (!name.trim()) return

    const trimmedName = name.trim()

    // Check for duplicate names (excluding current project when editing)
    const isDuplicate = folders.some(
      (folder) =>
        folder.name.toLowerCase() === trimmedName.toLowerCase() &&
        folder.id !== editingKey
    )

    if (isDuplicate) {
      toast.warning(t('projects.addProjectDialog.alreadyExists', { projectName: trimmedName }))
      return
    }

    onSave(trimmedName)

    // Show success message
    if (editingKey) {
      toast.success(t('projects.addProjectDialog.updateSuccess', { projectName: trimmedName }))
    } else {
      toast.success(t('projects.addProjectDialog.createSuccess', { projectName: trimmedName }))
    }
    setName('')
    setSelectedColor(PROJECT_COLORS[0])
  }

  const handleCancel = () => {
    onOpenChange(false)
    setName('')
    setSelectedColor(PROJECT_COLORS[0])
  }

  // Check if the button should be disabled
  const hasChanged = editingKey
    ? name.trim() !== initialData?.name
    : true
  const isButtonDisabled = !name.trim() || (editingKey && !hasChanged)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingKey ? t('projects.addProjectDialog.editTitle') : t('projects.addProjectDialog.createTitle')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('projects.addProjectDialog.namePlaceholder')}
              className="mt-1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isButtonDisabled) {
                  handleSave()
                }
              }}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-2 block">
              Color
            </label>
            <div className="flex flex-wrap gap-2">
              {PROJECT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={cn(
                    'size-7 rounded-full cursor-pointer transition-all duration-150 ring-offset-2 ring-offset-background',
                    selectedColor === color ? 'ring-2 ring-foreground scale-110' : 'hover:scale-105'
                  )}
                  style={{ backgroundColor: color }}
                  onClick={() => setSelectedColor(color)}
                />
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={handleCancel}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={Boolean(isButtonDisabled)}>
            {editingKey ? t('projects.addProjectDialog.updateButton') : t('projects.addProjectDialog.createButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
