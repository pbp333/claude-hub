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

/**
 * Why a session wants the user: `input` = blocked on a question, permission or dialog;
 * `unread` = finished with output the user hasn't looked at yet.
 */
export type AttentionKind = 'input' | 'unread'

export function attentionKind(session: Session): AttentionKind | undefined {
  if (session.attentionState === 'needs-you') return 'input'
  if (session.attentionState === 'done' && session.unread) return 'unread'
  return undefined
}

export const ATTENTION_LABEL: Record<AttentionKind, string> = {
  input: 'Waiting for your input',
  unread: 'New output, not read yet'
}

/** Sessions that want the user: blocked on a prompt, or finished and not yet looked at. */
export function needsAttention(session: Session): boolean {
  return attentionKind(session) !== undefined
}

/** Sort rank: waiting for input first, then unread output, then the rest. */
export function attentionRank(session: Session): number {
  const kind = attentionKind(session)
  return kind === 'input' ? 0 : kind === 'unread' ? 1 : 2
}
