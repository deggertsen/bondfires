/** Bound AI calls by actual fragment boundaries, bytes, and duration. */
export function transcriptionWindow(
  segments: readonly { index: number; duration: number; size: number }[],
  cursor: number,
) {
  const media = segments.filter((s) => s.index >= 0).sort((a, b) => a.index - b.index)
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= media.length)
    throw Error('Invalid cursor')
  if (media.some((s, i) => s.index !== i || s.duration <= 0 || s.size <= 0))
    throw Error('Invalid timeline')
  // Include context on both sides; each word belongs to only one window.
  const start =
    cursor > 0 && media[cursor - 1].size + media[cursor].size <= 12 * 1024 * 1024
      ? cursor - 1
      : cursor
  let end = start,
    bytes = 0,
    seconds = 0
  while (end < media.length && end - start < 32) {
    const next = media[end]
    if (end > cursor && (bytes + next.size > 12 * 1024 * 1024 || seconds + next.duration > 30))
      break
    bytes += next.size
    seconds += next.duration
    end++
  }
  const nextIndex = end < media.length && end > cursor + 1 ? end - 1 : end
  const timeAt = (index: number) => media.slice(0, index).reduce((sum, s) => sum + s.duration, 0)
  return {
    startIndex: start,
    endIndex: end,
    nextIndex,
    startTime: timeAt(start),
    ownedStart: timeAt(cursor),
    ownedEnd: timeAt(nextIndex),
    duration: seconds,
  }
}
export type SpeechSegment = {
  start?: number
  end?: number
  text?: string
  no_speech_prob?: number
  words?: { start?: number; end?: number; word?: string }[]
}
export type CaptionCue = { start: number; end: number; text: string }
export function speechCues(
  segments: readonly SpeechSegment[],
  window: { startTime: number; ownedStart: number; ownedEnd: number },
): CaptionCue[] {
  const words = segments
    .filter((s) => (s.no_speech_prob ?? 0) < 0.6)
    .flatMap((s) =>
      s.words?.length ? s.words.map((w) => ({ start: w.start, end: w.end, text: w.word })) : [s],
    )
  const cues: CaptionCue[] = []
  for (const word of words) {
    if (
      typeof word.start !== 'number' ||
      typeof word.end !== 'number' ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end)
    )
      continue
    const start = word.start + window.startTime,
      end = word.end + window.startTime
    const middle = (start + end) / 2
    if (end <= start || middle < window.ownedStart || middle >= window.ownedEnd) continue
    const text = word.text?.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const previous = cues.at(-1)
    if (
      previous &&
      end - previous.start <= 3 &&
      previous.text.length + text.length < 70 &&
      start - previous.end < 0.8
    ) {
      previous.text += ` ${text}`
      previous.end = Math.min(end, window.ownedEnd)
    } else
      cues.push({
        start: Math.max(start, window.ownedStart, previous?.end ?? 0),
        end: Math.min(end, window.ownedEnd),
        text,
      })
  }
  return cues.filter((cue) => cue.end > cue.start)
}
function timestamp(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}
export function cuesToVtt(cues: readonly CaptionCue[]) {
  return cues
    .map(
      (cue) =>
        `${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n\n`,
    )
    .join('')
}
