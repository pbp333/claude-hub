import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** JSON files in the app data folder, written atomically (temp file, then rename). */
export class JsonStore {
  private timers = new Map<string, NodeJS.Timeout>()
  private pending = new Map<string, () => unknown>()

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  path(file: string): string {
    return join(this.dir, file)
  }

  exists(file: string): boolean {
    return existsSync(this.path(file))
  }

  /** Returns `fallback` when the file is missing; throws with a readable message when it is invalid JSON. */
  read<T>(file: string, fallback: T): T {
    const p = this.path(file)
    if (!existsSync(p)) return fallback
    const text = readFileSync(p, 'utf8')
    try {
      return JSON.parse(text) as T
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message}`)
    }
  }

  /**
   * For app state (sessions, windows, layouts): a damaged file is moved aside as
   * `<file>.corrupt` and the app starts from `fallback` instead of failing to launch.
   */
  readState<T>(file: string, fallback: T, isValid: (value: unknown) => boolean = () => true): T {
    try {
      const value = this.read<unknown>(file, fallback)
      if (isValid(value)) return value as T
    } catch {
      // fall through to quarantine
    }
    try {
      renameSync(this.path(file), this.path(`${file}.corrupt`))
    } catch {
      // nothing to move
    }
    return fallback
  }

  write(file: string, data: unknown): void {
    const p = this.path(file)
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
    renameSync(tmp, p)
  }

  /** Coalesces frequent writes (session state changes) into one write per file. */
  writeSoon(file: string, getData: () => unknown, delayMs = 500): void {
    clearTimeout(this.timers.get(file))
    this.pending.set(file, getData)
    this.timers.set(
      file,
      setTimeout(() => {
        this.timers.delete(file)
        this.pending.delete(file)
        this.write(file, getData())
      }, delayMs)
    )
  }

  flush(file: string, getData: () => unknown): void {
    clearTimeout(this.timers.get(file))
    this.timers.delete(file)
    this.pending.delete(file)
    this.write(file, getData())
  }

  /** Writes everything still waiting in writeSoon (on quit). */
  flushAll(): void {
    for (const [file, getData] of [...this.pending]) this.flush(file, getData)
  }
}
