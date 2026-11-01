import { Terminal } from '@xterm/headless'
import * as pty from 'node-pty'

const MAX_BUFFER = 512 * 1024

/**
 * Owns the terminal processes. Keeps recent output per session, across restarts and after
 * the process exits, so a terminal view can replay it whenever it mounts. A headless terminal
 * per session tracks what is actually on screen, since the CLI redraws only what changes.
 */
export class PtyManager {
  private procs = new Map<string, pty.IPty>()
  private buffers = new Map<string, string>()
  private screens = new Map<string, Terminal>()

  constructor(
    private onData: (id: string, data: string) => void,
    private onExit: (id: string, code: number) => void
  ) {}

  /** Throws when the process can't be started. */
  spawn(id: string, file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
    this.stop(id)
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
    })
    this.procs.set(id, proc)
    this.screens.get(id)?.dispose()
    this.screens.set(id, new Terminal({ cols: 120, rows: 32, allowProposedApi: true }))
    proc.onData((data) => this.print(id, data))
    proc.onExit(({ exitCode }) => {
      // A newer process may already own this id (restart).
      if (this.procs.get(id) !== proc) return
      this.procs.delete(id)
      this.onExit(id, exitCode)
    })
  }

  /** Output from the process, or a message from the app, shown in the session's terminal. */
  print(id: string, data: string): void {
    let buffer = (this.buffers.get(id) ?? '') + data
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER)
    this.buffers.set(id, buffer)
    this.screens.get(id)?.write(data)
    this.onData(id, data)
  }

  /** The visible screen as plain text, one line per row. */
  screenText(id: string): string {
    const screen = this.screens.get(id)
    if (!screen) return ''
    const buf = screen.buffer.active
    const lines: string[] = []
    for (let y = 0; y < screen.rows; y++) lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
    return lines.join('\n')
  }

  has(id: string): boolean {
    return this.procs.has(id)
  }

  buffer(id: string): string {
    return this.buffers.get(id) ?? ''
  }

  write(id: string, data: string): void {
    this.procs.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return
    this.procs.get(id)?.resize(cols, rows)
    this.screens.get(id)?.resize(cols, rows)
  }

  /** Stops the process but keeps its output. */
  stop(id: string): void {
    const proc = this.procs.get(id)
    if (!proc) return
    this.procs.delete(id)
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }

  /** Stops the process and forgets its output (session closed). */
  remove(id: string): void {
    this.stop(id)
    this.buffers.delete(id)
    this.screens.get(id)?.dispose()
    this.screens.delete(id)
  }

  killAll(): void {
    for (const id of [...this.procs.keys()]) this.stop(id)
  }
}
