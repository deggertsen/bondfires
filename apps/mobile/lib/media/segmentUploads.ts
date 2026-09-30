import type { ConvexReactClient } from 'convex/react'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import * as FileSystem from 'expo-file-system/legacy'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { telemetry } from '../../../../packages/app/src/services/telemetry'
import { mediaClientEnabled } from '../../../../packages/media/src/environment'

export type SegmentUploadClient = {
  begin: (
    args: FunctionArgs<typeof api.segmentMedia.begin>,
  ) => Promise<FunctionReturnType<typeof api.segmentMedia.begin>>
  capability: (
    args: FunctionArgs<typeof api.segmentMedia.capability>,
  ) => Promise<FunctionReturnType<typeof api.segmentMedia.capability>>
  finish: (
    args: FunctionArgs<typeof api.segmentMedia.finish>,
  ) => Promise<FunctionReturnType<typeof api.segmentMedia.finish>>
}
export function segmentUploadClient(client: ConvexReactClient): SegmentUploadClient {
  return {
    begin: (args) => client.mutation(api.segmentMedia.begin, args),
    capability: (args) => client.action(api.segmentMedia.capability, args),
    finish: (args) => client.mutation(api.segmentMedia.finish, args),
  }
}

export const segmentMediaEnabled = mediaClientEnabled(
  process.env.EXPO_PUBLIC_APP_ENV,
  process.env.EXPO_PUBLIC_CONVEX_URL,
  process.env.EXPO_PUBLIC_SEGMENT_MEDIA,
)
const root = `${FileSystem.documentDirectory}segment-uploads/`
export const segmentDirectory = (localId: string) =>
  `${FileSystem.documentDirectory}segments/${localId}/`
type Job = {
  userId: string
  args: FunctionArgs<typeof api.segmentMedia.begin>
  recordingId?: Id<'segmentRecordings'>
  recordId?: string
  nextIndex: number
  createdAt: number
}
const active = new Set<string>()
let running = false
let uploadOwner: string | null = null
export function setSegmentUploadOwner(userId: string | null) {
  if (userId !== uploadOwner) clearSnapshot()
  uploadOwner = userId
}

/** What the upload status banner needs to know about one finished-capture job. */
export type SegmentUploadJob = {
  localId: string
  isResponse: boolean
  /** Parent bondfire for responses, the spark's own row otherwise. */
  bondfireId?: string
  /** A pass failed; stays true until a later pass makes progress. */
  paused: boolean
}
export type SegmentUploadObserver = {
  onJobs: (jobs: SegmentUploadJob[]) => void
  onComplete: (job: SegmentUploadJob) => void
}
let observer: SegmentUploadObserver | null = null
const snapshot = new Map<string, SegmentUploadJob>()
export function setSegmentUploadObserver(next: SegmentUploadObserver | null) {
  observer = next
  next?.onJobs([...snapshot.values()])
}
function publish() {
  observer?.onJobs([...snapshot.values()])
}
function clearSnapshot() {
  if (snapshot.size === 0) return
  snapshot.clear()
  publish()
}
function reportJob(job: Job, paused?: boolean) {
  // The capture still recording is the create screen's concern, not the banner's.
  if (active.has(job.args.localId)) return
  const previous = snapshot.get(job.args.localId)
  const next: SegmentUploadJob = {
    localId: job.args.localId,
    isResponse: job.args.isResponse,
    bondfireId: job.args.isResponse ? job.args.bondfireId : job.recordId,
    // Keep a paused job paused until it makes progress, so the banner doesn't
    // flicker to "uploading" at the start of every retry pass.
    paused: paused ?? previous?.paused ?? false,
  }
  if (
    previous &&
    previous.paused === next.paused &&
    previous.bondfireId === next.bondfireId &&
    previous.isResponse === next.isResponse
  )
    return
  snapshot.set(next.localId, next)
  publish()
}
const failures = new Map<string, { message: string; reportedAt: number }>()
export function segmentUploadError(localId: string) {
  return failures.get(localId)?.message ?? null
}
class UploadFailure extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super('Video upload paused; it will retry automatically.')
  }
}
/** Convex mutations and immutable PUTs are idempotent, including after a lost acknowledgement. */
async function bounded<T>(operation: Promise<T>, ms = 30_000, cancel?: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new UploadFailure('timeout'))
          // A stuck native cancellation must not hold the queue either.
          if (cancel)
            void Promise.resolve()
              .then(cancel)
              .catch(() => {})
        }, ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function save(job: Job) {
  await FileSystem.makeDirectoryAsync(root, { intermediates: true })
  const path = `${root}${job.args.localId}.json`
  await FileSystem.writeAsStringAsync(`${path}.tmp`, JSON.stringify(job))
  await FileSystem.moveAsync({ from: `${path}.tmp`, to: path })
}
async function readFinalCount(dir: string): Promise<number | undefined> {
  const marker = await FileSystem.getInfoAsync(`${dir}finished.json`)
  if (!marker.exists) return undefined
  const count = JSON.parse(await FileSystem.readAsStringAsync(marker.uri)).segmentCount
  if (!Number.isSafeInteger(count) || count < 1) throw new UploadFailure('invalid_finish_marker')
  return count
}
/** An empty preview journal is resumable; actual local media must upload, never be overwritten. */
export async function hasSavedDraftCapture(userId: string, draftBondfireId: string) {
  if (!(await FileSystem.getInfoAsync(root)).exists) return false
  const names = new Set(
    (await FileSystem.readDirectoryAsync(root)).map((name) => name.replace(/\.tmp$/, '')),
  )
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
    const committed = await FileSystem.getInfoAsync(`${root}${name}`)
    const job: Job = JSON.parse(
      await FileSystem.readAsStringAsync(`${root}${name}${committed.exists ? '' : '.tmp'}`),
    )
    if (job.userId !== userId || job.args.draftBondfireId !== draftBondfireId) continue
    if (active.has(job.args.localId)) return true
    const dir = segmentDirectory(job.args.localId)
    if ((await FileSystem.getInfoAsync(`${dir}segment-000000.m4s`)).exists) return true
  }
  return false
}

