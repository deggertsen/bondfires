import { telemetry } from '@bondfires/app'
import type { PermissionResponse } from 'expo'
import { useCallback, useEffect, useRef } from 'react'
import { Alert, AppState, Linking } from 'react-native'

import { useCameraPermissions, useMicrophonePermissions } from './recorderPermissionHooks'

export function useRecorderPermissions() {
  const [camera, requestCamera, readCamera] = useCameraPermissions()
  const [mic, requestMic, readMic] = useMicrophonePermissions()
  const requesting = useRef(false)
  const cameraStatus = camera?.status
  const micStatus = mic?.status
  const cameraCanAskAgain = camera?.canAskAgain
  const micCanAskAgain = mic?.canAskAgain

  const mode = permissionMode(camera, mic)

  useEffect(() => {
    if (mode !== 'request' && mode !== 'settings') return
    telemetry.warn('create:permissionGate', 'Recorder permissions required', {
      camera: cameraStatus,
      mic: micStatus,
      cameraCanAskAgain,
      micCanAskAgain,
    })
  }, [mode, cameraStatus, micStatus, cameraCanAskAgain, micCanAskAgain])

  useEffect(() => {
    if (mode !== 'settings') return
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void Promise.all([readCamera(), readMic()]).catch((error) => {
          telemetry.warn('create:permissionGate', 'Could not refresh recorder permissions', {
            error: String(error),
          })
        })
      }
    })
    return () => subscription.remove()
  }, [mode, readCamera, readMic])

  const requestPermissions = useCallback(async () => {
    if (mode !== 'request' || requesting.current) return
    requesting.current = true
    try {
      if (cameraStatus !== 'granted') {
        const { status, canAskAgain } = await requestCamera()
        telemetry.info('create:permissionRequest', 'Camera permission settled', {
          status,
          canAskAgain,
        })
      }
      if (micStatus !== 'granted') {
        const { status, canAskAgain } = await requestMic()
        telemetry.info('create:permissionRequest', 'Microphone permission settled', {
          status,
          canAskAgain,
        })
      }
    } catch (error) {
      telemetry.warn('create:permissionRequest', 'Recorder permission request failed', {
        error: String(error),
      })
      Alert.alert(
        'Could not request permissions',
        'Try again to allow camera and microphone access.',
      )
    } finally {
      requesting.current = false
    }
  }, [mode, cameraStatus, micStatus, requestCamera, requestMic])

  useEffect(() => {
    if (cameraStatus === 'undetermined' || micStatus === 'undetermined') void requestPermissions()
  }, [cameraStatus, micStatus, requestPermissions])

  return { mode, onPress: mode === 'settings' ? openRecorderSettings : requestPermissions }
}

function permissionMode(camera: PermissionResponse | null, mic: PermissionResponse | null) {
  if (!camera || !mic) return 'loading'
  if (camera.status === 'granted' && mic.status === 'granted') return 'granted'
  if (
    [camera, mic].some((permission) => permission.status === 'denied' && !permission.canAskAgain)
  ) {
    return 'settings'
  }
  return 'request'
}

async function openRecorderSettings() {
  try {
    await Linking.openSettings()
  } catch (error) {
    telemetry.warn('create:permissionGate', 'Could not open app settings', { error: String(error) })
    Alert.alert(
      'Could not open Settings',
      'Open Settings and allow camera and microphone access for Bondfires.',
    )
  }
}
