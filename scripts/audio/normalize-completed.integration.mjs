/** Explicit FFmpeg integration gate; no downloaded or production media. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ffmpeg, normalizeCompleted } from './normalize-completed.mjs'

function fixture(t, silence = false) {
  const directory = mkdtempSync(join(tmpdir(), 'normalization-integration-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const input = join(directory, 'index.m3u8')
  const output = join(directory, 'output.mp4')
  ffmpeg([
    '-v',
    'error',
    '-n',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=10:duration=8',
    '-f',
    'lavfi',
    '-i',
    silence
      ? 'anullsrc=r=48000:cl=mono:d=8'
      : 'aevalsrc=0.018*sin(2*PI*1000*t)*(0.6+0.4*sin(2*PI*0.5*t)):s=48000:d=8',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '40',
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-f',
    'hls',
    '-hls_segment_type',
    'fmp4',
    '-hls_time',
    '4',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    join(directory, 'segment-%06d.m4s'),
    input,
  ])
  return { directory, input, output }
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function streams(path) {
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path], {
      encoding: 'utf8',
      timeout: 120_000,
    }),
  ).streams
}

function videoHash(path) {
  return ffmpeg(['-v', 'error', '-i', path, '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-'])
}

test('normalizes completed audio/video, preserves video/timing and leaves sources immutable', (t) => {
  const { directory, input, output } = fixture(t)
  const originals = readdirSync(directory).map((name) => [name, digest(join(directory, name))])
  const result = normalizeCompleted(input, output)
  assert.ok(Math.abs(result.after.integratedLufs + 16) <= 0.5)
  assert.ok(result.after.truePeakDbtp <= -1.5)
  assert.ok(result.gainDb > 20 && result.gainDb <= 30)
  assert.equal(videoHash(input), videoHash(output))
  const before = streams(input)
  const after = streams(output)
  for (const type of ['video', 'audio']) {
    const source = before.find((stream) => stream.codec_type === type)
    const encoded = after.find((stream) => stream.codec_type === type)
    assert.ok(source && encoded)
    assert.ok(Math.abs(Number(encoded.duration) - 8) < 0.06, `${type} duration`)
  }
  const audio = after.find((stream) => stream.codec_type === 'audio')
  const video = after.find((stream) => stream.codec_type === 'video')
  const originalAudio = before.find((stream) => stream.codec_type === 'audio')
  const originalVideo = before.find((stream) => stream.codec_type === 'video')
  const originalOffset = Number(originalAudio.start_time) - Number(originalVideo.start_time)
  const encodedOffset = Number(audio.start_time) - Number(video.start_time)
  assert.ok(Math.abs(originalOffset - encodedOffset) < 0.03, 'audio/video start alignment')
  for (const [name, hash] of originals) assert.equal(digest(join(directory, name)), hash)
  const outputHash = digest(output)
  assert.throws(() => normalizeCompleted(input, output), /Output already exists/)
  assert.equal(digest(output), outputHash)
})

test('refuses an empty fragment instead of publishing a partial recording', (t) => {
  const { directory, input, output } = fixture(t)
  writeFileSync(join(directory, 'segment-000001.m4s'), '')
  assert.throws(() => normalizeCompleted(input, output), /regular source file/)
  assert.equal(existsSync(output), false)
})

test('refuses silence without publishing output', (t) => {
  const { input, output } = fixture(t, true)
  assert.throws(() => normalizeCompleted(input, output), /measurable audio/)
  assert.equal(existsSync(output), false)
})

test('fails closed on decoder errors instead of normalizing the surviving media', (t) => {
  const { directory, input, output } = fixture(t)
  const fragment = join(directory, 'segment-000001.m4s')
  // Preserve the MP4 tables but destroy the encoded payload, so size checks
  // pass and the real decoder must reject it.
  const bytes = readFileSync(fragment)
  const payload = bytes.indexOf(Buffer.from('mdat')) + 4
  assert.ok(payload > 4)
  bytes.fill(0xff, payload)
  writeFileSync(fragment, bytes)
  assert.throws(
    () => normalizeCompleted(input, output),
    /FFmpeg measurement failed|Decoded audio duration/,
  )
  assert.equal(existsSync(output), false)
})

test('checks decoded duration instead of trusting playlist timing', (t) => {
  const { input, output } = fixture(t)
  writeFileSync(
    input,
    readFileSync(input, 'utf8').replaceAll('#EXTINF:4.000000,', '#EXTINF:1.000000,'),
  )
  assert.throws(() => normalizeCompleted(input, output), /Decoded audio duration/)
  assert.equal(existsSync(output), false)
})
