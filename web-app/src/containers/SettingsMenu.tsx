import { Link } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'

const SettingsMenu = () => {
  const { t } = useTranslation()

  const menuSettings = [
    {
      title: 'common:general',
      route: route.settings.general,
    },
    {
      title: 'common:assistants',
      route: route.settings.assistant,
    },
    {
      title: 'common:hardware',
      route: route.settings.hardware,
    },
    {
      title: 'common:speech',
      route: route.settings.speech,
    },
  ]

  return (
    <>
      <div className="h-full w-58 shrink-0 px-1.5 flex overflow-auto">
        <div className="flex flex-col gap-1 w-full font-medium">
          {menuSettings.map((menu) => (
            <div key={menu.title}>
              <Link
                to={menu.route}
                className="block px-2 gap-1.5 cursor-pointer hover:dark:bg-secondary/60 hover:bg-secondary py-1 w-full rounded-sm [&.active]:dark:bg-secondary/80 [&.active]:bg-secondary"
              >
                <div className="flex items-center justify-between">
                  <span>{t(menu.title)}</span>
                </div>
              </Link>
            </div>
          ))}


        </div>
      </div>
    </>
  )
}

export default SettingsMenu
