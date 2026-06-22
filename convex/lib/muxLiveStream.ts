// Outcome of asking Mux to disable a live stream while reaping a stale session.
//
// A 404 ("LiveStream not found") means the stream is already gone on Mux — for
// reaping purposes that is just as terminal as a successful disable, so we treat
// it as 'missing' instead of an error. Treating 404 as a hard failure is exactly
// what wedged stale sessions in prod: the cron retried the same already-deleted
// stream every 5 minutes forever and never marked the DB row ended.
export type DisableOutcome = 'disabled' | 'missing' | 'error'

export function classifyDisableStatus(httpStatus: number): DisableOutcome {
  if (httpStatus === 404) return 'missing'
  if (httpStatus >= 200 && httpStatus < 300) return 'disabled'
  return 'error'
}
