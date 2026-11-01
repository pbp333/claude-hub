export interface PathMatch {
  /** Text as printed, including any :line:col suffix. */
  text: string
  path: string
  line?: number
  column?: number
  /** 0-based start index in the line. */
  index: number
}

// A path with a dot-extension containing a letter (so "v2.1.3" is not a file), optionally absolute (/, ~/, C:\) or relative (./, ../),
// followed by an optional :line or :line:col.
const PATH_RE = /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w@.+\-]+[\\/])*[\w@+\-][\w@.+\-]*\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,12}(?::(\d+)(?::(\d+))?)?/g

/** Finds things in a terminal line that look like file paths. The main process then keeps only files that exist. */
export function findPathCandidates(line: string): PathMatch[] {
  const out: PathMatch[] = []
  for (const m of line.matchAll(PATH_RE)) {
    const index = m.index ?? 0
    const before = line.slice(Math.max(0, index - 3), index)
    // Skip pieces of URLs (https://host/x.js) and of longer words.
    if (/:\/{0,2}$/.test(before) || /[\w/]$/.test(before)) continue
    const text = m[0]
    const suffix = text.match(/(?::\d+){1,2}$/)?.[0] ?? ''
    const path = text.slice(0, text.length - suffix.length)
    // Version numbers and plain numbers ("1.2.3", "0.5") are not files.
    if (/^[\d.]+$/.test(path)) continue
    out.push({
      text,
      path,
      line: m[1] ? Number(m[1]) : undefined,
      column: m[2] ? Number(m[2]) : undefined,
      index
    })
  }
  return out
}
