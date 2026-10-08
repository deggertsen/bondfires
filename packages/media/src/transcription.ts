/** Bound AI calls by actual fragment boundaries, bytes, and duration. */
export const TRANSCRIPTION_WINDOW_SEGMENTS = 32
export function transcriptionWindow(
  segments: readonly { index: number; duration: number; size: number }[],
  cursor: number,
  // The absolute time at cursor replaces rescanning every preceding segment.
  timing: { cursorTime: number; segmentCount: number },
) {
  const { cursorTime, segmentCount } = timing
  if (
    !Number.isInteger(cursor) ||
    cursor < 0 ||
    cursor >= segmentCount ||
    !Number.isFinite(cursorTime) ||
    cursorTime < 0
  )
    throw Error('Invalid cursor')
  const base = Math.max(0, cursor - 1)
  const limit = Math.min(segmentCount, cursor + TRANSCRIPTION_WINDOW_SEGMENTS)
  // The caller supplies one previous fragment plus at most 32 forward fragments.
  // Requiring a contiguous range prevents missing fragments from shifting captions.
  if (
    segments.length !== limit - base ||
    segments.some(
      (s, i) =>
        s.index !== base + i ||
        !Number.isFinite(s.duration) ||
        s.duration <= 0 ||
        !Number.isFinite(s.size) ||
        s.size <= 0,
    )
  )
    throw Error('Invalid timeline')
  const at = (index: number) => segments[index - base]
  // Include context on both sides; each word belongs to only one window.
  const start =
    cursor > 0 && at(cursor - 1).size + at(cursor).size <= 12 * 1024 * 1024 ? cursor - 1 : cursor
  let end = start,
    bytes = 0,
    seconds = 0
  while (end < segmentCount && end - start < TRANSCRIPTION_WINDOW_SEGMENTS) {
    const next = at(end)
    if (end > cursor && (bytes + next.size > 12 * 1024 * 1024 || seconds + next.duration > 30))
      break
    bytes += next.size
    seconds += next.duration
    end++
  }
  const nextIndex = end < segmentCount && end > cursor + 1 ? end - 1 : end
  const timeAt = (index: number) =>
    cursorTime +
    segments
      .filter((s) => s.index >= cursor && s.index < index)
      .reduce((sum, s) => sum + s.duration, 0)
  return {
    startIndex: start,
    endIndex: end,
    nextIndex,
    startTime: cursorTime - (start < cursor ? at(start).duration : 0),
    ownedStart: cursorTime,
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

export type MediaProbe = {
  status:
    | 'not_probed'
    | 'ok'
    | 'invalid_mp4'
    | 'missing_audio'
    | 'zero_duration'
    | 'unsupported_codec'
  audioCodec?: string
  duration?: number
}
export type TranscriptionFailure = {
  reason: string
  name: string
  message: string
  probe: MediaProbe
}
export class TranscriptionError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly probe: MediaProbe = { status: 'not_probed' },
  ) {
    super(message)
    this.name = 'TranscriptionError'
  }
}
export function isTerminalTranscriptionFailure(reason: string) {
  return ['missing_audio', 'zero_duration', 'unsupported_codec'].includes(reason)
}
/** No stacks, URLs, credentials, transcripts, or unbounded provider response bodies. */
function diagnosticText(value: string, limit: number) {
  return value
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9+/=_-]{64,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}
/** Both successful responses and failures use the same bounded probe contract. */
export function readMediaProbe(probe: unknown): MediaProbe | undefined {
  if (!probe || typeof probe !== 'object' || !('status' in probe)) return
  const status = probe.status
  if (
    status !== 'not_probed' &&
    status !== 'ok' &&
    status !== 'invalid_mp4' &&
    status !== 'missing_audio' &&
    status !== 'zero_duration' &&
    status !== 'unsupported_codec'
  )
    return
  const result: MediaProbe = { status }
  if ('audioCodec' in probe && typeof probe.audioCodec === 'string')
    result.audioCodec = diagnosticText(probe.audioCodec, 32)
  if (
    'duration' in probe &&
    typeof probe.duration === 'number' &&
    Number.isFinite(probe.duration) &&
    probe.duration >= 0 &&
    probe.duration <= Number.MAX_SAFE_INTEGER / 1000
  )
    result.duration = Math.round(probe.duration * 1000) / 1000
  return result
}
function failureReason(reason: string, probe: MediaProbe) {
  const normalized = diagnosticText(reason, 64)
  // Check the final value: trimming must not promote unconfirmed text to terminal evidence.
  return isTerminalTranscriptionFailure(normalized) && normalized !== probe.status
    ? 'transcription_error'
    : normalized
}
export function normalizeTranscriptionFailure(
  error: unknown,
  probe: MediaProbe = { status: 'not_probed' },
): TranscriptionFailure {
  const media = readMediaProbe(error instanceof TranscriptionError ? error.probe : probe) ?? {
    status: 'not_probed',
  }
  return {
    reason: failureReason(
      error instanceof TranscriptionError ? error.reason : 'transcription_error',
      media,
    ),
    name: diagnosticText(error instanceof Error ? error.name : 'UnknownError', 64),
    message: diagnosticText(
      error instanceof Error ? error.message : 'Unknown transcription failure',
      240,
    ),
    probe: media,
  }
}
/** Treat only the Worker's small, structured envelope as diagnostic evidence. */
export function readTranscriptionFailure(value: unknown): TranscriptionFailure | undefined {
  if (!value || typeof value !== 'object' || !('failure' in value)) return
  const failure = value.failure
  if (
    !failure ||
    typeof failure !== 'object' ||
    !('reason' in failure) ||
    typeof failure.reason !== 'string' ||
    !('name' in failure) ||
    typeof failure.name !== 'string' ||
    !('message' in failure) ||
    typeof failure.message !== 'string' ||
    !('probe' in failure)
  )
    return
  const probe = readMediaProbe(failure.probe)
  if (!probe) return
  return {
    reason: failureReason(failure.reason, probe),
    name: diagnosticText(failure.name, 64),
    message: diagnosticText(failure.message, 240),
    probe,
  }
}

/** Proxy errors may be HTML, chunked, or huge. Inspect at most 2 KiB of JSON. */
export async function readTranscriptionFailureResponse(response: Response) {
  if (!response.headers.get('content-type')?.includes('application/json') || !response.body) return
  const reader = response.body.getReader()
  const bytes = new Uint8Array(2048)
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (length + value.length > bytes.length) return
      bytes.set(value, length)
      length += value.length
    }
    return readTranscriptionFailure(JSON.parse(new TextDecoder().decode(bytes.subarray(0, length))))
  } catch {
    return undefined
  } finally {
    // An errored stream rejects cancel too; cleanup must not replace the HTTP failure.
    try {
      await reader.cancel()
    } catch {
      // Diagnostic evidence is optional when the upstream response is interrupted.
    } finally {
      reader.releaseLock()
    }
  }
}
