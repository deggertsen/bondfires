export interface UploadCompletionStatus {
  uploadStatus: string
  assetStatus?: string
  assetId?: string
  playbackId?: string
  isReady: boolean
  isFailed: boolean
}

export function waitForUploadCompletion({
  subscribe,
  startRecovery,
}: {
  subscribe: (
    onStatus: (status: UploadCompletionStatus) => void,
    onError: (error: Error) => void,
  ) => () => void
  startRecovery: () => Promise<unknown>
}): Promise<UploadCompletionStatus> {
  return new Promise((resolve, reject) => {
    let settled = false
    let unsubscribe: (() => void) | undefined
    const timer = setTimeout(
      () =>
        finish(
          new Error('Video is still processing. Completion will be checked when uploads resume.'),
        ),
      15 * 60_000,
    )
    function finish(error?: Error, status?: UploadCompletionStatus) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe?.()
      if (error) reject(error)
      else if (status) resolve(status)
    }
    try {
      unsubscribe = subscribe(
        (status) => {
          if (status.isFailed) finish(new Error('Mux failed to process the uploaded video'))
          else if (status.isReady) finish(undefined, status)
        },
        (error) => finish(error),
      )
      // A cached terminal result may be delivered synchronously on subscription.
      if (settled) unsubscribe()
      else
        void startRecovery().catch((error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        )
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
