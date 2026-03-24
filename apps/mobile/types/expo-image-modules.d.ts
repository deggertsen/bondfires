declare module 'expo-image-manipulator' {
  export const SaveFormat: {
    JPEG: 'jpeg'
    PNG: 'png'
    WEBP: 'webp'
  }

  export function manipulateAsync(
    uri: string,
    actions: Array<{ resize?: { width?: number; height?: number } }>,
    saveOptions?: {
      compress?: number
      format?: (typeof SaveFormat)[keyof typeof SaveFormat]
    },
  ): Promise<{ uri: string }>
}

declare module 'expo-image-picker' {
  export function launchImageLibraryAsync(options?: {
    mediaTypes?: string[]
    allowsEditing?: boolean
    aspect?: [number, number]
    quality?: number
  }): Promise<{
    canceled: boolean
    assets: Array<{ uri: string }>
  }>
}
