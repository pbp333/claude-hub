import type { DirEntry, GitStatus, HubState, NewSessionOptions, UiCommand } from '../shared/types'

export interface HubApi {
  getState(): Promise<HubState>
  onState(cb: (state: HubState) => void): () => void
  onCommand(cb: (cmd: UiCommand) => void): () => void
  pickFolder(): Promise<string | undefined>
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
  gitStatus(cwd: string): Promise<GitStatus>
  listFiles(cwd: string): Promise<string[] | undefined>
  resolveLinks(cwd: string, candidates: string[]): Promise<{ text: string; path: string }[]>
  onFsChanged(cb: (paths: string[]) => void): () => void
  configPath(file: string): Promise<string | undefined>
  loadLayout(): Promise<unknown>
  saveLayout(layout: unknown): void
  openExternal(url: string): void
}

declare global {
  interface Window {
    hub: HubApi
  }
}
