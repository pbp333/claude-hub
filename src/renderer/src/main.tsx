import { createRoot } from 'react-dom/client'
import 'dockview-react/dist/styles/dockview.css'
import '@xterm/xterm/css/xterm.css'
import './monaco'
import './styles.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
