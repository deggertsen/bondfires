/** Offline prototype for a future completed-R2 compute job. Requires Node 22.18+ and FFmpeg.
 * Usage: node scripts/audio/normalize-completed.mjs completed-local.m3u8 output.mp4
 * Writes only a separate local derivative; never rewrites source fragments or publishes.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { constants, copyFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  normalizationFilter,
  verifyNormalizedAudio,
} from '../../infrastructure/media/src/normalization.ts'
import { LOUDNESS, programGain } from '../../packages/media/src/loudness.ts'

export function ffmpeg(args) {
  return execFileSync('ffmpeg', ['-hide_banner', '-nostdin', ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function runWithMeasurement(path) {
  // spawnSync retains stderr on successful executions too.
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-protocol_whitelist',
      'file,crypto',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-af',
      `loudnorm=I=${LOUDNESS.integratedLufs}:TP=${LOUDNESS.truePeakDbtp}:print_format=json`,
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 },
  )
  if (result.error || result.status !== 0)
    throw new Error('FFmpeg measurement failed', { cause: result.error })
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(result.stderr)?.[0]
  if (!json) throw new Error('Missing loudness measurement')
  const data = JSON.parse(json)
  return { integratedLufs: Number(data.input_i), truePeakDbtp: Number(data.input_tp) }
}

export function normalizeCompleted(playlist, output) {
  const input = resolve(playlist)
  const manifest = readFileSync(input, 'utf8')
  if (!manifest.split(/\r?\n/).includes('#EXT-X-ENDLIST'))
    throw new Error('Recording is still growing')
  // Accept only our downloaded local fMP4 layout, never remote/nested playlists.
  const lines = manifest.split(/\r?\n/)
  const segments = lines.filter((line) => line && !line.startsWith('#'))
  if (
    !segments.length ||
    segments.length > 1800 ||
    segments.some((line, index) => line !== `segment-${String(index).padStart(6, '0')}.m4s`) ||
    lines.filter((line) => line.startsWith('#EXT-X-MAP:')).join('') !==
      '#EXT-X-MAP:URI="init.mp4"' ||
    lines.some((line) => line.startsWith('#EXT-X-KEY:'))
  )
    throw new Error('Expected local completed fMP4 playlist')
  const durations = lines
    .filter((line) => line.startsWith('#EXTINF:'))
    .map((line) => Number(line.slice(8).replace(/,$/, '')))
  if (
    durations.length !== segments.length ||
    durations.some((value) => !Number.isFinite(value) || value <= 0 || value > 15) ||
    durations.reduce((sum, value) => sum + value, 0) > 3615
  )
    throw new Error('Invalid recording duration')
  for (const name of ['init.mp4', ...segments]) {
    if (
      statSync(join(resolve(input, '..'), name)).size >
      (name === 'init.mp4' ? 256 * 1024 : 8 * 1024 * 1024)
    )
      throw new Error('Oversized source fragment')
  }
  const before = runWithMeasurement(input)
  const filter = normalizationFilter(before, true)
  const scratch = mkdtempSync(join(tmpdir(), 'bondfires-normalization-'))
  const candidate = join(scratch, 'normalized.mp4')
  ffmpeg([
    '-n',
    '-protocol_whitelist',
    'file,crypto',
    '-i',
    input,
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0',
    '-c:v',
    'copy',
    '-af',
    filter,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    candidate,
  ])
  const after = runWithMeasurement(candidate)
  if (!verifyNormalizedAudio(before, after))
    throw new Error(`Encoded audio failed verification; candidate retained at ${candidate}`)
  copyFileSync(candidate, resolve(output), constants.COPYFILE_EXCL)
  return {
    before,
    after,
    gainDb: programGain(before, true),
    target: LOUDNESS,
    output: resolve(output),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , input, output] = process.argv
  if (!input || !output)
    throw new Error('Usage: normalize-completed.mjs local-completed.m3u8 output.mp4')
  process.stdout.write(`${JSON.stringify(normalizeCompleted(input, output), null, 2)}\n`)
}
