import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

// Bundled locally: no CDN, works offline and under the page's CSP.
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  }
}

monaco.editor.setTheme('vs-dark')

// Monaco can't see the project's node_modules or tsconfig, so type errors would be noise.
// Keep syntax errors only.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults])
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })

export { monaco }
