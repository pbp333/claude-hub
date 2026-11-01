import { monaco } from './monaco'

interface ModelEntry {
  model: monaco.editor.ITextModel
  savedVersion: number
  /** Panels using this model; disposed when the last one closes. */
  refs: number
  /** Content on disk differs from a model with unsaved edits. */
  conflict: boolean
}

const models = new Map<string, ModelEntry>()
const changeListeners = new Set<() => void>()

export function onModelsChanged(cb: () => void): () => void {
  changeListeners.add(cb)
  return () => changeListeners.delete(cb)
}

function emit(): void {
  for (const cb of changeListeners) cb()
}

export async function acquireModel(path: string): Promise<ModelEntry> {
  const existing = models.get(path)
  if (existing) {
    existing.refs++
    return existing
  }
  const content = await window.hub.readFile(path)
  // Another panel may have created it while we were reading.
  const raced = models.get(path)
  if (raced) {
    raced.refs++
    return raced
  }
  const model = monaco.editor.createModel(content, undefined, monaco.Uri.file(path))
  const entry: ModelEntry = { model, savedVersion: model.getAlternativeVersionId(), refs: 1, conflict: false }
  model.onDidChangeContent(() => emit())
  models.set(path, entry)
  return entry
}

export function releaseModel(path: string): void {
  const entry = models.get(path)
  if (!entry || --entry.refs > 0) return
  entry.model.dispose()
  models.delete(path)
}

export function isDirty(path: string): boolean {
  const entry = models.get(path)
  return !!entry && entry.model.getAlternativeVersionId() !== entry.savedVersion
}

export function hasConflict(path: string): boolean {
  return !!models.get(path)?.conflict
}

export async function saveModel(path: string): Promise<void> {
  const entry = models.get(path)
  if (!entry) return
  await window.hub.writeFile(path, entry.model.getValue())
  entry.savedVersion = entry.model.getAlternativeVersionId()
  entry.conflict = false
  emit()
}

/** Reloads from disk. Unsaved edits are kept and flagged as a conflict unless `force`. */
export async function reloadModel(path: string, force = false): Promise<void> {
  const entry = models.get(path)
  if (!entry) return
  let content: string
  try {
    content = await window.hub.readFile(path)
  } catch {
    return // deleted or unreadable: keep what is open
  }
  if (content === entry.model.getValue()) {
    entry.savedVersion = entry.model.getAlternativeVersionId()
    entry.conflict = false
    emit()
    return
  }
  if (isDirty(path) && !force) {
    entry.conflict = true
    emit()
    return
  }
  // pushEditOperations keeps undo history, so a reload from Claude's edit can be undone.
  entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text: content }], () => null)
  entry.savedVersion = entry.model.getAlternativeVersionId()
  entry.conflict = false
  emit()
}

window.hub.onFsChanged((paths) => {
  for (const p of paths) if (models.has(p)) void reloadModel(p)
})
