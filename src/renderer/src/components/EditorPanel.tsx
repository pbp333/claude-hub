import type { IDockviewPanelProps } from 'dockview-react'
import { useEffect, useRef, useState } from 'react'
import { acquireModel, hasConflict, isDirty, onModelsChanged, releaseModel, reloadModel, saveModel } from '../models'
import { errorMessage } from '../errors'
import { monaco } from '../monaco'
import { fileName, onRevealRequest, openFile } from '../workspace'

interface Params {
  path: string
  line?: number
  column?: number
}

function reveal(editor: monaco.editor.ICodeEditor, line?: number, column?: number): void {
  if (!line) return
  const position = { lineNumber: line, column: column ?? 1 }
  editor.setPosition(position)
  editor.revealPositionInCenter(position)
  editor.focus()
}

export function EditorPanel({ params, api }: IDockviewPanelProps<Params>) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()
  const [conflict, setConflict] = useState(false)

  useEffect(() => {
    let disposed = false
    let editor: monaco.editor.IStandaloneCodeEditor | undefined
    const disposers: (() => void)[] = []
    acquireModel(params.path)
      .then(({ model }) => {
        if (disposed) return releaseModel(params.path)
        editor = monaco.editor.create(ref.current!, {
          model,
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 13,
          scrollBeyondLastLine: false
        })
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveModel(params.path))
        reveal(editor, params.line, params.column)
        const sync = () => {
          const dirty = isDirty(params.path)
          const title = fileName(params.path) + (dirty ? ' ●' : '')
          if (api.title !== title) api.setTitle(title)
          setConflict(hasConflict(params.path))
        }
        sync()
        disposers.push(onModelsChanged(sync))
        disposers.push(onRevealRequest((path, line, column) => path === params.path && editor && reveal(editor, line, column)))
        const active = api.onDidActiveChange(({ isActive }) => isActive && editor?.focus())
        disposers.push(() => active.dispose())
      })
      .catch((err) => setError(errorMessage(err)))
    return () => {
      disposed = true
      for (const d of disposers) d()
      if (editor) {
        editor.dispose()
        releaseModel(params.path)
      }
    }
  }, [params.path, api])

  return (
    <div className="editor-panel">
      {conflict && (
        <div className="editor-banner">
          <span>This file changed on disk and you have unsaved edits.</span>
          <button onClick={() => void reloadModel(params.path, true)}>Reload from disk</button>
          <button onClick={() => void saveModel(params.path)}>Keep mine and save</button>
        </div>
      )}
      <div className="editor-toolbar">
        <span className="editor-path" title={params.path}>
          <bdi>{params.path}</bdi>
        </span>
        <button onClick={() => openFile(params.path, { diff: true })}>Diff vs HEAD</button>
      </div>
      {error ? <div className="panel-error">{error}</div> : <div ref={ref} className="editor-container" />}
    </div>
  )
}

export function DiffPanel({ params }: IDockviewPanelProps<Params>) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let disposed = false
    let diff: monaco.editor.IStandaloneDiffEditor | undefined
    let original: monaco.editor.ITextModel | undefined
    let stopListening: (() => void) | undefined
    Promise.all([acquireModel(params.path), window.hub.headContent(params.path)])
      .then(([{ model }, head]) => {
        if (disposed) return releaseModel(params.path)
        original = monaco.editor.createModel(head, model.getLanguageId())
        diff = monaco.editor.createDiffEditor(ref.current!, {
          automaticLayout: true,
          renderSideBySide: true,
          originalEditable: false,
          minimap: { enabled: false },
          fontSize: 13
        })
        diff.setModel({ original, modified: model })
        diff.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveModel(params.path))
        // HEAD moves when Claude commits; refresh the left side on file changes.
        stopListening = window.hub.onFsChanged(async (paths) => {
          if (paths.includes(params.path) || paths.some((p) => /[\\/]\.git[\\/]/.test(p))) {
            const next = await window.hub.headContent(params.path)
            if (original && !original.isDisposed() && next !== original.getValue()) original.setValue(next)
          }
        })
      })
      .catch((err) => setError(errorMessage(err)))
    return () => {
      disposed = true
      stopListening?.()
      if (diff) {
        diff.dispose()
        original?.dispose()
        releaseModel(params.path)
      }
    }
  }, [params.path])

  return error ? <div className="panel-error">{error}</div> : <div ref={ref} className="editor-container full" />
}
