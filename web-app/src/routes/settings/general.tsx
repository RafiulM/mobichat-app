import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import SettingsMenu from '@/containers/SettingsMenu'
import HeaderPage from '@/containers/HeaderPage'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useAppUpdater } from '@/hooks/useAppUpdater'
import { useEffect, useState, useCallback } from 'react'
import ChangeDataFolderLocation from '@/containers/dialogs/ChangeDataFolderLocation'
import { FactoryResetDialog } from '@/containers/dialogs'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  IconFolder,
  IconCopy,
  IconCopyCheck,
} from '@tabler/icons-react'
import { toast } from 'sonner'
import { isDev } from '@/lib/utils'
import { SystemEvent } from '@/types/events'
import { useHardware } from '@/hooks/useHardware'
import LanguageSwitcher from '@/containers/LanguageSwitcher'
import { ThemeSwitcher } from '@/containers/ThemeSwitcher'
import { isRootDir } from '@/utils/path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.general as any)({
  component: General,
})

function General() {
  const { t } = useTranslation()
  const {
    spellCheckChatInput,
    setSpellCheckChatInput,
  } = useGeneralSetting()
  const serviceHub = useServiceHub()

  const { checkForUpdate } = useAppUpdater()
  const { pausePolling } = useHardware()
  const [janDataFolder, setJanDataFolder] = useState<string | undefined>()
  const [isCopied, setIsCopied] = useState(false)
  const [selectedNewPath, setSelectedNewPath] = useState<string | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)

  useEffect(() => {
    const fetchDataFolder = async () => {
      const path = await serviceHub.app().getJanDataFolder()
      setJanDataFolder(path)
    }

    fetchDataFolder()
  }, [serviceHub])

  const resetApp = async () => {
    // Prevent resetting if data folder is root directory
    if (isRootDir(janDataFolder ?? '/')) {
      toast.error(t('settings:general.couldNotResetRootDirectory'))
      return
    }
    pausePolling()
    await serviceHub.app().factoryReset()
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy to clipboard:', error)
    }
  }

  const handleDataFolderChange = async () => {
    const selectedPath = await serviceHub.dialog().open({
      multiple: false,
      directory: true,
      defaultPath: janDataFolder,
    })

    if (selectedPath === janDataFolder) return
    if (selectedPath !== null) {
      setSelectedNewPath(selectedPath as string)
      setIsDialogOpen(true)
    }
  }

  const confirmDataFolderChange = async () => {
    if (selectedNewPath) {
      try {
        await serviceHub.models().stopAllModels()
        serviceHub.events().emit(SystemEvent.KILL_SIDECAR)
        setTimeout(async () => {
          try {
            if (isRootDir(selectedNewPath))
              throw new Error(t('settings:general.couldNotRelocateToRoot'))
            await serviceHub.app().relocateJanDataFolder(selectedNewPath)
            setJanDataFolder(selectedNewPath)
            window.core?.api?.relaunch()
            setSelectedNewPath(null)
            setIsDialogOpen(false)
          } catch (error) {
            console.error(error)
            toast.error(
              error instanceof Error
                ? error.message
                : t('settings:general.failedToRelocateDataFolder')
            )
          }
        }, 1000)
      } catch (error) {
        console.error('Failed to relocate data folder:', error)
        const originalPath = await serviceHub.app().getJanDataFolder()
        setJanDataFolder(originalPath)

        toast.error(t('settings:general.failedToRelocateDataFolderDesc'))
      }
    }
  }

  const handleCheckForUpdate = useCallback(async () => {
    setIsCheckingUpdate(true)
    try {
      if (isDev()) return toast.info(t('settings:general.devVersion'))
      const update = await checkForUpdate(true)
      if (!update) {
        toast.info(t('settings:general.noUpdateAvailable'))
      }
    } catch (error) {
      console.error('Failed to check for updates:', error)
      toast.error(t('settings:general.updateError'))
    } finally {
      setIsCheckingUpdate(false)
    }
  }, [t, checkForUpdate])

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className='font-medium text-base font-studio'>{t('common:settings')}</span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">

            {/* General */}
            <Card title={t('common:general')}>
              <CardItem
                title={t('settings:general.appVersion')}
                actions={
                  <span className="text-foreground font-medium">
                    v{VERSION}
                  </span>
                }
              />
              {!AUTO_UPDATER_DISABLED && (
                <CardItem
                  title={t('settings:general.checkForUpdates')}
                  description={t('settings:general.checkForUpdatesDesc')}
                  className="items-center flex-row gap-y-2"
                  actions={
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleCheckForUpdate}
                      disabled={isCheckingUpdate}
                    >
                      {isCheckingUpdate
                        ? t('settings:general.checkingForUpdates')
                        : t('settings:general.checkForUpdates')}
                    </Button>
                  }
                />
              )}
              <CardItem
                title={t('common:language')}
                actions={<LanguageSwitcher />}
              />
              <CardItem
                title={t('settings:interface.theme')}
                description={t('settings:interface.themeDesc')}
                actions={<ThemeSwitcher />}
              />
            </Card>

            {/* Data folder - Desktop only */}
            <Card title={t('common:dataFolder')}>
              <CardItem
                title={t('settings:dataFolder.appData', {
                  ns: 'settings',
                })}
                align="start"
                className="items-start flex-row gap-2"
                description={
                  <>
                    <span>
                      {t('settings:dataFolder.appDataDesc', {
                        ns: 'settings',
                      })}
                      &nbsp;
                    </span>
                    <div className="flex items-center gap-2 mt-1 ">
                      <div className="truncate">
                        <span
                          title={janDataFolder}
                          className="bg-secondary text-xs p-1 rounded-sm"
                        >
                          {janDataFolder}
                        </span>
                      </div>
                      <button
                        onClick={() =>
                          janDataFolder && copyToClipboard(janDataFolder)
                        }
                        className="cursor-pointer flex items-center justify-center rounded-sm bg-secondary transition-all duration-200 ease-in-out p-1"
                        title={
                          isCopied
                            ? t('settings:general.copied')
                            : t('settings:general.copyPath')
                        }
                      >
                        {isCopied ? (
                          <div className="flex items-center gap-1">
                            <IconCopyCheck size={14} className="text-green-500 dark:text-green-600" />
                            <span className="text-xs leading-0">
                              {t('settings:general.copied')}
                            </span>
                          </div>
                        ) : (
                          <IconCopy
                            size={14}
                            className="text-muted-foreground"
                          />
                        )}
                      </button>
                    </div>
                  </>
                }
                actions={
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      title={t('settings:dataFolder.appData')}
                      onClick={handleDataFolderChange}
                    >
                        <IconFolder
                          size={12}
                          className="text-muted-foreground"
                        />
                        <span>{t('settings:general.changeLocation')}</span>
                    </Button>
                    {selectedNewPath && (
                      <ChangeDataFolderLocation
                        currentPath={janDataFolder || ''}
                        newPath={selectedNewPath}
                        onConfirm={confirmDataFolderChange}
                        open={isDialogOpen}
                        onOpenChange={(open) => {
                          setIsDialogOpen(open)
                          if (!open) {
                            setSelectedNewPath(null)
                          }
                        }}
                      >
                        <div />
                      </ChangeDataFolderLocation>
                    )}
                  </>
                }
              />
            </Card>

            {/* Other */}
            <Card title={t('common:others')}>
              <CardItem
                title={t('settings:others.spellCheck', {
                  ns: 'settings',
                })}
                description={t('settings:others.spellCheckDesc', {
                  ns: 'settings',
                })}
                actions={
                  <Switch
                    checked={spellCheckChatInput}
                    onCheckedChange={(e) => setSpellCheckChatInput(e)}
                  />
                }
              />
            </Card>

            {/* Factory Reset - at bottom */}
            <Card title={t('settings:others.resetFactory', { ns: 'settings' })}>
              <CardItem
                title={t('settings:others.resetFactory', {
                  ns: 'settings',
                })}
                description={t('settings:others.resetFactoryDesc', {
                  ns: 'settings',
                })}
                actions={
                  <FactoryResetDialog onReset={resetApp}>
                    <Button variant="destructive" size="sm">
                      {t('common:reset')}
                    </Button>
                  </FactoryResetDialog>
                }
              />
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
