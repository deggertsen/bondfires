/**
 * Minimal WebVTT support for the caption overlay: Mux serves auto-generated
 * captions as simple cue blocks (timestamp line + text lines). Cues are
 * matched against playback position on every player timeUpdate, so lookup is
 * a binary search over the (already time-ordered) cue list.
 */

export type CaptionCue = {
  startMs: number
  endMs: number
  text: string
}

// "hh:mm:ss.mmm" or "mm:ss.mmm" (hours optional per the WebVTT spec).
const VTT_TIMESTAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/

function parseTimestampMs(value: string): number | null {
  const match = value.match(VTT_TIMESTAMP)
  if (!match) return null
  const [, hours, minutes, seconds, millis] = match
  return (
    (Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 + Number(millis)
  )
}

export function parseWebVtt(vtt: string): CaptionCue[] {
  const cues: CaptionCue[] = []
  const blocks = vtt.replace(/\r\n?/g, '\n').split(/\n{2,}/)

  for (const block of blocks) {
    const lines = block.split('\n')
    const timingIndex = lines.findIndex((line) => line.includes('-->'))
    // Blocks without a timing line (WEBVTT header, NOTE, STYLE) aren't cues.
    if (timingIndex === -1) continue

    const [startRaw, endRaw] = lines[timingIndex].split('-->')
    const startMs = parseTimestampMs(startRaw)
    const endMs = parseTimestampMs(endRaw ?? '')
    if (startMs === null || endMs === null || endMs <= startMs) continue

    const text = lines
      .slice(timingIndex + 1)
      .join('\n')
      // Strip cue markup (<c>, <v Speaker>, <b>, timestamps) — we render plain text.
      .replace(/<[^>]*>/g, '')
      .trim()
    if (!text) continue

    cues.push({ startMs, endMs, text })
  }

  return cues
}

/** The text of the cue covering positionMs, or '' between cues. */
export function findCaptionText(cues: readonly CaptionCue[], positionMs: number): string {
  let low = 0
  let high = cues.length - 1

  while (low <= high) {
    const mid = (low + high) >> 1
    const cue = cues[mid]
    if (positionMs < cue.startMs) {
      high = mid - 1
    } else if (positionMs >= cue.endMs) {
      low = mid + 1
    } else {
      return cue.text
    }
  }

  return ''
}

export async function fetchCaptionCues(url: string): Promise<CaptionCue[]> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Caption fetch failed: ${response.status}`)
  }

  return parseWebVtt(await response.text())
}
