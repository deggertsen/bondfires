import {
  createPermissionHook,
  type PermissionResponse,
  requireNativeModule,
  requireOptionalNativeModule,
} from 'expo'

// Expo Camera's CameraX dependencies select a viewfinder incompatible with
// StreamPack. ImagePicker already exposes the same Android camera permission.
export { useCameraPermissions } from 'expo-image-picker'

type MicrophonePermissions = {
  getMicrophonePermissionsAsync(): Promise<PermissionResponse>
  requestMicrophonePermissionsAsync(): Promise<PermissionResponse>
}

function microphonePermissions(): MicrophonePermissions {
  const publisher = requireOptionalNativeModule<MicrophonePermissions>('BondfireLivePublisher')
  // Older development clients provide these methods through ExpoCamera.
  return publisher?.getMicrophonePermissionsAsync
    ? publisher
    : requireNativeModule<MicrophonePermissions>('ExpoCamera')
}

export const useMicrophonePermissions = createPermissionHook({
  getMethod: () => microphonePermissions().getMicrophonePermissionsAsync(),
  requestMethod: () => microphonePermissions().requestMicrophonePermissionsAsync(),
})
