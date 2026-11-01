import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** JSON files in the app data folder, written atomically (temp file, then rename). */
export class JsonStore {
  private timers = new Map<string, NodeJS.Timeout>()

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

  write(file: string, data: unknown): void {
    const p = this.path(file)
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
    renameSync(tmp, p)
  }

  /** Coalesces frequent writes (session state changes) into one write per file. */
  writeSoon(file: string, getData: () => unknown, delayMs = 500): void {
    clearTimeout(this.timers.get(file))
    this.timers.set(
      file,
      setTimeout(() => {
        this.timers.delete(file)
        this.write(file, getData())
      }, delayMs)
    )
  }

  flush(file: string, getData: () => unknown): void {
    clearTimeout(this.timers.get(file))
    this.timers.delete(file)
    this.write(file, getData())
  }
}
