import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Id } from '../../../convex/_generated/dataModel'
import type { SegmentUploadClient } from '../lib/media/segmentUploads'

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failSegment: false,
  hangSegment: false,
  cancel: vi.fn(async () => {}),
  warn: vi.fn(),
  uploaded: [] as string[],
  onUpload: async (_path: string) => {},
}))
vi.mock('../../../packages/app/src/services/telemetry', () => ({
  telemetry: { warn: state.warn, info: vi.fn() },
}))
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  FileSystemSessionType: { FOREGROUND: 0 },
  makeDirectoryAsync: vi.fn(async (path: string) => {
    state.files.set(path, 'directory')
  }),
  writeAsStringAsync: vi.fn(async (path: string, value: string) => {
    state.files.set(path, value)
  }),
  moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
    const value = state.files.get(from)
    if (value === undefined) throw new Error('Missing file')
    state.files.set(to, value)
    state.files.delete(from)
  }),
  getInfoAsync: vi.fn(async (path: string) => ({ exists: state.files.has(path), uri: path })),
  readDirectoryAsync: vi.fn(async (path: string) =>
    [...state.files.keys()]
      .filter((k) => k.startsWith(path) && k !== path)
      .map((k) => k.slice(path.length))
      .filter((k) => !k.includes('/')),
  ),
  readAsStringAsync: vi.fn(async (path: string) => {
    const text = state.files.get(path)
    if (text === undefined) throw new Error('Missing file')
    return text
  }),
  deleteAsync: vi.fn(async (path: string) => {
    for (const key of state.files.keys())
      if (key === path || key.startsWith(path + '/')) state.files.delete(key)
  }),
  createUploadTask: vi.fn((_url: string, path: string) => ({
    cancelAsync: state.cancel,
    uploadAsync: async () => {
      state.uploaded.push(path.split('/').pop() ?? '')
      await state.onUpload(path)
      if (state.hangSegment && path.endsWith('.m4s')) return new Promise(() => {})
      return { status: state.failSegment && path.endsWith('.m4s') ? 503 : 204 }
    },
  })),
}))
const id = '00000000-0000-4000-8000-000000000001'
const root = 'file:///documents/segment-uploads/'
const dir = `file:///documents/segments/${id}/`
function client() {
  return {
    begin: vi.fn<SegmentUploadClient['begin']>().mockResolvedValue({
      recordingId: 'recording1' as Id<'segmentRecordings'>,
      recordId: 'bondfire1' as Id<'bondfires'>,
      maxDuration: 60,
    }),
    finish: vi.fn<SegmentUploadClient['finish']>().mockResolvedValue({ complete: true }),
    capability: vi.fn<SegmentUploadClient['capability']>().mockResolvedValue({
      baseUrl: 'https://media.test/v1/recording1',
      token: 'token',
      expiresAt: Date.now() + 3600_000,
    }),
  }
}

