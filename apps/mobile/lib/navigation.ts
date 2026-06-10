import type { Href } from 'expo-router'

type BackNavigation = {
  canGoBack: () => boolean
}

type BackRouter = {
  back: () => void
  replace: (href: Href) => void
}

export function goBackOrReplace(router: BackRouter, navigation: BackNavigation, fallback: Href) {
  if (navigation.canGoBack()) {
    router.back()
    return
  }

  router.replace(fallback)
}
