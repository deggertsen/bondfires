import { Button, Card, Spinner, Text } from '@bondfires/ui'
import { ShieldCheck } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { Alert } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { routes } from '../lib/routes'

const ADMIN_NOTE = 'Reviewed by an administrator in the mobile moderation queue.'

async function runAdminAction(action: Promise<unknown>) {
  try {
    await action
  } catch (error) {
    Alert.alert('Moderation action failed', error instanceof Error ? error.message : 'Try again.')
  }
}

export function ModerationAdminPanel() {
  const router = useRouter()
  const queue = useQuery(api.moderation.getQueue, { limit: 50 })
  const reviewReport = useMutation(api.moderation.reviewReport)
  const moderateContent = useMutation(api.moderation.moderateContent)
  const setUserStatus = useMutation(api.moderation.setUserStatus)

  if (!queue) {
    return (
      <Card marginBottom={24}>
        <Spinner size="small" />
      </Card>
    )
  }

  return (
    <Card marginBottom={24}>
      <YStack gap={14}>
        <XStack gap={8} alignItems="center">
          <ShieldCheck size={18} color={'$secondary'} />
          <Text fontSize={16} fontWeight="700">
            Safety moderation
          </Text>
        </XStack>
        <Text fontSize={12} color={'$placeholderColor'}>
          {queue.content.length} awaiting publication · {queue.reports.length} open reports
        </Text>

        {queue.content.map((item) => (
          <Card key={`${item.targetType}:${item.targetId}`} variant="outline">
            <YStack gap={8}>
              <Text fontWeight="700">
                {('title' in item ? item.title : undefined) ||
                  `${item.creatorName ?? 'User'}’s video`}
              </Text>
              <Text fontSize={12} color={'$placeholderColor'}>
                Public {item.targetType} awaiting human review
              </Text>
              <XStack gap={8}>
                <Button
                  size="$sm"
                  variant="outline"
                  accessibilityLabel="Review content playback"
                  onPress={() =>
                    router.push(
                      routes.bondfire(
                        item.bondfireId,
                        item.targetType === 'response' ? item.targetId : undefined,
                      ),
                    )
                  }
                >
                  <Text>Review</Text>
                </Button>
                <Button
                  size="$sm"
                  variant="primary"
                  accessibilityLabel="Approve content for publication"
                  onPress={() =>
                    void runAdminAction(
                      moderateContent({
                        targetType: item.targetType,
                        targetId: item.targetId,
                        action: 'approve',
                      }),
                    )
                  }
                >
                  <Text>Approve</Text>
                </Button>
                <Button
                  size="$sm"
                  variant="destructive"
                  accessibilityLabel="Remove content"
                  onPress={() =>
                    Alert.alert('Remove content?', 'The creator will retain access for appeals.', [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Remove',
                        style: 'destructive',
                        onPress: () =>
                          void runAdminAction(
                            moderateContent({
                              targetType: item.targetType,
                              targetId: item.targetId,
                              action: 'remove',
                              reason: ADMIN_NOTE,
                            }),
                          ),
                      },
                    ])
                  }
                >
                  <Text>Remove</Text>
                </Button>
              </XStack>
            </YStack>
          </Card>
        ))}

        {queue.reports.map((report) => (
          <Card key={report._id} variant="outline">
            <YStack gap={8}>
              <Text fontWeight="700">
                {report.subCategory?.replaceAll('_', ' ') ?? report.category.replaceAll('_', ' ')}
              </Text>
              <Text fontSize={12} color={'$placeholderColor'}>
                {report.reporterName} reported {report.targetName}
              </Text>
              <Text fontSize={13}>{report.comments}</Text>
              <XStack gap={8} flexWrap="wrap">
                {report.reviewBondfireId ? (
                  <Button
                    size="$sm"
                    variant="outline"
                    accessibilityLabel="Review reported content playback"
                    onPress={() => {
                      const bondfireId = report.reviewBondfireId
                      if (bondfireId) {
                        router.push(routes.bondfire(bondfireId, report.bondfireVideoId))
                      }
                    }}
                  >
                    <Text>Review content</Text>
                  </Button>
                ) : null}
                <Button
                  size="$sm"
                  variant="outline"
                  accessibilityLabel="Dismiss report"
                  onPress={() =>
                    void runAdminAction(
                      reviewReport({
                        reportId: report._id as Id<'reports'>,
                        decision: 'dismiss',
                        note: ADMIN_NOTE,
                      }),
                    )
                  }
                >
                  <Text>Dismiss</Text>
                </Button>
                <Button
                  size="$sm"
                  variant="destructive"
                  accessibilityLabel="Resolve report and enforce"
                  onPress={() =>
                    Alert.alert('Resolve and enforce?', 'Remove content and suspend its owner?', [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Resolve',
                        style: 'destructive',
                        onPress: () =>
                          void runAdminAction(
                            reviewReport({
                              reportId: report._id as Id<'reports'>,
                              decision: 'resolve',
                              note: ADMIN_NOTE,
                              removeContent: !!(report.bondfireId || report.bondfireVideoId),
                              suspendUser: true,
                            }),
                          ),
                      },
                    ])
                  }
                >
                  <Text>Resolve + enforce</Text>
                </Button>
              </XStack>
            </YStack>
          </Card>
        ))}

        {queue.removedContent.map((item) => (
          <XStack key={`removed:${item.targetType}:${item.targetId}`} gap={8} alignItems="center">
            <Text flex={1} fontSize={13}>
              Removed: {('title' in item ? item.title : undefined) || item.creatorName || 'Video'}
            </Text>
            <Button
              size="$sm"
              variant="outline"
              accessibilityLabel="Restore removed content"
              onPress={() =>
                void runAdminAction(
                  moderateContent({
                    targetType: item.targetType,
                    targetId: item.targetId,
                    action: 'restore',
                    reason: ADMIN_NOTE,
                  }),
                )
              }
            >
              <Text>Restore</Text>
            </Button>
          </XStack>
        ))}

        {queue.suspendedUsers.map((user) => (
          <XStack key={`suspended:${user.userId}`} gap={8} alignItems="center">
            <YStack flex={1}>
              <Text fontSize={13}>{user.displayName}</Text>
              <Text fontSize={11} color={'$placeholderColor'} numberOfLines={1}>
                {user.reason || 'Suspended'}
              </Text>
            </YStack>
            <Button
              size="$sm"
              variant="outline"
              accessibilityLabel={`Reactivate ${user.displayName}`}
              onPress={() =>
                void runAdminAction(
                  setUserStatus({ userId: user.userId, status: 'active', reason: ADMIN_NOTE }),
                )
              }
            >
              <Text>Reactivate</Text>
            </Button>
          </XStack>
        ))}

        {queue.content.length === 0 &&
        queue.reports.length === 0 &&
        queue.removedContent.length === 0 &&
        queue.suspendedUsers.length === 0 ? (
          <Text color={'$placeholderColor'}>Moderation queue is clear.</Text>
        ) : null}
      </YStack>
    </Card>
  )
}
