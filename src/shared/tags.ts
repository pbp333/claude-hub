import type { Session, Tag } from './types'

/** Tags may be referred to by id or by name. */
export function findTag(tags: Tag[], ref: string): Tag | undefined {
  const lower = ref.toLowerCase()
  return tags.find((t) => t.id === ref) ?? tags.find((t) => t.name.toLowerCase() === lower)
}

/** Manual tags, then rule tags, without duplicates. */
export function effectiveTags(session: Session, tags: Tag[]): { tag: Tag; source: 'manual' | 'auto' }[] {
  const out: { tag: Tag; source: 'manual' | 'auto' }[] = []
  const seen = new Set<string>()
  const add = (tag: Tag | undefined, source: 'manual' | 'auto') => {
    if (tag && !seen.has(tag.id)) {
      seen.add(tag.id)
      out.push({ tag, source })
    }
  }
  for (const id of session.tagIds) add(findTag(tags, id), 'manual')
  for (const id of session.autoTags) add(findTag(tags, id), 'auto')
  return out
}

/** Sessions that want the user: blocked on a prompt, or finished and not yet looked at. */
export function needsAttention(session: Session): boolean {
  return session.attentionState === 'needs-you' || (session.attentionState === 'done' && session.unread)
}
