import { createElement, StrictMode } from 'react'
// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isHomeFeedLoading } from '../../lib/homeFeedState'
import { useHomeFeedScrollRestoration } from '../../lib/useHomeFeedScrollRestoration'
import { useHomeFeedSnapshot } from '../../lib/useHomeFeedSnapshot'

type Fire = { _id: string }
type Props = { userId: string | null; focused: boolean; rail: Fire[] | undefined }
const feed = [{ _id: 'mine' }, { _id: 'discover' }]
let renderer: ReturnType<typeof create>
let visible: { loading: boolean; rail: Fire[] | undefined; discover: Fire[] }

function Harness({ userId, focused, rail }: Props) {
  const snapshot = useHomeFeedSnapshot(userId, rail)
  const loading = isHomeFeedLoading({
    feedResolved: true,
    railQueryEnabled: focused && !!userId,
    railResolved: snapshot !== undefined,
  })
  visible = {
    loading,
    rail: snapshot,
    discover: loading ? [] : feed.filter((fire) => !snapshot?.some((t) => t._id === fire._id)),
  }
  return null
}

async function render(props: Props) {
  await act(async () => {
    const element = createElement(StrictMode, null, createElement(Harness, props))
    if (renderer) renderer.update(element)
    else renderer = create(element)
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  vi.useRealTimers()
})

describe('Home query lifecycle', () => {
  it('waits for the rail, preserves classification across blur/refocus, and applies live updates', async () => {
    await render({ userId: 'alice', focused: true, rail: undefined })
    expect(visible.loading).toBe(true)
    expect(visible.discover).toEqual([])
    await render({ userId: 'alice', focused: true, rail: [feed[0]] })
    expect(visible.loading).toBe(false)
    expect(visible.discover).toEqual([feed[1]])
    for (const focused of [false, true]) {
      await render({ userId: 'alice', focused, rail: undefined })
      expect(visible.loading).toBe(false)
      expect(visible.rail).toEqual([feed[0]])
      expect(visible.discover).toEqual([feed[1]])
    }
    await render({ userId: 'alice', focused: true, rail: [] })
    expect(visible.rail).toEqual([])
    expect(visible.discover).toEqual(feed)
    await render({ userId: 'alice', focused: true, rail: undefined })
    expect(visible.loading).toBe(false)
    expect(visible.rail).toEqual([])
  })

  it('discards the snapshot on account changes and sign-out', async () => {
    await render({ userId: 'alice', focused: true, rail: [feed[0]] })
    await render({ userId: 'bob', focused: true, rail: undefined })
    expect(visible.loading).toBe(true)
    expect(visible.rail).toBeUndefined()
    await render({ userId: 'bob', focused: true, rail: [feed[1]] })
    await render({ userId: null, focused: false, rail: undefined })
    expect(visible.rail).toBeUndefined()
    await render({ userId: 'bob', focused: true, rail: undefined })
    expect(visible.loading).toBe(true)
    expect(visible.rail).toBeUndefined()
  })
})

it('restores only after the list mounts and retries a cancelled restoration with current rows', async () => {
  vi.useFakeTimers()
  const scrollToIndex = vi.fn()
  const listRef = { current: null as null | { scrollToIndex: typeof scrollToIndex } }
  const getSavedBondfireId = () => 'discover'
  function ScrollHarness({ ready, items }: { ready: boolean; items: Fire[] }) {
    useHomeFeedScrollRestoration({ ready, items, listRef, getSavedBondfireId })
    return null
  }
  async function update(ready: boolean, items: Fire[]) {
    await act(async () => {
      const element = createElement(
        StrictMode,
        null,
        createElement(ScrollHarness, { ready, items }),
      )
      if (renderer) renderer.update(element)
      else renderer = create(element)
    })
  }
  await update(false, feed)
  await act(async () => vi.runAllTimers())
  expect(scrollToIndex).not.toHaveBeenCalled()
  listRef.current = { scrollToIndex }
  await update(true, feed)
  // A live result arrives before the scheduled scroll. Cleanup must not consume it.
  await update(true, [feed[1]])
  await act(async () => vi.runAllTimers())
  expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith({
    index: 0,
    animated: false,
    viewPosition: 0.2,
  })
  await update(false, [feed[1]])
  await update(true, feed)
  await act(async () => vi.runAllTimers())
  expect(scrollToIndex).toHaveBeenCalledTimes(1)
})
