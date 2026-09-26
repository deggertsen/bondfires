type MyFireAuthor = {
  userId: string
  creatorName?: string
  unread: boolean
  firstUnwatchedResponder?: {
    _id: string
    displayName?: string
    name?: string
  } | null
}

/** Shared by Home and My Fires; unread rows must never name the viewer. */
export function getMyFireRowCreatorName(
  thread: MyFireAuthor,
  currentUserId: string | null,
): string {
  if (!thread.unread) return thread.creatorName ?? 'Anonymous'
  const responder = thread.firstUnwatchedResponder
  if (responder && responder._id !== currentUserId) {
    const name = responder.displayName?.trim() || responder.name?.trim()
    if (name) return name
  }
  return thread.userId === currentUserId ? 'Anonymous' : (thread.creatorName ?? 'Anonymous')
}
