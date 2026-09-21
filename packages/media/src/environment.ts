const INTERNAL = 'https://lovely-malamute-525.convex.cloud'
const PRODUCTION = 'https://ideal-akita-27.convex.cloud'

/** The internal experiment's legacy flag must never enable production. */
export function mediaBackendEnabled(
  cloudUrl: string | undefined,
  enabled: string | undefined,
  internalEnabled: string | undefined,
): boolean {
  if (cloudUrl === PRODUCTION) return enabled === '1'
  return cloudUrl === INTERNAL && (enabled === '1' || internalEnabled === '1')
}

export function mediaClientEnabled(
  environment: string | undefined,
  cloudUrl: string | undefined,
  enabled: string | undefined,
): boolean {
  return (
    enabled === '1' &&
    ((environment === 'production' && cloudUrl === PRODUCTION) ||
      (environment === 'internal' && cloudUrl === INTERNAL))
  )
}
