import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { HubApi } from './api'

function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: HubApi = {
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => listen('state', cb),
  onCommand: (cb) => listen('command', cb),
  windowInfo: () => ipcRenderer.invoke('window-info'),
  onWindowInfo: (cb) => listen('window-info', cb),
  openFolder: () => ipcRenderer.send('open-folder'),
  openRecent: (folder) => ipcRenderer.send('open-recent', folder),
  newWindow: () => ipcRenderer.send('new-window'),
  createSession: (opts) => ipcRenderer.invoke('create-session', opts),
  restartSession: (id) => ipcRenderer.send('restart-session', id),
  closeSession: (id) => ipcRenderer.send('close-session', id),
  renameSession: (id, name) => ipcRenderer.send('rename-session', id, name),
  sessionMenu: (id) => ipcRenderer.send('session-menu', id),
  setActiveSession: (id) => ipcRenderer.send('set-active-session', id),
  toggleTag: (id, tagId) => ipcRenderer.send('toggle-tag', id, tagId),
  nextStep: (id) => ipcRenderer.send('next-step', id),
  setStep: (id, stepId) => ipcRenderer.send('set-step', id, stepId),
  ptyWrite: (id, data) => ipcRenderer.send('pty-write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty-resize', id, cols, rows),
  ptyBuffer: (id) => ipcRenderer.invoke('pty-buffer', id),
  onPtyData: (cb) => listen('pty-data', cb),
  listDir: (dir) => ipcRenderer.invoke('list-dir', dir),
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  writeFile: (path, content) => ipcRenderer.invoke('write-file', path, content),
  headContent: (path) => ipcRenderer.invoke('head-content', path),
  gitStatus: (cwd) => ipcRenderer.invoke('git-status', cwd),
  listFiles: (cwd) => ipcRenderer.invoke('list-files', cwd),
  resolveLinks: (cwd, candidates) => ipcRenderer.invoke('resolve-links', cwd, candidates),
  onFsChanged: (cb) => listen('fs-changed', cb),
  configPath: (file) => ipcRenderer.invoke('config-path', file),
  loadLayout: (projectId) => ipcRenderer.invoke('load-layout', projectId),
  saveLayout: (projectId, layout) => ipcRenderer.send('save-layout', projectId, layout),
  openExternal: (url) => ipcRenderer.send('open-external', url)
}

contextBridge.exposeInMainWorld('hub', api)
