import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { useTheme } from '@/hooks/useTheme'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  ChevronsUpDown,
  Settings,
  Sun,
  Moon,
  Monitor,
  Check,
} from 'lucide-react'

export function NavUser() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { activeTheme, setTheme } = useTheme()

  const themeOptions = [
    { value: 'light' as const, label: t('common:light'), icon: Sun },
    { value: 'dark' as const, label: t('common:dark'), icon: Moon },
    { value: 'auto' as const, label: t('common:system'), icon: Monitor },
  ]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
        >
          <Avatar className="h-7 w-7">
            <AvatarFallback className="bg-primary text-primary-foreground text-xs font-medium">
              M
            </AvatarFallback>
          </Avatar>
          <span className="truncate text-sm font-medium">Mobi</span>
          <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-56"
        side="top"
        align="start"
        sideOffset={8}
      >
        <DropdownMenuLabel className="font-normal">
          <div className="flex items-center gap-2">
            <Avatar className="h-7 w-7">
              <AvatarFallback className="bg-primary text-primary-foreground text-xs font-medium">
                M
              </AvatarFallback>
            </Avatar>
            <span className="text-sm font-medium">Mobi</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {activeTheme === 'dark' ? (
                <Moon className="size-4" />
              ) : activeTheme === 'light' ? (
                <Sun className="size-4" />
              ) : (
                <Monitor className="size-4" />
              )}
              {t('settings:interface.theme')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {themeOptions.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onClick={() => setTheme(option.value)}
                >
                  <option.icon className="size-4" />
                  {option.label}
                  {activeTheme === option.value && (
                    <Check className="ml-auto size-4" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => navigate({ to: route.settings.general })}
        >
          <Settings className="size-4" />
          {t('common:settings')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
