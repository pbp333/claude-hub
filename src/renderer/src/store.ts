import { create } from 'zustand'
import type { HubState, Project, Session } from '../../shared/types'

type Dialog = { type: 'newSession' } | { type: 'rename'; sessionId: string } | { type: 'palette'; mode: 'files' | 'commands' }

interface UiState {
  hub?: HubState
  /** The workspace this window shows; undefined = welcome screen. */
  projectId?: string
  activeSessionId?: string
  fileTreeVisible: boolean
  dialog?: Dialog
  /** Session order as shown in the sidebar, for ⌘1…9 and "next that needs me". */
  sidebarOrder: string[]
  setHub(hub: HubState): void
  setProject(projectId: string | undefined): void
  setActiveSession(id: string | undefined): void
  toggleFileTree(): void
  openDialog(dialog: Dialog | undefined): void
  setSidebarOrder(order: string[]): void
}

export const useUi = create<UiState>((set) => ({
  fileTreeVisible: true,
  sidebarOrder: [],
  setHub: (hub) => set({ hub }),
  setProject: (projectId) => set({ projectId, activeSessionId: undefined, dialog: undefined }),
  setActiveSession: (id) => {
    window.hub.setActiveSession(id)
    set({ activeSessionId: id })
  },
  toggleFileTree: () => set((s) => ({ fileTreeVisible: !s.fileTreeVisible })),
  openDialog: (dialog) => set({ dialog }),
  setSidebarOrder: (sidebarOrder) => set({ sidebarOrder })
}))

export function getSession(id: string | undefined): Session | undefined {
  return id ? useUi.getState().hub?.sessions.find((s) => s.id === id) : undefined
}

export function useSession(id: string | undefined): Session | undefined {
  return useUi((s) => (id ? s.hub?.sessions.find((x) => x.id === id) : undefined))
}

export function useProject(): Project | undefined {
  return useUi((s) => s.hub?.projects.find((p) => p.id === s.projectId))
}

export function getProject(): Project | undefined {
  const { hub, projectId } = useUi.getState()
  return hub?.projects.find((p) => p.id === projectId)
}
