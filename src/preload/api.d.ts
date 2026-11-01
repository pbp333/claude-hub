import type { DirEntry, GitStatus, HubState, NewSessionOptions, UiCommand, WindowInfo } from '../shared/types'

export interface HubApi {
  getState(): Promise<HubState>
  onState(cb: (state: HubState) => void): () => void
  onCommand(cb: (cmd: UiCommand) => void): () => void
  windowInfo(): Promise<WindowInfo>
  onWindowInfo(cb: (info: WindowInfo) => void): () => void
  /** Folder picker; the chosen folder opens in this window (or focuses the window that has it). */
  openFolder(): void
  openRecent(folder: string): void
  newWindow(): void
  createSession(opts: NewSessionOptions): Promise<string>
  restartSession(id: string): void
  closeSession(id: string): void
  renameSession(id: string, name: string): void
  sessionMenu(id: string): void
  setActiveSession(id: string | undefined): void
  toggleTag(id: string, tagId: string): void
  nextStep(id: string): void
  setStep(id: string, stepId: string): void
  ptyWrite(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void
  ptyBuffer(id: string): Promise<string>
  onPtyData(cb: (id: string, data: string) => void): () => void
  listDir(dir: string): Promise<DirEntry[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  headContent(path: string): Promise<string>
  gitStatus(workspace: string): Promise<GitStatus>
  listFiles(workspace: string): Promise<string[]>
  resolveLinks(cwd: string, candidates: string[]): Promise<{ text: string; path: string }[]>
  onFsChanged(cb: (paths: string[]) => void): () => void
  configPath(file: string): Promise<string | undefined>
  loadLayout(projectId: string): Promise<unknown>
  saveLayout(projectId: string, layout: unknown): void
  openExternal(url: string): void
}

declare global {
  interface Window {
    hub: HubApi
  }
}
