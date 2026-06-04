const PERSONAL_BONDFIRE_INVITE_ROUTE = /^\/(?:\(main\)\/)?personal-bondfire\/[^/?#]+\/[^/?#]+$/

export function getAuthRedirectPath(redirectTo: string | string[] | undefined): string | null {
  const value = Array.isArray(redirectTo) ? redirectTo[0] : redirectTo
  if (!value) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return null
  }

  if (!PERSONAL_BONDFIRE_INVITE_ROUTE.test(decoded)) {
    return null
  }

  return decoded.startsWith('/(main)/') ? decoded : `/(main)${decoded}`
}
