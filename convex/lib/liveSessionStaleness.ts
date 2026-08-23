const DURABLE_LIVE_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1_000 + 15 * 60 * 1_000

export function shouldReapLiveSession(args: {
  status: 'created' | 'starting' | 'live' | 'ending' | 'ended' | 'errored'
  createdAt: number
  updatedAt: number
  localBackupAvailable?: boolean
  now: number
  staleAfterMs: number
  pendingMaxAgeMs: number
}): boolean {
  if (args.status === 'ended' || args.status === 'errored') {
    return false
  }

  const ageMs = args.now - args.createdAt

  // A Mux-confirmed live stream is real recording activity, not a client
  // heartbeat. Likewise, positive local-backup evidence means native capture
  // can be healthy while React Native is suspended before Mux marks it live.
  // Mux enforces a 12-hour absolute stream cap; the extra window allows its
  // terminal webhook/reconciler to settle without reaping active capture.
  if (
    args.status === 'live' ||
    (args.localBackupAvailable && (args.status === 'created' || args.status === 'starting'))
  ) {
    return ageMs > DURABLE_LIVE_SESSION_MAX_AGE_MS
  }

  if (args.status === 'created' && ageMs > args.pendingMaxAgeMs) {
    return true
  }

  return args.now - args.updatedAt > args.staleAfterMs
}
