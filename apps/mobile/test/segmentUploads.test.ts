import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Id } from '../../../convex/_generated/dataModel'
import type { SegmentUploadClient } from '../lib/media/segmentUploads'

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failSegment: false,
  uploaded: [] as string[],
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
  uploadAsync: vi.fn(async (_url: string, path: string) => {
    state.uploaded.push(path.split('/').pop() ?? '')
    return { status: state.failSegment && path.endsWith('.m4s') ? 503 : 204 }
  }),
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
  vi.stubEnv('EXPO_PUBLIC_SEGMENT_MEDIA', '1')
  vi.stubEnv('EXPO_PUBLIC_APP_ENV', 'internal')
  vi.stubEnv('EXPO_PUBLIC_CONVEX_URL', 'https://lovely-malamute-525.convex.cloud')
})
afterEach(() => vi.unstubAllEnvs())
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
