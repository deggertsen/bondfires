/// <reference types="vite/client" />
import type { FunctionReturnType } from 'convex/server'
import { convexTest } from 'convex-test'
import { createElement } from 'react'
// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../../../../convex/_generated/api'
import schema from '../../../../convex/schema'
import {
  type BondfireDetailData,
  getInitialVideoIndex,
  mergeBondfireResponsePages,
} from '../../app/(main)/bondfire/_lib/bondfireDetailHelpers'
import {
  buildThreadBrowserLayout,
  getThreadCatchUp,
  getThreadFoldedCount,
} from '../../app/(main)/bondfire/_lib/threadCatchUp'
import { useBondfireThreadPosition } from '../../app/(main)/bondfire/_lib/useBondfireThreadPosition'

vi.mock('react-native', () => ({ Dimensions: { get: () => ({ width: 390 }) } }))
const modules = import.meta.glob('../../../../convex/**/*.ts')

async function fixture() {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert('users', { gender: 'other' })
    const responder = await ctx.db.insert('users', { gender: 'other' })
    const bondfireId = await ctx.db.insert('bondfires', {
      userId: owner,
      videoStatus: 'ready',
      muxPlaybackId: 'spark',
      videoCount: 121,
      createdAt: 1,
      updatedAt: 1,
    })
    const responseIds = []
    for (let sequenceNumber = 1; sequenceNumber <= 120; sequenceNumber++) {
      responseIds.push(
        await ctx.db.insert('bondfireVideos', {
          bondfireId,
          userId: responder,
          sequenceNumber,
          videoStatus: 'ready',
          muxPlaybackId: `response-${sequenceNumber}`,
          createdAt: sequenceNumber,
        }),
      )
    }
    return { owner, responder, bondfireId, responseIds }
  })
  const viewer = t.withIdentity({ subject: ids.owner })
  const metadata = await viewer.query(api.bondfires.getWithVideos, {
    bondfireId: ids.bondfireId,
    metadataOnly: true,
  })
  if (!metadata) throw new Error('Missing metadata')
  const page = (cursor: string | null = null) =>
    viewer.query(api.bondfires.getResponsePage, {
      bondfireId: ids.bondfireId,
      paginationOpts: { cursor, numItems: 50 },
    })
  return { t, ids, viewer, metadata, page }
}

