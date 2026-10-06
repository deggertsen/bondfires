import { createElement } from 'react'
// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CreateScreen from '../../app/(main)/create'

const mocks = vi.hoisted(() => ({
  enabled: false,
  useCameraPermissions: vi.fn(),
  useQuery: vi.fn(),
  replace: vi.fn(),
}))

vi.mock('@bondfires/app', () => ({
  useAppThemeColors: () => ({ colors: { background: '#ffffff' }, statusBarStyle: 'dark-content' }),
}))
vi.mock('@bondfires/ui', () => ({ Button: 'Button', Spinner: 'Spinner', Text: 'Text' }))
vi.mock('tamagui', () => ({ XStack: 'XStack', YStack: 'YStack' }))
vi.mock('react-native', () => ({ StatusBar: 'StatusBar' }))
vi.mock('@legendapp/state/react', () => ({}))
vi.mock('@react-navigation/native', () => ({}))
vi.mock('@tamagui/lucide-icons', () => ({}))
vi.mock('convex/react', () => ({ useQuery: mocks.useQuery }))
vi.mock('expo-camera', () => ({ useCameraPermissions: mocks.useCameraPermissions }))
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: mocks.replace }) }))
vi.mock('react-native-safe-area-context', () => ({}))
vi.mock('../../components/create/CampPickerScreen', () => ({}))
vi.mock('../../components/create/PreRecordingInviteScreen', () => ({}))
vi.mock('../../components/create/SegmentRecordScreen', () => ({}))
vi.mock('../../lib/media/segmentUploads', () => ({
  get segmentMediaEnabled() {
    return mocks.enabled
  },
}))
vi.mock('../../lib/routes', () => ({ routes: { feed: '/feed' } }))
vi.mock('../../lib/navigation', () => ({}))

describe('create availability', () => {
  let renderer: ReturnType<typeof create> | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.enabled = false
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount())
    renderer = undefined
  })

  it('blocks the create flow before permissions, drafts or capture when uploads are disabled', async () => {
    await act(async () => {
      renderer = create(createElement(CreateScreen))
    })
    expect(JSON.stringify(renderer.toJSON())).toContain('Recording unavailable')
    expect(mocks.useCameraPermissions).not.toHaveBeenCalled()
    expect(mocks.useQuery).not.toHaveBeenCalled()
    await act(async () => renderer.root.findByType('Button').props.onPress())
    expect(mocks.replace).toHaveBeenCalledWith('/feed')
  })
})
