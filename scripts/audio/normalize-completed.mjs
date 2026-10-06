/** Offline prototype for a future completed-R2 compute job. Requires Node 22.18+ and FFmpeg.
 * Usage: node scripts/audio/normalize-completed.mjs completed-local.m3u8 output.mp4
 * Writes only a separate local derivative; never rewrites source fragments or publishes.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { constants, copyFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  normalizationFilter,
  verifyNormalizedAudio,
} from '../../infrastructure/media/src/normalization.ts'
import { LOUDNESS, programGain } from '../../packages/media/src/loudness.ts'
import { readCompletedPlaylist } from './completed-playlist.mjs'

export function ffmpeg(args) {
  return execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-xerror', ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function runWithMeasurement(path, expectedDuration) {
  // spawnSync retains stderr on successful executions too.
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-xerror',
      '-protocol_whitelist',
      'file',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-af',
      `aresample=48000,astats=measure_perchannel=none:measure_overall=Number_of_samples,loudnorm=I=${LOUDNESS.integratedLufs}:TP=${LOUDNESS.truePeakDbtp}:print_format=json`,
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
  // Some decoders can drop damaged/empty AAC packets with a successful exit.
  // Count decoded samples, not container timestamps (which can span holes).
  const samples = Number(/Number of samples: (\d+)/.exec(result.stderr)?.[1])
  const durationSeconds = samples / 48000
  // Allow AAC priming/padding and a small audio/video endpoint difference.
  if (!Number.isFinite(durationSeconds) || Math.abs(durationSeconds - expectedDuration) > 0.1)
    throw new Error('Decoded audio duration does not match the completed program')
  return {
    integratedLufs: Number(data.input_i),
    truePeakDbtp: Number(data.input_tp),
    durationSeconds,
  }
}

export function normalizeCompleted(playlist, output) {
  const input = resolve(playlist)
  const { duration } = readCompletedPlaylist(input)
  // Fail before expensive decode/encode, including dangling output symlinks.
  if (lstatSync(resolve(output), { throwIfNoEntry: false }))
    throw new Error('Output already exists')
  const before = runWithMeasurement(input, duration)
  const filter = normalizationFilter(before, true)
  const scratch = mkdtempSync(join(tmpdir(), 'bondfires-normalization-'))
  const candidate = join(scratch, 'normalized.mp4')
  try {
    ffmpeg([
      '-n',
      '-protocol_whitelist',
      'file',
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
    const after = runWithMeasurement(candidate, before.durationSeconds)
    if (!verifyNormalizedAudio(before, after)) throw new Error('Encoded audio failed verification')
    copyFileSync(candidate, resolve(output), constants.COPYFILE_EXCL)
    return {
      before,
      after,
      gainDb: programGain(before, true),
      target: LOUDNESS,
      output: resolve(output),
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , input, output] = process.argv
  if (!input || !output)
    throw new Error('Usage: normalize-completed.mjs local-completed.m3u8 output.mp4')
  process.stdout.write(`${JSON.stringify(normalizeCompleted(input, output), null, 2)}\n`)
}
