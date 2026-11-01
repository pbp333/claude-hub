import { create } from 'zustand'
import type { HubState, Session } from '../../shared/types'

type Dialog = { type: 'newSession' } | { type: 'rename'; sessionId: string } | { type: 'palette'; mode: 'files' | 'commands' }

interface UiState {
  hub?: HubState
  activeSessionId?: string
  fileTreeVisible: boolean
  dialog?: Dialog
  /** Session order as shown in the sidebar, for ⌘1…9 and "next that needs me". */
  sidebarOrder: string[]
  setHub(hub: HubState): void
  setActiveSession(id: string | undefined): void
  toggleFileTree(): void
  openDialog(dialog: Dialog | undefined): void
  setSidebarOrder(order: string[]): void
}

export const useUi = create<UiState>((set) => ({
  fileTreeVisible: true,
  sidebarOrder: [],
  setHub: (hub) => set({ hub }),
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