describe('paginated thread arrival', () => {
  it('loads through older pages before scrolling to a deep link, then retains the playing identity on prepend', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const { ids, metadata, page } = await fixture()
    const loadOlder = vi.fn()
    const scrollToIndex = vi.fn()
    const onArrival = vi.fn()
    let state: ReturnType<typeof useBondfireThreadPosition> | undefined
    function Harness({
      data,
      hasOlder,
      currentVideoIndex = 0,
      responseId = ids.responseIds[35],
    }: {
      data: BondfireDetailData
      hasOlder: boolean
      currentVideoIndex?: number
      responseId?: string
    }) {
      state = useBondfireThreadPosition({
        data,
        responseId,
        hasOlder,
        currentVideoIndex,
        loadOlder,
        scrollToIndex,
        onArrival,
      })
      return null
    }
    const newest = await page()
    const rows: FunctionReturnType<typeof api.bondfires.getResponsePage>['page'] = [...newest.page]
    let data = mergeBondfireResponsePages(metadata, rows)
    let renderer: ReturnType<typeof create>
    await act(async () => {
      renderer = create(createElement(Harness, { data, hasOlder: true }))
    })
    expect(state).toBe('loading')
    expect(loadOlder).toHaveBeenCalledTimes(1)
    expect(scrollToIndex).not.toHaveBeenCalled()
    const older = await page(newest.continueCursor)
    rows.push(...older.page)
    data = mergeBondfireResponsePages(metadata, rows)
    await act(async () => renderer.update(createElement(Harness, { data, hasOlder: true })))
    expect(state).toBe('resolved')
    expect(scrollToIndex).toHaveBeenLastCalledWith(16) // Spark + responses 21..35 before target 36.
    expect(data.videos[15]._id).toBe(ids.responseIds[35])
    expect(onArrival).toHaveBeenCalledTimes(1)
    const oldest = await page(older.continueCursor)
    rows.push(...oldest.page)
    data = mergeBondfireResponsePages(metadata, rows)
    await act(async () =>
      renderer.update(createElement(Harness, { data, hasOlder: false, currentVideoIndex: 16 })),
    )
    expect(scrollToIndex).toHaveBeenLastCalledWith(36)
    expect(data.videos[35]._id).toBe(ids.responseIds[35])
    expect(onArrival).toHaveBeenCalledTimes(1) // Loading history is not a new arrival.
    // Missing/removed targets produce an explicit unavailable result, not a
    // silent pending fallback, and a second deep link re-arms the arrival.
    await act(async () =>
      renderer.update(createElement(Harness, { data, hasOlder: false, responseId: 'missing' })),
    )
    expect(state).toBe('unavailable')
    await act(async () => renderer.unmount())
  })

  it('starts at the first loaded unwatched response and never folds newly loaded unknown history', async () => {
    const { metadata, page, ids } = await fixture()
    const newest = await page()
    const data = mergeBondfireResponsePages(metadata, newest.page)
    expect(getInitialVideoIndex(data)).toBe(1)
    expect(data.videos[0].sequenceNumber).toBe(71) // Global first-unwatched is 1, outside this window.
    const catchUp = getThreadCatchUp(
      [data, ...data.videos].map((video) => ({
        key: video._id,
        watchedByViewer: video.watchedByViewer ?? false,
      })),
      getInitialVideoIndex(data),
    )
    expect(catchUp.newVideoKeys).toEqual(ids.responseIds.slice(70))
    expect(catchUp.foldedVideoKeys).toEqual([])
    const older = await page(newest.continueCursor)
    const expanded = mergeBondfireResponsePages(metadata, [...newest.page, ...older.page])
    expect(
      getThreadFoldedCount([expanded._id, ...expanded.videos.map((video) => video._id)], catchUp),
    ).toBe(0)
    expect(expanded.videos[0].watchedByViewer).toBe(false)
    expect(
      expanded.participants?.find((entry) => entry.user._id === ids.responder)?.videoCount,
    ).toBe(100)
    expect(expanded.participants?.find((entry) => entry.user._id === ids.owner)?.videoCount).toBe(1)
  })

  it('keeps My Fires global first-unwatched when the loaded tail is already watched', async () => {
    const { t, ids, metadata, viewer, page } = await fixture()
    await t.run(async (ctx) => {
      for (const responseId of ids.responseIds.slice(70)) {
        await ctx.db.insert('watchEvents', {
          userId: ids.owner,
          videoType: 'response',
          videoId: responseId,
          eventType: 'complete',
          positionMs: 1000,
          createdAt: 200,
        })
      }
    })
    const newest = await page()
    const data = mergeBondfireResponsePages(metadata, newest.page)
    expect(getInitialVideoIndex(data)).toBe(50)
    const catchUp = getThreadCatchUp(
      [data, ...data.videos].map((video) => ({
        key: video._id,
        watchedByViewer: video.watchedByViewer ?? false,
      })),
      getInitialVideoIndex(data),
    )
    expect(catchUp.autoOpen).toBe(false)
    expect(catchUp.newVideoKeys).toEqual([]) // Unknown history is not counted as watched or new.
    const fires = await viewer.query(api.conversations.listMyFires, {})
    expect(fires.find((fire) => fire._id === ids.bondfireId)?.firstUnwatchedResponder?._id).toBe(
      ids.responder,
    )
    const older = await page(newest.continueCursor)
    const expanded = mergeBondfireResponsePages(metadata, [...newest.page, ...older.page])
    expect(expanded.videos[0].watchedByViewer).toBe(false)
    expect(
      getThreadFoldedCount([expanded._id, ...expanded.videos.map((video) => video._id)], catchUp),
    ).toBe(0)
  })

  it('offsets the existing fold and video rows by the load-older row', () => {
    const keys = ['spark', 'watched', 'new1', 'new2']
    const catchUp = getThreadCatchUp(
      keys.map((key, i) => ({ key, watchedByViewer: i < 2 })),
      2,
    )
    for (const earlierExpanded of [true, false]) {
      const base = { videoKeys: keys, rowHeight: 54, catchUp, earlierExpanded }
      const without = buildThreadBrowserLayout(base)
      const withOlder = buildThreadBrowserLayout({ ...base, hasOlder: true })
      expect(withOlder.entries[0].kind).toBe('loadOlder')
      expect(withOlder.entries.slice(1)).toEqual(
        without.entries.map((entry) => ({ ...entry, offset: entry.offset + 54 })),
      )
      expect(withOlder.videoOffsets).toEqual(
        without.videoOffsets.map((offset) => (offset === undefined ? undefined : offset + 54)),
      )
      // The unloaded rows are not part of the watched fold's identity set.
      expect(getThreadFoldedCount(['spark', 'unloaded', ...keys.slice(1)], catchUp)).toBe(0)
    }
  })
})
