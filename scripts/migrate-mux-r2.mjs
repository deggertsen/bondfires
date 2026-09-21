#!/usr/bin/env node
import { spawn } from 'node:child_process'
// Deployment-key-only operator tool. State/media and secrets must live in an ignored directory.
import { createHash, createSign } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ConvexHttpClient } from 'convex/browser'

const dir = resolve(process.argv[2] ?? 'apps/mobile/build/mux-r2-migration')
const limit = Number(process.argv[3] ?? 1)
const concurrency = Number(process.argv[4] ?? 2)
const secrets = JSON.parse(readFileSync(resolve(dir, 'secrets.json'), 'utf8'))
const deployKey = readFileSync('.env.local', 'utf8')
  .match(/^CONVEX_DEPLOY_KEY=(.+)$/m)?.[1]
  ?.trim()
  .replace(/^['"]|['"]$/g, '')
if (!deployKey?.startsWith('prod:ideal-akita-27|')) throw Error('Main deployment key required')
const client = new ConvexHttpClient('https://ideal-akita-27.convex.cloud')
client.setAdminAuth(deployKey)
const worker = 'https://bondfires-media.yooweb.workers.dev'
const headers = { Authorization: `Bearer ${secrets.MEDIA_WORKER_SECRET}` }
const muxHeaders = {
  Authorization: `Basic ${Buffer.from(`${secrets.MUX_TOKEN_ID}:${secrets.MUX_TOKEN_SECRET}`).toString('base64')}`,
  'Content-Type': 'application/json',
}
const hash = (b) => createHash('sha256').update(b).digest('hex')
const save = (p, data) => writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function retry(fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= 4) throw e
      await sleep(1000 * 2 ** i)
    }
  }
}
async function request(url, options = {}) {
  return retry(async () => {
    const r = await fetch(url, { ...options, signal: AbortSignal.timeout(120000) })
    if (!r.ok) {
      await r.body?.cancel()
      throw Error(
        `HTTP ${r.status} ${options.method ?? 'GET'} ${new URL(url).pathname.split('/').pop()}`,
      )
    }
    return r
  })
}
async function download(url, path) {
  if (existsSync(path)) return
  await retry(async () => {
    const r = await request(url)
    await pipeline(Readable.fromWeb(r.body), createWriteStream(`${path}.part`, { mode: 0o600 }))
    await rename(`${path}.part`, path)
  })
}
async function command(command, args, cwd) {
  return new Promise((res, rej) => {
    const p = spawn(command, args, { cwd })
    let out = ''
    let err = ''
    p.stdout.on('data', (b) => {
      out += b
    })
    p.stderr.on('data', (b) => {
      err = (err + b).slice(-4000)
    })
    p.on('error', rej)
    p.on('exit', (code) =>
      code === 0 ? res(out) : rej(Error(`${command} failed (${code}): ${err}`)),
    )
  })
}
function signedMux(playbackId, audience, options = {}) {
  const enc = (x) => Buffer.from(JSON.stringify(x)).toString('base64url')
  const data = `${enc({ alg: 'RS256', typ: 'JWT', kid: secrets.MUX_SIGNING_KEY_ID })}.${enc({ sub: playbackId, aud: audience, ...options, exp: Math.floor(Date.now() / 1000) + 43200 })}`
  const key = secrets.MUX_SIGNING_PRIVATE_KEY.includes('BEGIN')
    ? secrets.MUX_SIGNING_PRIVATE_KEY
    : Buffer.from(secrets.MUX_SIGNING_PRIVATE_KEY, 'base64').toString()
  return `${data}.${createSign('RSA-SHA256').update(data).sign(key, 'base64url')}`
}
async function asset(id) {
  return (
    await (
      await request(`https://api.mux.com/video/v1/assets/${id}`, { headers: muxHeaders })
    ).json()
  ).data
}
async function source(id, path) {
  let a = await asset(id)
  if (!existsSync(path)) {
    if (!a.master?.url) {
      await request(`https://api.mux.com/video/v1/assets/${id}/master-access`, {
        method: 'PUT',
        headers: muxHeaders,
        body: JSON.stringify({ master_access: 'temporary' }),
      })
      for (let i = 0; i < 120; i++) {
        a = await asset(id)
        if (a.master?.url) break
        await sleep(3000)
      }
    }
    if (!a.master?.url) throw Error('Master not ready')
    await download(a.master.url, path)
  }
  return a
}
async function verifyFile(importId, name, bytes) {
  const sha256 = hash(bytes),
    url = `${worker}/imports/${importId}/${name}`
  await request(url, {
    method: 'PUT',
    headers: { ...headers, 'x-content-sha256': sha256, 'Content-Length': String(bytes.length) },
    body: bytes,
  })
  const copy = await retry(async () =>
    Buffer.from(await (await request(url, { headers })).arrayBuffer()),
  )
  if (hash(copy) !== sha256) throw Error('R2 checksum mismatch')
  return { sha256, size: bytes.length }
}
async function migrate(row) {
  const folder = resolve(dir, row.muxAssetId)
  mkdirSync(folder, { recursive: true })
  const statePath = resolve(folder, `${row._id}.json`)
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath)) : {}
  if (state.complete) return { id: row._id, status: 'already-complete' }
  const importId = await client.mutation('mediaImports:stage', {
    recordId: row._id,
    muxAssetId: row.muxAssetId,
    muxPlaybackId: row.muxPlaybackId,
  })
  save(statePath, { ...state, importId, startedAt: Date.now() })
  const original = resolve(folder, 'source.mp4'),
    a = await source(row.muxAssetId, original)
  const probe = JSON.parse(
    await command('ffprobe', [
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      original,
    ]),
  )
  const video = probe.streams.find((s) => s.codec_type === 'video'),
    audio = probe.streams.find((s) => s.codec_type === 'audio')
  if (!video || !audio) throw Error('Missing video/audio')
  const out = resolve(folder, 'hls')
  mkdirSync(out, { recursive: true })
  if (!existsSync(resolve(out, 'verified.json'))) {
    const compatible =
      video.codec_name === 'h264' && video.pix_fmt === 'yuv420p' && audio.codec_name === 'aac'
    const base = ['-v', 'error', '-xerror', '-y', '-i', original, '-map', '0:v:0', '-map', '0:a:0']
    const packageVideo = async (copy) =>
      command(
        'ffmpeg',
        [
          ...base,
          ...(copy
            ? ['-c', 'copy']
            : [
                '-c:v',
                'libx264',
                '-preset',
                'fast',
                '-crf',
                '18',
                '-maxrate',
                '6M',
                '-bufsize',
                '12M',
                '-pix_fmt',
                'yuv420p',
                '-force_key_frames',
                'expr:gte(t,n_forced*4)',
                '-c:a',
                'aac',
                '-b:a',
                '160k',
              ]),
          '-f',
          'hls',
          '-hls_time',
          '4',
          '-hls_playlist_type',
          'vod',
          '-hls_segment_type',
          'fmp4',
          '-hls_fmp4_init_filename',
          'init.mp4',
          '-hls_segment_filename',
          'segment-%06d.m4s',
          'index.m3u8',
        ],
        out,
      )
    await packageVideo(compatible)
    const valid = () => {
      const playlist = readFileSync(resolve(out, 'index.m3u8'), 'utf8')
      return (
        playlist.includes('#EXT-X-ENDLIST') &&
        [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].every(
          (m) => Number(m[1]) > 0 && Number(m[1]) <= 15,
        ) &&
        readdirSync(out)
          .filter((n) => n.endsWith('.m4s'))
          .every((n) => statSync(resolve(out, n)).size <= 8 * 1024 * 1024)
      )
    }
    if (!valid()) {
      for (const name of readdirSync(out))
        if (name.endsWith('.m4s'))
          await (await import('node:fs/promises')).unlink(resolve(out, name))
      await packageVideo(false)
    }
    if (!valid()) throw Error('Packaging exceeds delivery bounds')
    await command('ffmpeg', [
      '-v',
      'error',
      '-xerror',
      '-i',
      resolve(out, 'index.m3u8'),
      '-fps_mode',
      'passthrough',
      '-enc_time_base:v',
      '1:90000',
      '-f',
      'null',
      '-',
    ])
    const output = JSON.parse(
      await command('ffprobe', [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        resolve(out, 'index.m3u8'),
      ]),
    )
    const duration = Number(output.format.duration)
    if (
      Math.abs(duration - Number(probe.format.duration)) >
      Math.max(1, Number(probe.format.duration) * 0.005)
    )
      throw Error('Duration mismatch')
    save(resolve(out, 'verified.json'), {
      duration,
      sourceDuration: Number(probe.format.duration),
      sourceCodecs: [video.codec_name, audio.codec_name],
      muxDuration: a.duration,
    })
  }
  const token = signedMux(row.muxPlaybackId, 'v'),
    imageToken = signedMux(row.muxPlaybackId, 't'),
    previewToken = signedMux(row.muxPlaybackId, 'g', { width: 320, fps: 5, start: 0, end: 3 })
  const caption = a.tracks.find(
    (t) => t.type === 'text' && t.text_type === 'subtitles' && t.status === 'ready',
  )
  if (!caption) throw Error('Expected captions missing')
  await download(
    `https://stream.mux.com/${row.muxPlaybackId}/text/${caption.id}.vtt?token=${token}`,
    resolve(out, 'captions.vtt'),
  )
  if (!readFileSync(resolve(out, 'captions.vtt'), 'utf8').startsWith('WEBVTT'))
    throw Error('Invalid captions')
  await download(
    `https://image.mux.com/${row.muxPlaybackId}/thumbnail.jpg?token=${imageToken}`,
    resolve(out, 'thumbnail.jpg'),
  )
  const previewPath = resolve(out, 'preview.gif')
  if (existsSync(previewPath) && statSync(previewPath).size > 8 * 1024 * 1024) await rm(previewPath)
  await download(
    `https://image.mux.com/${row.muxPlaybackId}/animated.gif?token=${previewToken}`,
    resolve(out, 'preview.gif'),
  )
  const files = {},
    archive = [],
    sourceHash = createHash('sha256')
  // Preserve the complete master as bounded, ordered parts; the manifest permits byte-exact reconstruction.
  const f = await open(original, 'r')
  let offset = 0,
    index = 0
  try {
    while (true) {
      const bytes = Buffer.alloc(8 * 1024 * 1024)
      const { bytesRead } = await f.read(bytes, 0, bytes.length, offset)
      if (!bytesRead) break
      const part = bytes.subarray(0, bytesRead)
      sourceHash.update(part)
      const name = `archive-${String(index++).padStart(6, '0')}.bin`
      archive.push({ name, ...(await verifyFile(importId, name, part)) })
      offset += bytesRead
    }
  } finally {
    await f.close()
  }
  const names = readdirSync(out)
    .filter((name) => name !== 'verified.json')
    .sort()
  // Await each bounded batch even on failure; filename order keeps manifests deterministic.
  for (let start = 0; start < names.length; start += 4) {
    const batch = names.slice(start, start + 4)
    const outcomes = await Promise.allSettled(
      batch.map(async (name) => verifyFile(importId, name, await readFile(resolve(out, name)))),
    )
    for (const [index, result] of outcomes.entries()) {
      if (result.status === 'rejected') throw result.reason
      files[batch[index]] = result.value
    }
  }
  const verification = JSON.parse(readFileSync(resolve(out, 'verified.json')))
  const manifest = {
    version: 1,
    sourceAssetId: row.muxAssetId,
    sourceSha256: sourceHash.digest('hex'),
    sourceSize: offset,
    archive,
    files,
    ...verification,
  }
  const bytes = Buffer.from(JSON.stringify(manifest))
  await verifyFile(importId, 'manifest.json', bytes)
  save(resolve(folder, 'manifest.json'), manifest)
  await client.mutation('mediaImports:activate', {
    importId,
    manifestChecksum: hash(bytes),
    duration: verification.duration,
  })
  save(statePath, {
    importId,
    complete: true,
    completedAt: Date.now(),
    manifestChecksum: hash(bytes),
    duration: verification.duration,
  })
  await rm(original)
  await rm(out, { recursive: true })
  return { id: row._id, status: 'migrated', seconds: verification.duration, bytes: offset }
}
const rows = JSON.parse(readFileSync(resolve(dir, 'inventory.json'))).slice(0, limit)
let stopping = false
process.on('SIGTERM', () => {
  stopping = true
})
process.on('SIGINT', () => {
  stopping = true
})
let cursor = 0
const results = []
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (cursor < rows.length && !stopping) {
      const row = rows[cursor++]
      try {
        const r = await migrate(row)
        results.push(r)
        console.info(JSON.stringify(r))
      } catch (e) {
        const r = {
          id: row._id,
          status: 'failed',
          error: e.message.replace(/https?:\/\/\S+/g, '[URL]'),
        }
        results.push(r)
        console.info(JSON.stringify(r))
      }
      save(resolve(dir, 'results.json'), results)
    }
  }),
)
console.info(
  JSON.stringify({
    processed: results.length,
    failed: results.filter((r) => r.status === 'failed').length,
  }),
)
if (results.some((r) => r.status === 'failed')) process.exitCode = 1

if (stopping) process.exitCode = 130
