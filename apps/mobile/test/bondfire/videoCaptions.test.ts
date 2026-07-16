import { describe, expect, it } from 'vitest'
import { findCaptionText, parseWebVtt } from '../../app/(main)/bondfire/_lib/videoCaptions'

const MUX_STYLE_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.480
Hey everybody, just checking in

00:00:02.480 --> 00:00:05.120
after the soccer game today.

00:01:02.900 --> 00:01:04.000
Bye!
`

describe('parseWebVtt', () => {
  it('parses Mux-style cue blocks', () => {
    const cues = parseWebVtt(MUX_STYLE_VTT)
    expect(cues).toEqual([
      { startMs: 0, endMs: 2480, text: 'Hey everybody, just checking in' },
      { startMs: 2480, endMs: 5120, text: 'after the soccer game today.' },
      { startMs: 62900, endMs: 64000, text: 'Bye!' },
    ])
  })

  it('handles hour-long timestamps, CRLF, cue ids, and settings', () => {
    const vtt = 'WEBVTT\r\n\r\n1\r\n01:02:03.500 --> 01:02:04.000 align:center\r\nOne hour in\r\n'
    expect(parseWebVtt(vtt)).toEqual([{ startMs: 3723500, endMs: 3724000, text: 'One hour in' }])
  })

  it('strips cue markup and skips non-cue blocks', () => {
    const vtt = `WEBVTT

NOTE this is a comment

00:00:01.000 --> 00:00:02.000
<v Dave><b>Hello</b> there</v>

00:00:03.000 --> 00:00:02.000
inverted timing is dropped
`
    expect(parseWebVtt(vtt)).toEqual([{ startMs: 1000, endMs: 2000, text: 'Hello there' }])
  })

  it('joins multi-line cue text', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nline one\nline two\n'
    expect(parseWebVtt(vtt)[0].text).toBe('line one\nline two')
  })
})

describe('findCaptionText', () => {
  const cues = parseWebVtt(MUX_STYLE_VTT)

  it('finds the cue covering a position', () => {
    expect(findCaptionText(cues, 0)).toBe('Hey everybody, just checking in')
    expect(findCaptionText(cues, 2479)).toBe('Hey everybody, just checking in')
    expect(findCaptionText(cues, 2480)).toBe('after the soccer game today.')
    expect(findCaptionText(cues, 63000)).toBe('Bye!')
  })

  it('returns empty between cues and outside the range', () => {
    expect(findCaptionText(cues, 10_000)).toBe('')
    expect(findCaptionText(cues, 999_999)).toBe('')
    expect(findCaptionText([], 0)).toBe('')
  })
})
