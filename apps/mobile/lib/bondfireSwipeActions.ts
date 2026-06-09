type BondfireSwipeActionsConfig = {
  isOwner: boolean
  isPinned: boolean
  onDelete: () => void
  onPin: () => void
  onUnpin: () => void
  onReport: () => void
}

export type BondfireSwipeAction = {
  key: string
  label: string
  color?: string
  backgroundColor?: string
  onPress: () => void
}

export const BONDFIRE_REPORT_OPTIONS = [
  {
    label: 'Harassment',
    subCategory: 'harassment_or_abuse',
  },
  {
    label: 'Inappropriate',
    subCategory: 'pornographic_content',
  },
  {
    label: 'Spam',
    subCategory: 'spam_or_solicitation',
  },
] as const

export function getBondfireSwipeActions({
  isOwner,
  isPinned,
  onDelete,
  onPin,
  onUnpin,
  onReport,
}: BondfireSwipeActionsConfig): BondfireSwipeAction[] {
  const actions: BondfireSwipeAction[] = [
    isOwner
      ? {
          key: 'delete',
          label: 'Delete',
          color: '$gray12',
          backgroundColor: '$errorDark',
          onPress: onDelete,
        }
      : {
          key: 'report',
          label: 'Report',
          color: '$warning',
          backgroundColor: '$backgroundHover',
          onPress: onReport,
        },
  ]

  actions.push({
    key: 'pin',
    label: isPinned ? 'Unpin' : 'Pin',
    color: '$primary',
    backgroundColor: '$backgroundHover',
    onPress: isPinned ? onUnpin : onPin,
  })

  return actions
}

export function getSwipeReportComment(source: string): string {
  return `Reported from ${source} swipe action`
}
