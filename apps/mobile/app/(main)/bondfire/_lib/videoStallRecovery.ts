/** Reload the same native player without replaying the already-watched prefix. */
export async function reloadVideoAtPosition<Source>({
  player,
  source,
  isCurrent,
  shouldResume,
}: {
  player: {
    currentTime: number
    pause: () => void
    play: () => void
    replaceAsync: (source: Source) => Promise<void>
  }
  source: Source
  isCurrent: () => boolean
  shouldResume: () => boolean
}) {
  if (!isCurrent()) return
  const position = Number.isFinite(player.currentTime) ? Math.max(0, player.currentTime) : 0
  player.pause()
  await player.replaceAsync(source)
  if (!isCurrent()) return
  player.currentTime = position
  if (shouldResume()) player.play()
}

/** Foreground time only. Reset on AppState changes; PiP playback is untouched. */
export function createStallWatchdog({
  isLive,
  canRun,
  onWarn,
  onRecover,
  onGiveUp,
}: {
  isLive: boolean
  canRun: () => boolean
  onWarn: () => void
  onRecover: () => void
  onGiveUp: () => void
}) {
  let timers: ReturnType<typeof setTimeout>[] = []
  const stop = () => {
    for (const timer of timers) clearTimeout(timer)
    timers = []
  }
  const restart = () => {
    stop()
    if (!canRun()) return
    const schedule = (delay: number, callback: () => void) =>
      setTimeout(() => {
        if (canRun()) callback()
      }, delay)
    timers.push(schedule(15_000, onWarn), schedule(isLive ? 75_000 : 45_000, onGiveUp))
    if (!isLive) timers.push(schedule(30_000, onRecover))
  }
  return { restart, stop }
}
