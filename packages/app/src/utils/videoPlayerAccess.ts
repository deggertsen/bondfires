/**
 * Expo shared objects throw synchronously when JavaScript touches them after
 * their native counterpart has been released. Keep that platform-specific
 * failure at the player boundary instead of scattering try/catch blocks
 * through playback code.
 */
export function safelyUsePlayer<TPlayer, TResult>(
  player: TPlayer | null | undefined,
  operation: (player: TPlayer) => TResult,
): TResult | undefined {
  if (!player) return undefined

  try {
    return operation(player)
  } catch {
    return undefined
  }
}

/**
 * Runs an operation only when an async callback still belongs to the current
 * native player instance. useVideoPlayer releases and replaces its shared
 * object whenever the source changes, even if the component stays mounted.
 */
export function safelyUseCurrentPlayer<TPlayer, TResult>(
  currentPlayer: TPlayer | null | undefined,
  expectedPlayer: TPlayer,
  operation: (player: TPlayer) => TResult,
): TResult | undefined {
  if (currentPlayer !== expectedPlayer) return undefined
  return safelyUsePlayer(expectedPlayer, operation)
}
