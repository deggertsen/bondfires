import { createElement } from 'react'
// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RespondGate } from '../../components/create/RespondGate'
import { createRespondToPath, resolveExternalRoute, routes } from '../../lib/routes'

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  recorderMount: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
  canGoBack: vi.fn(),
}))
vi.mock('@bondfires/app', () => ({
  useAppThemeColors: () => ({ colors: { background: '#ffffff' }, statusBarStyle: 'dark-content' }),
  parsePersonalBondfireInvite: () => null,
}))
vi.mock('@bondfires/ui', () => ({ Button: 'Button', Spinner: 'Spinner', Text: 'Text' }))
vi.mock('tamagui', () => ({ YStack: 'YStack' }))
vi.mock('react-native', () => ({ StatusBar: 'StatusBar' }))
vi.mock('convex/react', () => ({ useQuery: mocks.useQuery }))
vi.mock('expo-router', () => ({
  Redirect: 'Redirect',
  useRouter: () => ({ replace: mocks.replace, back: mocks.back }),
  useNavigation: () => ({ canGoBack: mocks.canGoBack }),
}))

function Recorder() {
  mocks.recorderMount()
  return createElement('Recorder')
}
function entry(bondfireId?: string) {
  // biome-ignore lint/correctness/noChildrenProp: RespondGate requires children in its props type for createElement.
  return createElement(RespondGate, { bondfireId, children: createElement(Recorder) })
}
const nonmember = {
  bondfire: { campId: 'camp-1' },
  camp: { status: 'active' },
  membership: null,
  hasInviteClaim: true,
}

describe('RespondGate recording boundary', () => {
  let renderer: ReturnType<typeof create>
  beforeEach(() => {
    vi.resetAllMocks()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(async () => {
    await act(async () => renderer?.unmount())
  })

  it('waits, redirects nonmembers with a recorder return path, then allows the joined member', async () => {
    await act(async () => {
      renderer = create(entry('bf-1'))
    })
    expect(renderer.root.findAllByType('Spinner')).toHaveLength(1)
    expect(mocks.recorderMount).not.toHaveBeenCalled()

    mocks.useQuery.mockReturnValue(nonmember)
    await act(async () => {
      renderer.update(entry('bf-1'))
    })
    expect(renderer.root.findByType('Redirect').props.href).toEqual(
      routes.campJoinGate('camp-1', createRespondToPath('bf-1')),
    )
    expect(mocks.recorderMount).not.toHaveBeenCalled()

    const destination = resolveExternalRoute(createRespondToPath('bf-1'))
    expect(destination).toEqual(routes.createRespondTo('bf-1'))
    mocks.useQuery.mockReturnValue({ ...nonmember, membership: { status: 'active' } })
    await act(async () => {
      renderer.update(entry('bf-1'))
    })
    expect(renderer.root.findAllByType('Recorder')).toHaveLength(1)
  })

  it.each([null, { ...nonmember, camp: { status: 'archived' } }])(
    'keeps unavailable targets outside the recorder and offers a safe exit',
    async (context) => {
      mocks.useQuery.mockReturnValue(context)
      await act(async () => {
        renderer = create(entry('bf-1'))
      })
      expect(JSON.stringify(renderer.toJSON())).toContain('Response unavailable')
      expect(mocks.recorderMount).not.toHaveBeenCalled()
      await act(async () => renderer.root.findByType('Button').props.onPress())
      expect(mocks.replace).toHaveBeenCalledWith(routes.feed)
    },
  )

  it('rechecks a changed response target without a sticky redirect flag', async () => {
    mocks.useQuery.mockReturnValue(nonmember)
    await act(async () => {
      renderer = create(entry('bf-1'))
    })
    mocks.useQuery.mockReturnValue(undefined)
    await act(async () => {
      renderer.update(entry('bf-2'))
    })
    expect(renderer.root.findAllByType('Redirect')).toHaveLength(0)
    mocks.useQuery.mockReturnValue({ ...nonmember, bondfire: { campId: 'camp-2' } })
    await act(async () => {
      renderer.update(entry('bf-2'))
    })
    expect(mocks.useQuery.mock.lastCall?.[1]).toEqual({ id: 'bf-2' })
    expect(renderer.root.findByType('Redirect').props.href).toEqual(
      routes.campJoinGate('camp-2', createRespondToPath('bf-2')),
    )
    expect(mocks.recorderMount).not.toHaveBeenCalled()
  })

  it('skips the gate query for new sparks and allows visible Hearth responses', async () => {
    await act(async () => {
      renderer = create(entry())
    })
    expect(mocks.useQuery.mock.lastCall?.[1]).toBe('skip')
    expect(renderer.root.findAllByType('Recorder')).toHaveLength(1)
    mocks.useQuery.mockReturnValue({ bondfire: {}, camp: null, membership: null })
    await act(async () => {
      renderer.update(entry('hearth-1'))
    })
    expect(mocks.useQuery.mock.lastCall?.[1]).toEqual({ id: 'hearth-1' })
    expect(renderer.root.findAllByType('Recorder')).toHaveLength(1)
  })
})
