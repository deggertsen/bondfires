import { createElement, useState } from 'react'
// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Id } from '../../../../convex/_generated/dataModel'
import { ThreadBrowser } from '../../app/(main)/bondfire/_components/ThreadBrowser'
import type { BondfireVideoItem } from '../../app/(main)/bondfire/_lib/bondfireDetailHelpers'
import { getThreadCatchUp } from '../../app/(main)/bondfire/_lib/threadCatchUp'

vi.mock('@bondfires/ui', () => ({ Button: 'Button', Text: 'Text', UserAvatar: 'UserAvatar' }))
vi.mock('@tamagui/lucide-icons', () => ({
  Bell: 'Bell',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  Flame: 'Flame',
  Share2: 'Share2',
}))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }))
vi.mock('tamagui', async () => {
  const { createElement } = await import('react')
  return {
    XStack: 'XStack',
    YStack: 'YStack',
    Sheet: Object.assign((props: Record<string, unknown>) => createElement('Sheet', props), {
      Frame: 'Frame',
      Handle: 'Handle',
      Overlay: 'Overlay',
    }),
  }
})
vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  return {
    Pressable: 'Pressable',
    FlatList: ({
      data,
      renderItem,
      ...props
    }: {
      data: { key: string }[]
      renderItem: (args: { item: { key: string } }) => React.ReactNode
    }) =>
      createElement(
        'FlatList',
        props,
        data.map((item) => createElement('Row', { key: item.key }, renderItem({ item }))),
      ),
  }
})

const videos: BondfireVideoItem[] = [true, true, true, false, false].map(
  (watchedByViewer, index) => ({
    key: `video-${index}`,
    videoOwnerId: 'owner' as Id<'users'>,
    creatorName: 'Creator',
    isMainVideo: index === 0,
    isLive: false,
    createdAt: 1000,
    watchedByViewer,
    url: null,
  }),
)
const arrival = getThreadCatchUp(videos, 4)
const acknowledged = vi.fn()
function Harness({ currentVideoIndex = 4, catchUp = arrival }) {
  const [pending, setPending] = useState(true)
  return createElement(ThreadBrowser, {
    title: 'Thread',
    videoItems: videos,
    currentVideoIndex,
    catchUp,
    catchUpAutoOpenPending: pending,
    onCatchUpAutoOpened: () => {
      acknowledged()
      setPending(false)
    },
    processingCount: 0,
    canRespond: false,
    canShare: false,
    onSelectVideo: vi.fn(),
    onRespond: vi.fn(),
    onShare: vi.fn(),
  })
}

describe('ThreadBrowser catch-up interactions', () => {
  let renderer: ReturnType<typeof create>
  const sheet = () => renderer.root.findByType('Sheet')
  const text = (value: string) =>
    renderer.root
      .findAllByType('Text')
      .find((node: { props: { children: unknown } }) => node.props.children === value)
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => {
      renderer = create(createElement(Harness))
    })
  })
  afterEach(async () => {
    await act(async () => renderer.unmount())
    vi.useRealTimers()
  })

  it('opens once and stays dismissed through playback updates', async () => {
    expect(sheet().props.open).toBe(false)
    await act(async () => vi.advanceTimersByTime(350))
    expect(sheet().props.open).toBe(true)
    expect(acknowledged).toHaveBeenCalledTimes(1)
    await act(async () => sheet().props.onOpenChange(false))
    await act(async () => renderer.update(createElement(Harness, { currentVideoIndex: 3 })))
    await act(async () => vi.advanceTimersByTime(1000))
    expect(sheet().props.open).toBe(false)
  })

  it('does not reopen after manual open and dismissal during the arrival delay', async () => {
    const bar = renderer.root
      .findAllByType('Pressable')
      .find(
        (node: { props: { style?: { position?: string } } }) =>
          node.props.style?.position === 'absolute',
      )
    await act(async () => bar.props.onPress())
    await act(async () => sheet().props.onOpenChange(false))
    await act(async () => vi.advanceTimersByTime(1000))
    expect(sheet().props.open).toBe(false)
    expect(acknowledged).toHaveBeenCalledTimes(1)
  })

  it('reveals the playing row and prevents Hide from folding it away', async () => {
    await act(async () => renderer.update(createElement(Harness, { currentVideoIndex: 1 })))
    expect(text('NOW')).toBeDefined()
    expect(text('Hide')).toBeUndefined()
    expect(renderer.root.findAllByType('Row')).toHaveLength(7)
    await act(async () => renderer.update(createElement(Harness, { currentVideoIndex: 4 })))
    expect(text('Show')).toBeDefined()
  })

  it('resets a manually expanded fold on a new arrival in the same thread', async () => {
    await act(async () => text('Show').parent.parent.props.onPress())
    expect(text('Hide')).toBeDefined()
    await act(async () =>
      renderer.update(createElement(Harness, { catchUp: getThreadCatchUp(videos, 3) })),
    )
    expect(text('Show')).toBeDefined()
  })
})

describe('ThreadBrowser list position', () => {
  // A fully watched thread opens on its most recent video.
  const watchedThread: BondfireVideoItem[] = Array.from({ length: 12 }, (_, index) => ({
    ...videos[0],
    key: `watched-${index}`,
    isMainVideo: index === 0,
    watchedByViewer: true,
  }))
  const lastIndex = watchedThread.length - 1
  const compactRowHeight = 54

  it('keeps the closed list on the most recent video so the menu opens at the bottom', async () => {
    const scrollToOffset = vi.fn()
    let renderer: ReturnType<typeof create> | undefined
    await act(async () => {
      renderer = create(
        createElement(ThreadBrowser, {
          title: 'Thread',
          videoItems: watchedThread,
          currentVideoIndex: lastIndex,
          catchUp: getThreadCatchUp(watchedThread, lastIndex),
          catchUpAutoOpenPending: false,
          onCatchUpAutoOpened: vi.fn(),
          processingCount: 0,
          canRespond: false,
          canShare: false,
          onSelectVideo: vi.fn(),
          onRespond: vi.fn(),
          onShare: vi.fn(),
        }),
        { createNodeMock: () => ({ scrollToOffset }) },
      )
    })
    const sheet = renderer?.root.findByType('Sheet')
    expect(sheet?.props.open).toBe(false)
    expect(scrollToOffset).toHaveBeenLastCalledWith({
      offset: lastIndex * compactRowHeight - compactRowHeight * 1.5,
      animated: false,
    })
    await act(async () => renderer?.unmount())
  })
})
