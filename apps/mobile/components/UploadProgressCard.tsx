import { type UploadTask, uploadQueueStore$ } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Card, Text } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { AlertTriangle, CheckCircle2, CloudUpload } from '@tamagui/lucide-icons'
import { XStack, YStack } from 'tamagui'

const ACTIVE_STATUSES = new Set<UploadTask['status']>(['pending', 'processing', 'uploading'])
const RECENT_COMPLETION_WINDOW_MS = 120000

function getTaskLabel(task: UploadTask): string {
  return task.isResponse ? 'Response upload' : 'Bondfire upload'
}

function getDefaultStage(status: UploadTask['status']): string {
  switch (status) {
    case 'pending':
      return 'Queued...'
    case 'processing':
      return 'Processing video...'
    case 'uploading':
      return 'Uploading...'
    case 'failed':
      return 'Upload failed'
    case 'completed':
      return 'Complete!'
    default:
      return 'Working...'
  }
}

function getProgress(task: UploadTask): number {
  return Math.max(0, Math.min(100, Math.round(task.progress ?? 0)))
}

export function UploadProgressCard() {
  const tasks = useValue(uploadQueueStore$.tasks) ?? []

  const sortedTasks = [...tasks].sort(
    (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
  )

  const activeTasks = sortedTasks.filter((task) => ACTIVE_STATUSES.has(task.status))
  const latestFailedTask = sortedTasks.find((task) => task.status === 'failed')
  const latestCompletedTask = sortedTasks.find(
    (task) =>
      task.status === 'completed' &&
      (task.completedAt ?? task.updatedAt ?? task.createdAt) >
        Date.now() - RECENT_COMPLETION_WINDOW_MS,
  )

  if (activeTasks.length === 0 && !latestFailedTask && !latestCompletedTask) {
    return null
  }

  return (
    <YStack gap={12} marginBottom={24}>
      <XStack alignItems="center" gap={8}>
        <CloudUpload size={18} color={bondfireColors.ash} />
        <Text variant="label" color={bondfireColors.ash} fontSize={13} fontWeight="600">
          UPLOADS
        </Text>
      </XStack>

      <Card>
        <YStack gap={12}>
          {activeTasks.map((task) => {
            const progress = getProgress(task)
            const stage = task.stage || getDefaultStage(task.status)

            return (
              <YStack key={task.id} gap={6}>
                <XStack justifyContent="space-between" alignItems="center">
                  <Text fontWeight="600" fontSize={14}>
                    {getTaskLabel(task)}
                  </Text>
                  <Text fontSize={13} fontWeight="600" color={bondfireColors.bondfireCopper}>
                    {progress}%
                  </Text>
                </XStack>

                <Text fontSize={12} color={bondfireColors.ash}>
                  {stage}
                </Text>

                <YStack
                  height={6}
                  borderRadius={3}
                  backgroundColor={bondfireColors.iron}
                  overflow="hidden"
                >
                  <YStack
                    height={6}
                    borderRadius={3}
                    backgroundColor={
                      task.status === 'uploading'
                        ? bondfireColors.success
                        : bondfireColors.bondfireCopper
                    }
                    width={`${Math.max(progress, 2)}%`}
                  />
                </YStack>

                {task.attemptCount > 0 && (
                  <Text fontSize={11} color={bondfireColors.ash}>
                    Retrying attempt {task.attemptCount + 1} of 5
                  </Text>
                )}
              </YStack>
            )
          })}

          {activeTasks.length === 0 && latestCompletedTask && (
            <XStack alignItems="center" gap={8}>
              <CheckCircle2 size={16} color={bondfireColors.success} />
              <Text fontSize={13} color={bondfireColors.ash}>
                Latest upload completed successfully.
              </Text>
            </XStack>
          )}

          {latestFailedTask && (
            <XStack alignItems="center" gap={8}>
              <AlertTriangle size={16} color={bondfireColors.error} />
              <YStack flex={1}>
                <Text fontSize={13} fontWeight="600" color={bondfireColors.error}>
                  Upload failed
                </Text>
                <Text fontSize={12} color={bondfireColors.ash}>
                  {latestFailedTask.errorMessage || 'Please try recording and uploading again.'}
                </Text>
              </YStack>
            </XStack>
          )}
        </YStack>
      </Card>
    </YStack>
  )
}
