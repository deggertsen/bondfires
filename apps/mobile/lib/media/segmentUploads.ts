import type { ConvexReactClient } from 'convex/react'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import * as FileSystem from 'expo-file-system/legacy'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'

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

export const segmentMediaEnabled =
  process.env.EXPO_PUBLIC_SEGMENT_MEDIA === '1' &&
  process.env.EXPO_PUBLIC_APP_ENV === 'internal' &&
  process.env.EXPO_PUBLIC_CONVEX_URL === 'https://lovely-malamute-525.convex.cloud'
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
  uploadOwner = userId
}
let lastError: string | null = null
export function segmentUploadError() {
  return lastError
}
async function save(job: Job) {
  await FileSystem.makeDirectoryAsync(root, { intermediates: true })
  const path = `${root}${job.args.localId}.json`
  await FileSystem.writeAsStringAsync(`${path}.tmp`, JSON.stringify(job))
  await FileSystem.moveAsync({ from: `${path}.tmp`, to: path })
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
  try {
    if (!(await FileSystem.getInfoAsync(root)).exists) return
    const names = new Set(
      (await FileSystem.readDirectoryAsync(root)).map((name) => name.replace(/\.tmp$/, '')),
    )
    let failure: string | null = null
    const ordered = [...names].sort(
      (a, b) => Number(active.has(b.slice(0, 36))) - Number(active.has(a.slice(0, 36))),
    )
    for (const name of ordered) {
      try {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
        // Expo iOS removes the destination before renaming. If killed between
        // those operations, the completed temporary journal is the recovery copy.
        const committed = await FileSystem.getInfoAsync(`${root}${name}`)
        const job: Job = JSON.parse(
          await FileSystem.readAsStringAsync(`${root}${name}${committed.exists ? '' : '.tmp'}`),
        )
        if (uploadOwner !== userId) return
        if (job.userId !== userId) continue
        const dir = segmentDirectory(job.args.localId)
        if (!(await FileSystem.getInfoAsync(`${dir}init.mp4`)).exists) continue
        if (!job.recordingId) {
          const created = await client.begin(job.args)
          job.recordingId = created.recordingId
          job.recordId = created.recordId
          await save(job)
        }
        let grant = await client.capability({
          recordingId: job.recordingId,
          operation: 'upload',
        })
        // Sequential immutable uploads make every published playlist a contiguous prefix.
        let uploadedThisPass = 0
        while (uploadOwner === userId && uploadedThisPass < 4) {
          const filename =
            job.nextIndex === -1
              ? 'init.mp4'
              : `segment-${String(job.nextIndex).padStart(6, '0')}.m4s`
          const info = await FileSystem.getInfoAsync(`${dir}${filename}`)
          if (!info.exists) break
          if (grant.expiresAt < Date.now() + 60_000)
            grant = await client.capability({
              recordingId: job.recordingId,
              operation: 'upload',
            })
          const result = await FileSystem.uploadAsync(
            `${grant.baseUrl}/${filename}`,
            `${dir}${filename}`,
            {
              httpMethod: 'PUT',
              uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
              headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'video/mp4' },
              sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
            },
          )
          if (result.status !== 204)
            throw new Error(`Video upload paused (${result.status}); it will retry automatically.`)
          uploadedThisPass += 1
          job.nextIndex += 1
          await save(job)
        }
        if (uploadOwner !== userId) return
        const marker = await FileSystem.getInfoAsync(`${dir}finished.json`)
        let finalCount: number | undefined
        if (marker.exists)
          finalCount = JSON.parse(await FileSystem.readAsStringAsync(marker.uri)).segmentCount
        else if (
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
        if (finalCount && job.nextIndex === finalCount) {
          const result = await client.finish({
            recordingId: job.recordingId,
            segmentCount: finalCount,
          })
          if (result.complete) {
            await FileSystem.deleteAsync(`${root}${name}`, { idempotent: true })
            await FileSystem.deleteAsync(`${root}${name}.tmp`, { idempotent: true })
            await FileSystem.deleteAsync(dir, { idempotent: true })
          }
        }
      } catch (error) {
        failure =
          error instanceof Error
            ? error.message
            : 'Video upload paused; it will retry automatically.'
      }
    }
    lastError = failure
  } catch (error) {
    lastError =
      error instanceof Error ? error.message : 'Video upload paused; it will retry automatically.'
  } finally {
    running = false
  }
}
