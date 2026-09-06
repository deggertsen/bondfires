import { useConvex } from 'convex/react'
import { useCallback } from 'react'
import { api } from '../../../../convex/_generated/api'
import { waitForUploadCompletion } from '../utils/waitForUploadCompletion'

/** One status subscription per active upload; recovery keeps running on the server. */
export function useUploadCompletion() {
  const convex = useConvex()
  return useCallback(
    ({ uploadId }: { uploadId: string }) =>
      waitForUploadCompletion({
        subscribe: (onStatus, onError) => {
          const watch = convex.watchQuery(api.videos.getUploadCompletion, { uploadId })
          const update = () => {
            try {
              const status = watch.localQueryResult()
              if (status !== undefined) onStatus(status)
            } catch (error) {
              onError(error instanceof Error ? error : new Error(String(error)))
            }
          }
          const unsubscribe = watch.onUpdate(update)
          update()
          return unsubscribe
        },
        startRecovery: () => convex.mutation(api.videos.monitorUploadCompletion, { uploadId }),
      }),
    [convex],
  )
}