beforeEach(() => {
  vi.resetModules()
  state.files.clear()
  state.uploaded = []
  state.failSegment = false
  state.hangSegment = false
  state.onUpload = async () => {}
  vi.clearAllMocks()
  vi.stubEnv('EXPO_PUBLIC_SEGMENT_MEDIA', '1')
  vi.stubEnv('EXPO_PUBLIC_APP_ENV', 'internal')
  vi.stubEnv('EXPO_PUBLIC_CONVEX_URL', 'https://lovely-malamute-525.convex.cloud')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
describe('durable segment upload recovery', () => {
  it('keeps media after a failed upload and resumes at the unacknowledged segment', async () => {
    const queue = await import('../lib/media/segmentUploads')
    const convex = client()
    queue.setSegmentUploadOwner('owner')
    await queue.prepareSegmentJob('owner', { localId: id, isResponse: false })
    state.files.set(dir + 'init.mp4', 'init')
    state.files.set(dir + 'segment-000000.m4s', 'media')
    state.files.set(dir + 'finished.json', '{"segmentCount":1}')
    state.failSegment = true
    await queue.runSegmentUploads(convex, 'owner')
    expect(state.files.has(dir + 'segment-000000.m4s')).toBe(true)
    state.failSegment = false
    await queue.runSegmentUploads(convex, 'owner')
    expect(state.uploaded).toEqual(['init.mp4', 'segment-000000.m4s', 'segment-000000.m4s'])
    expect(state.files.has(root + id + '.json')).toBe(false)
  })
  it('recovers the temporary journal after an interrupted iOS rename and never uploads another user’s job', async () => {
    const queue = await import('../lib/media/segmentUploads')
    const convex = client()
    await queue.prepareSegmentJob('owner', { localId: id, isResponse: false })
    const saved = state.files.get(root + id + '.json') ?? ''
    state.files.set(root + id + '.json.tmp', saved)
    state.files.delete(root + id + '.json')
    state.files.set(dir + 'init.mp4', 'init')
    state.files.set(dir + 'segment-000000.m4s', 'media')
    queue.setSegmentUploadOwner('different')
    await queue.runSegmentUploads(convex, 'different')
    expect(convex.begin).not.toHaveBeenCalled()
    queue.setSegmentUploadOwner('owner')
    await queue.runSegmentUploads(convex, 'owner')
    expect(state.uploaded).toEqual(['init.mp4', 'segment-000000.m4s'])
    expect(convex.finish).toHaveBeenLastCalledWith({
      recordingId: 'recording1',
      segmentCount: 1,
    })
  })
})

it('allows retrying an empty preview, but protects saved drafts and interrupted journals by owner', async () => {
  const queue = await import('../lib/media/segmentUploads')
  await queue.prepareSegmentJob('owner', {
    localId: id,
    isResponse: false,
    draftBondfireId: 'draft' as Id<'bondfires'>,
  })
  expect(await queue.hasSavedDraftCapture('owner', 'draft')).toBe(false)
  queue.markSegmentCapture(id, true)
  expect(await queue.hasSavedDraftCapture('owner', 'draft')).toBe(true)
  queue.markSegmentCapture(id, false)
  state.files.set(dir + 'init.mp4', 'init')
  expect(await queue.hasSavedDraftCapture('owner', 'draft')).toBe(false)
  state.files.set(dir + 'segment-000000.m4s', 'video')
  state.files.set(root + id + '.json.tmp', state.files.get(root + id + '.json') ?? '')
  state.files.delete(root + id + '.json')
  expect(await queue.hasSavedDraftCapture('owner', 'draft')).toBe(true)
  expect(await queue.hasSavedDraftCapture('different', 'draft')).toBe(false)
  expect(await queue.hasSavedDraftCapture('owner', 'another-draft')).toBe(false)
})

it('does not activate a shared draft for an empty failed capture', async () => {
  const queue = await import('../lib/media/segmentUploads')
  const convex = client()
  queue.setSegmentUploadOwner('owner')
  await queue.prepareSegmentJob('owner', {
    localId: id,
    isResponse: false,
    draftBondfireId: 'draft' as Id<'bondfires'>,
  })
  state.files.set(dir + 'init.mp4', 'init')
  await queue.runSegmentUploads(convex, 'owner')
  expect(convex.begin).not.toHaveBeenCalled()
  expect(state.uploaded).toEqual([])
})

function seedCapture(count = 1) {
  state.files.set(dir + 'init.mp4', 'init')
  for (let i = 0; i < count; i++)
    state.files.set(dir + `segment-${String(i).padStart(6, '0')}.m4s`, 'media')
  state.files.set(dir + 'finished.json', JSON.stringify({ segmentCount: count }))
}

it('finishes in the current pass when capture stops during the last upload', async () => {
  const queue = await import('../lib/media/segmentUploads')
  const convex = client()
  queue.setSegmentUploadOwner('owner')
  await queue.prepareSegmentJob('owner', { localId: id, isResponse: false })
  seedCapture()
  state.files.delete(dir + 'finished.json')
  queue.markSegmentCapture(id, true)
  state.onUpload = async (path) => {
    if (!path.endsWith('.m4s')) return
    state.files.set(dir + 'finished.json', '{"segmentCount":1}')
    // Stop can request an upload pass while the current pass owns the queue.
    await queue.runSegmentUploads(convex, 'owner')
  }
  await queue.runSegmentUploads(convex, 'owner')
  expect(convex.finish).toHaveBeenCalledWith({ recordingId: 'recording1', segmentCount: 1 })
  expect(state.files.has(root + id + '.json')).toBe(false)
})

it('announces a newly finished capture even when its tail needs another upload pass', async () => {
  const queue = await import('../lib/media/segmentUploads')
  const convex = client()
  convex.finish.mockResolvedValue({ complete: false })
  queue.setSegmentUploadOwner('owner')
  await queue.prepareSegmentJob('owner', { localId: id, isResponse: false })
  seedCapture(5)
  state.files.delete(dir + 'finished.json')
  queue.markSegmentCapture(id, true)
  state.onUpload = async () => {
    state.files.set(dir + 'finished.json', '{"segmentCount":5}')
  }
  await queue.runSegmentUploads(convex, 'owner')
  expect(convex.finish).toHaveBeenCalledWith({ recordingId: 'recording1', segmentCount: 5 })
  expect(state.files.has(root + id + '.json')).toBe(true)
  expect(state.files.has(dir + 'segment-000004.m4s')).toBe(true)
})

it('announces the final count before uploading the tail, but retains it until acknowledged', async () => {
  const queue = await import('../lib/media/segmentUploads')
  const convex = client()
  queue.setSegmentUploadOwner('owner')
  await queue.prepareSegmentJob('owner', { localId: id, isResponse: false })
  seedCapture(5)
  convex.finish.mockImplementation(async () => {
    expect(state.files.has(dir + 'segment-000004.m4s')).toBe(true)
    return { complete: false }
  })
  await queue.runSegmentUploads(convex, 'owner')
  expect(convex.finish).toHaveBeenCalledWith({ recordingId: 'recording1', segmentCount: 5 })
  expect(state.uploaded).toHaveLength(4) // init + three fragments per pass
  expect(state.files.has(root + id + '.json')).toBe(true)
  convex.finish.mockResolvedValue({ complete: true })
  await queue.runSegmentUploads(convex, 'owner')
  expect(state.uploaded).toHaveLength(6)
  expect(state.files.has(root + id + '.json')).toBe(false)
})

it('cancels a hung PUT, retains the media, and allows the next pass to resume', async () => {
  vi.useFakeTimers()
  const queue = await import('../lib/media/segmentUploads')
  const convex = client()
  queue.setSegmentUploadOwner('owner')
  await queue.prepareSegmentJob('owner', { localId: id, isResponse: false })
  seedCapture()
  state.hangSegment = true
  const pass = queue.runSegmentUploads(convex, 'owner')
  await vi.advanceTimersByTimeAsync(120_001)
  await pass
  expect(state.cancel).toHaveBeenCalledOnce()
  expect(state.files.has(root + id + '.json')).toBe(true)
  expect(queue.segmentUploadError(id)).toBeTruthy()
  expect(queue.segmentUploadError('another-recording')).toBeNull()
  expect(state.warn).toHaveBeenCalledWith(
    'segment:upload:paused',
    expect.any(String),
    expect.objectContaining({ stage: 'upload', code: 'timeout', nextIndex: 0 }),
  )
  state.hangSegment = false
  await queue.runSegmentUploads(convex, 'owner')
  expect(state.uploaded).toEqual(['init.mp4', 'segment-000000.m4s', 'segment-000000.m4s'])
  expect(state.files.has(root + id + '.json')).toBe(false)
  expect(queue.segmentUploadError(id)).toBeNull()
})

it('retries a lost finish acknowledgement without exposing network credentials in telemetry', async () => {
  vi.useFakeTimers()
  const queue = await import('../lib/media/segmentUploads')
  const convex = client()
  queue.setSegmentUploadOwner('owner')
  await queue.prepareSegmentJob('owner', { localId: id, isResponse: false })
  seedCapture()
  convex.finish.mockImplementationOnce(() => new Promise(() => {}))
  const pass = queue.runSegmentUploads(convex, 'owner')
  await vi.advanceTimersByTimeAsync(30_001)
  await pass
  expect(state.files.has(root + id + '.json')).toBe(true)
  convex.capability.mockRejectedValueOnce(new Error('https://media.test?token=secret'))
  await vi.advanceTimersByTimeAsync(60_000)
  await queue.runSegmentUploads(convex, 'owner')
  expect(JSON.stringify(state.warn.mock.calls)).not.toContain('secret')
  await queue.runSegmentUploads(convex, 'owner')
  expect(state.files.has(root + id + '.json')).toBe(false)
})

describe('upload status reporting', () => {
  function observe(queue: typeof import('../lib/media/segmentUploads')) {
    const jobs: Array<Array<{ localId: string; paused: boolean; bondfireId?: string }>> = []
    const completed: Array<{ localId: string; isResponse: boolean; bondfireId?: string }> = []
    queue.setSegmentUploadObserver({
      onJobs: (next) => jobs.push(next),
      onComplete: (job) => completed.push(job),
    })
    return { jobs, completed, latest: () => jobs.at(-1) ?? [] }
  }

  it('reports a paused job without flickering back to uploading until it makes progress', async () => {
    const queue = await import('../lib/media/segmentUploads')
    const convex = client()
    const seen = observe(queue)
    queue.setSegmentUploadOwner('owner')
    await queue.prepareSegmentJob('owner', { localId: id, isResponse: false })
    seedCapture(2)
    state.failSegment = true
    await queue.runSegmentUploads(convex, 'owner')
    expect(seen.latest()).toEqual([
      { localId: id, isResponse: false, bondfireId: 'bondfire1', paused: true },
    ])
    const reportsWhilePaused = seen.jobs.length
    await queue.runSegmentUploads(convex, 'owner')
    // A second failing pass must not publish an intermediate "uploading" state.
    expect(seen.jobs.slice(reportsWhilePaused).every((jobs) => jobs[0]?.paused)).toBe(true)

    state.failSegment = false
    await queue.runSegmentUploads(convex, 'owner')
    expect(seen.completed).toEqual([
      { localId: id, isResponse: false, bondfireId: 'bondfire1', paused: false },
    ])
    expect(seen.latest()).toEqual([])
  })

  it('points a response at its parent bondfire and ignores captures still recording', async () => {
    const queue = await import('../lib/media/segmentUploads')
    const convex = client()
    convex.finish.mockResolvedValue({ complete: false })
    const seen = observe(queue)
    queue.setSegmentUploadOwner('owner')
    await queue.prepareSegmentJob('owner', {
      localId: id,
      isResponse: true,
      bondfireId: 'parent' as Id<'bondfires'>,
    })
    seedCapture()
    queue.markSegmentCapture(id, true)
    await queue.runSegmentUploads(convex, 'owner')
    expect(seen.latest()).toEqual([])
    queue.markSegmentCapture(id, false)
    await queue.runSegmentUploads(convex, 'owner')
    expect(seen.latest()).toEqual([
      { localId: id, isResponse: true, bondfireId: 'parent', paused: false },
    ])
  })

  it('never reports another account’s job and clears when the owner changes', async () => {
    const queue = await import('../lib/media/segmentUploads')
    const convex = client()
    convex.finish.mockResolvedValue({ complete: false })
    const seen = observe(queue)
    queue.setSegmentUploadOwner('owner')
    await queue.prepareSegmentJob('owner', { localId: id, isResponse: false })
    seedCapture()
    await queue.runSegmentUploads(convex, 'owner')
    expect(seen.latest()).toHaveLength(1)
    queue.setSegmentUploadOwner('different')
    expect(seen.latest()).toEqual([])
    await queue.runSegmentUploads(convex, 'different')
    expect(seen.latest()).toEqual([])
  })
})
