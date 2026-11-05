import { createRoot } from 'react-dom/client'
import 'dockview-react/dist/styles/dockview.css'
import '@xterm/xterm/css/xterm.css'
import './monaco'
import './styles.css'
import { App } from './App'

// Dropping a file anywhere the UI doesn't handle it would make the window navigate to it.
for (const type of ['dragover', 'drop'] as const)
  window.addEventListener(type, (e) => e.preventDefault())

createRoot(document.getElementById('root')!).render(<App />)
