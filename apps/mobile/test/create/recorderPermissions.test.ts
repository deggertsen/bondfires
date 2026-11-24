import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useRecorderPermissions } from '../../components/create/useRecorderPermissions'

const mocks = vi.hoisted(() => ({
  camera: vi.fn(),
  mic: vi.fn(),
  requestCamera: vi.fn(),
  requestMic: vi.fn(),
  readCamera: vi.fn(),
  readMic: vi.fn(),
  openSettings: vi.fn(),
  subscribe: vi.fn(),
  remove: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}))
vi.mock('expo-camera', () => ({
  useCameraPermissions: () => [mocks.camera(), mocks.requestCamera, mocks.readCamera],
  useMicrophonePermissions: () => [mocks.mic(), mocks.requestMic, mocks.readMic],
}))
vi.mock('react-native', () => ({
  AppState: { addEventListener: mocks.subscribe },
  Linking: { openSettings: mocks.openSettings },
}))
vi.mock('@bondfires/app', () => ({ telemetry: { warn: mocks.warn, info: mocks.info } }))

const granted = { status: 'granted', canAskAgain: true }
const denied = { status: 'denied', canAskAgain: true }
const blocked = { status: 'denied', canAskAgain: false }
function Probe() {
  return createElement('Gate', useRecorderPermissions())
}
let renderer: ReturnType<typeof create>
async function render() {
  await act(async () => {
    if (renderer) renderer.update(createElement(Probe))
    else renderer = create(createElement(Probe))
  })
  return renderer.root.findByType('Gate').props
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.subscribe.mockReturnValue({ remove: mocks.remove })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
  await act(async () => renderer.unmount())
  renderer = undefined
})

it('waits for both reads and skips requests and gate warnings when access is already granted', async () => {
  mocks.camera.mockReturnValue(granted)
  expect((await render()).mode).toBe('loading')
  mocks.mic.mockReturnValue(granted)
  expect((await render()).mode).toBe('granted')
  expect(mocks.warn).not.toHaveBeenCalled()
  expect(mocks.requestCamera).not.toHaveBeenCalled()
  expect(mocks.requestMic).not.toHaveBeenCalled()
})

it('requests an undetermined microphone once without re-requesting the camera', async () => {
  mocks.camera.mockReturnValue(granted)
  mocks.mic.mockReturnValue({ status: 'undetermined', canAskAgain: true })
  mocks.requestMic.mockResolvedValue(blocked)
  await render()
  expect(mocks.requestMic).toHaveBeenCalledOnce()
  expect(mocks.requestCamera).not.toHaveBeenCalled()
  expect(mocks.info).toHaveBeenCalledWith(
    'create:permissionRequest',
    'Microphone permission settled',
    blocked,
  )
})

it('can request a denied permission again when the OS allows it', async () => {
  mocks.camera.mockReturnValue(denied)
  mocks.mic.mockReturnValue(granted)
  mocks.requestCamera.mockResolvedValue(granted)
  const gate = await render()
  expect(gate.mode).toBe('request')
  expect(mocks.requestCamera).not.toHaveBeenCalled()
  await gate.onPress()
  expect(mocks.requestCamera).toHaveBeenCalledOnce()
})

it.each(['camera', 'mic'] as const)(
  'opens Settings for a blocked %s and refreshes both reads on return',
  async (permission) => {
    mocks.camera.mockReturnValue(granted)
    mocks.mic.mockReturnValue(granted)
    mocks[permission].mockReturnValue(blocked)
    const gate = await render()
    expect(gate.mode).toBe('settings')
    await gate.onPress()
    expect(mocks.openSettings).toHaveBeenCalledOnce()
    const [, onState] = mocks.subscribe.mock.calls[0]
    onState('background')
    expect(mocks.readCamera).not.toHaveBeenCalled()
    onState('active')
    expect(mocks.readCamera).toHaveBeenCalledOnce()
    expect(mocks.readMic).toHaveBeenCalledOnce()
    mocks[permission].mockReturnValue(granted)
    expect((await render()).mode).toBe('granted')
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(mocks.requestCamera).not.toHaveBeenCalled()
    expect(mocks.requestMic).not.toHaveBeenCalled()
  },
)
