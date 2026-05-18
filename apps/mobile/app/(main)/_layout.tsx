import { Stack } from 'expo-router'

export default function MainLayout() {
  // Keep tabs as the main surface, and push conversation screens on top.
  // This avoids the "hidden tab screen" pattern which breaks back navigation clarity.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="bondfire/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="camp/[id]" options={{ headerShown: false }} />
    </Stack>
  )
}
