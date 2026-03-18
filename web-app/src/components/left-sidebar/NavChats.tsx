import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarGroupAction,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  FolderIcon,
  FolderOpenIcon,
  FolderEditIcon,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useThreads } from "@/hooks/useThreads"
import { useThreadManagement } from "@/hooks/useThreadManagement"
import ThreadList from "@/containers/ThreadList"
import { DeleteAllThreadsDialog } from "@/containers/dialogs/DeleteAllThreadsDialog"
import AddProjectDialog from "@/containers/dialogs/AddProjectDialog"
import { DeleteProjectDialog } from "@/containers/dialogs/DeleteProjectDialog"
import type { ThreadFolder } from "@/services/projects/types"
import { Link, useNavigate } from "@tanstack/react-router"
import { route } from "@/constants/routes"

function ProjectCollapsible({
  project,
  threads,
  onEdit,
  onDelete,
}: {
  project: ThreadFolder
  threads: Thread[]
  onEdit: (project: ThreadFolder) => void
  onDelete: (project: ThreadFolder) => void
}) {
  const { isMobile } = useSidebar()
  const navigate = useNavigate()

  const sortedThreads = useMemo(() => {
    return [...threads].sort((a, b) => (b.updated || 0) - (a.updated || 0))
  }, [threads])

  return (
    <Collapsible asChild defaultOpen className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton size="sm">
            <FolderIcon className="!size-3.5 text-foreground/70 group-data-[state=open]/collapsible:hidden" />
            <FolderOpenIcon className="!size-3.5 text-foreground/70 hidden group-data-[state=open]/collapsible:block" />
            <span className="truncate text-[13px]">{project.name}</span>
          </SidebarMenuButton>
        </CollapsibleTrigger>

        <SidebarMenuAction
          showOnHover
          className="hover:bg-sidebar-foreground/8 right-6"
          onClick={(e) => {
            e.stopPropagation()
            navigate({
              to: route.home,
              search: { projectId: project.id },
            })
          }}
          title="New chat in project"
        >
          <Plus className="!size-3.5" />
        </SidebarMenuAction>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction showOnHover className="hover:bg-sidebar-foreground/8">
              <MoreHorizontal className="!size-3.5" />
              <span className="sr-only">More</span>
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-48"
            side={isMobile ? "bottom" : "right"}
            align={isMobile ? "end" : "start"}
          >
            <DropdownMenuItem onSelect={() => onEdit(project)}>
              <FolderEditIcon className="text-muted-foreground" />
              <span>Edit Project</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(project)}>
              <Trash2 />
              <span>Delete Project</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <CollapsibleContent>
          <SidebarMenuSub>
            {sortedThreads.length === 0 ? (
              <SidebarMenuSubItem>
                <SidebarMenuSubButton asChild>
                  <Link
                    to={route.home}
                    search={{ projectId: project.id }}
                    className="text-muted-foreground text-xs"
                  >
                    <Plus className="size-3" />
                    <span>New chat</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ) : (
              sortedThreads.map((thread) => (
                <SidebarMenuSubItem key={thread.id}>
                  <SidebarMenuSubButton asChild>
                    <Link to="/threads/$threadId" params={{ threadId: thread.id }}>
                      <span className="truncate text-[13px]">{thread.title || 'New Thread'}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

export function NavChats() {
  const { t } = useTranslation()
  const getFilteredThreads = useThreads((state) => state.getFilteredThreads)
  const threads = useThreads((state) => state.threads)
  const deleteAllThreads = useThreads((state) => state.deleteAllThreads)
  const { folders, updateFolder } = useThreadManagement()
  const navigate = useNavigate()
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [selectedProject, setSelectedProject] = useState<ThreadFolder | null>(null)

  const allThreads = useMemo(() => {
    return getFilteredThreads('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getFilteredThreads, threads])

  const threadsWithoutProject = useMemo(() => {
    return allThreads.filter((thread) => !thread.metadata?.project)
  }, [allThreads])

  const threadsByProject = useMemo(() => {
    const map = new Map<string, Thread[]>()
    for (const thread of allThreads) {
      const projectId = thread.metadata?.project?.id
      if (projectId) {
        if (!map.has(projectId)) map.set(projectId, [])
        map.get(projectId)!.push(thread)
      }
    }
    return map
  }, [allThreads])

  // Build a mixed list of projects and non-project threads sorted by recency
  const sidebarItems = useMemo(() => {
    type SidebarItem =
      | { type: 'thread'; thread: Thread; updated: number }
      | { type: 'project'; project: ThreadFolder; threads: Thread[]; updated: number }

    const items: SidebarItem[] = []

    for (const thread of threadsWithoutProject) {
      items.push({ type: 'thread', thread, updated: thread.updated || 0 })
    }

    for (const folder of folders) {
      const projectThreads = threadsByProject.get(folder.id) || []
      const latestThreadUpdate = projectThreads.reduce(
        (max, t) => Math.max(max, t.updated || 0),
        0
      )
      items.push({
        type: 'project',
        project: folder,
        threads: projectThreads,
        updated: Math.max(latestThreadUpdate, folder.updated_at || 0),
      })
    }

    items.sort((a, b) => b.updated - a.updated)
    return items
  }, [threadsWithoutProject, folders, threadsByProject])

  const handleEdit = (project: ThreadFolder) => {
    setSelectedProject(project)
    setEditDialogOpen(true)
  }

  const handleDelete = (project: ThreadFolder) => {
    setSelectedProject(project)
    setDeleteDialogOpen(true)
  }

  const handleSaveEdit = async (name: string, assistantId?: string) => {
    if (selectedProject) {
      await updateFolder(selectedProject.id, name, assistantId)
      setEditDialogOpen(false)
      setSelectedProject(null)
    }
  }

  if (sidebarItems.length === 0) {
    return null
  }

  return (
    <>
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>{t('common:chats')}</SidebarGroupLabel>
        {threadsWithoutProject.length > 1 &&
          <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <SidebarGroupAction className="hover:bg-sidebar-foreground/8">
                <MoreHorizontal className="text-muted-foreground" />
                <span className="sr-only">More</span>
              </SidebarGroupAction>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start">
              <DeleteAllThreadsDialog
                onDeleteAll={deleteAllThreads}
                onDropdownClose={() => setDropdownOpen(false)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        }
        <SidebarMenu>
          {sidebarItems.map((item) => {
            if (item.type === 'project') {
              return (
                <ProjectCollapsible
                  key={item.project.id}
                  project={item.project}
                  threads={item.threads}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                />
              )
            }
            return (
              <ThreadList
                key={item.thread.id}
                threads={[item.thread]}
              />
            )
          })}
        </SidebarMenu>
      </SidebarGroup>

      <AddProjectDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        editingKey={selectedProject?.id ?? null}
        initialData={selectedProject ?? undefined}
        onSave={handleSaveEdit}
      />

      <DeleteProjectDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        projectId={selectedProject?.id}
        projectName={selectedProject?.name}
      />
    </>
  )
}