export async function prepareSegmentJob(userId: string, args: Job['args']) {
  await save({ userId, args, nextIndex: -1, createdAt: Date.now() })
}
export function markSegmentCapture(localId: string, recording: boolean) {
  if (recording) active.add(localId)
  else active.delete(localId)
}
export async function runSegmentUploads(client: SegmentUploadClient, userId: string) {
  if (!segmentMediaEnabled || running) return
  running = true
  // Jobs this pass found with durable media; anything else leaves the banner.
  const seen = new Set<string>()
  let scanComplete = false
  try {
    if (!(await FileSystem.getInfoAsync(root)).exists) {
      scanComplete = true
      return
    }
    const names = new Set(
      (await FileSystem.readDirectoryAsync(root)).map((name) => name.replace(/\.tmp$/, '')),
    )
    const ordered = [...names].sort(
      (a, b) => Number(active.has(b.slice(0, 36))) - Number(active.has(a.slice(0, 36))),
    )
    for (const name of ordered) {
      let job: Job | undefined
      let stage = 'journal'
      try {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
        // Expo iOS removes the destination before renaming. If killed between
        // those operations, the completed temporary journal is the recovery copy.
        const committed = await FileSystem.getInfoAsync(`${root}${name}`)
        job = JSON.parse(
          await FileSystem.readAsStringAsync(`${root}${name}${committed.exists ? '' : '.tmp'}`),
        )
        if (!job) continue
        if (uploadOwner !== userId) return
        if (job.userId !== userId) continue
        const dir = segmentDirectory(job.args.localId)
        if (!(await FileSystem.getInfoAsync(`${dir}init.mp4`)).exists) continue
        // An init alone contains no video. Don't consume a shared draft until
        // an actual fragment is durable; failed empty captures can be retried.
        if (!(await FileSystem.getInfoAsync(`${dir}segment-000000.m4s`)).exists) continue
        seen.add(job.args.localId)
        reportJob(job)
        if (!job.recordingId) {
          stage = 'begin'
          const created = await bounded(client.begin(job.args))
          job.recordingId = created.recordingId
          job.recordId = created.recordId
          await save(job)
          reportJob(job)
        }
        stage = 'finish'
        const initialFinalCount = await readFinalCount(dir)
        let finalCount = initialFinalCount
        if (finalCount !== undefined) {
          // Tell the server capture ended even if the tail is still uploading.
          // Never remove local files until every PUT and finalization is acknowledged.
          stage = 'finish'
          await bounded(client.finish({ recordingId: job.recordingId, segmentCount: finalCount }))
        }
        stage = 'capability'
        let grant = await bounded(
          client.capability({
            recordingId: job.recordingId,
            operation: 'upload',
          }),
        )
        // Sequential immutable uploads make every published playlist a contiguous prefix.
        let uploadedThisPass = 0
        while (uploadOwner === userId && uploadedThisPass < 4) {
          const filename =
            job.nextIndex === -1
              ? 'init.mp4'
              : `segment-${String(job.nextIndex).padStart(6, '0')}.m4s`
          const info = await FileSystem.getInfoAsync(`${dir}${filename}`)
          if (!info.exists) break
          if (grant.expiresAt < Date.now() + 60_000) {
            stage = 'capability'
            grant = await bounded(
              client.capability({
                recordingId: job.recordingId,
                operation: 'upload',
              }),
            )
          }
          if (uploadOwner !== userId) return
          stage = 'upload'
          const task = FileSystem.createUploadTask(
            `${grant.baseUrl}/${filename}`,
            `${dir}${filename}`,
            {
              httpMethod: 'PUT',
              uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
              headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'video/mp4' },
              sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
            },
          )
          const result = await bounded(task.uploadAsync(), 120_000, () => task.cancelAsync())
          if (result?.status !== 204) throw new UploadFailure('http', result?.status)
          uploadedThisPass += 1
          job.nextIndex += 1
          await save(job)
          reportJob(job, false)
        }
        if (uploadOwner !== userId) return
        // Capture may have stopped while a PUT was in flight. Its request to
        // run the queue is skipped while `running` is true, so observe the
        // durable marker again before yielding to the next timer tick (which
        // may never run if the app is backgrounded after Stop).
        stage = 'finish'
        finalCount ??= await readFinalCount(dir)
        if (
          finalCount === undefined &&
          !active.has(job.args.localId) &&
          job.nextIndex > 0 &&
          !(
            await FileSystem.getInfoAsync(
              `${dir}segment-${String(job.nextIndex).padStart(6, '0')}.m4s`,
            )
          ).exists
        ) {
          // After process death, only atomically committed fragments are recoverable.
          finalCount = job.nextIndex
        }
        if (finalCount && (job.nextIndex === finalCount || initialFinalCount === undefined)) {
          stage = 'finish'
          const result = await bounded(
            client.finish({
              recordingId: job.recordingId,
              segmentCount: finalCount,
            }),
          )
          if (result.complete && job.nextIndex === finalCount) {
            telemetry.info('segment:upload:complete', 'Video upload completed', {
              localId: job.args.localId,
              recordingId: job.recordingId,
              segmentCount: finalCount,
            })
            await FileSystem.deleteAsync(`${root}${name}`, { idempotent: true })
            await FileSystem.deleteAsync(`${root}${name}.tmp`, { idempotent: true })
            await FileSystem.deleteAsync(dir, { idempotent: true })
            const reported = snapshot.get(job.args.localId)
            if (reported) {
              snapshot.delete(job.args.localId)
              publish()
              observer?.onComplete({ ...reported, paused: false })
            }
            seen.delete(job.args.localId)
            failures.delete(job.args.localId)
            continue
          }
        }
        failures.delete(job.args.localId)
        reportJob(job, false)
      } catch (error) {
        if (uploadOwner !== userId) return
        if (job && seen.has(job.args.localId)) reportJob(job, true)
        const localId = job?.args.localId ?? name.slice(0, 36)
        const previous = failures.get(localId)
        const now = Date.now()
        if (!previous || now - previous.reportedAt >= 60_000) {
          // Native/network errors may contain signed URLs. Log only controlled
          // codes and identifiers, never the raw exception, token or response body.
          telemetry.warn('segment:upload:paused', 'Video upload will retry', {
            localId,
            recordingId: job?.recordingId,
            stage,
            nextIndex: job?.nextIndex,
            code: error instanceof UploadFailure ? error.code : 'operation_failed',
            status: error instanceof UploadFailure ? error.status : undefined,
          })
          failures.set(localId, {
            message: 'Video upload paused; it will retry automatically.',
            reportedAt: now,
          })
        }
      }
    }
    scanComplete = true
  } catch {
    telemetry.warn('segment:queue:failed', 'Could not read the video upload queue')
  } finally {
    running = false
    if (scanComplete) {
      let pruned = false
      for (const localId of snapshot.keys()) {
        if (seen.has(localId)) continue
        snapshot.delete(localId)
        pruned = true
      }
      if (pruned) publish()
    }
  }
}
