#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeFingerprint,
  splitFingerprints,
  validateAasa,
  validateAppLinksContract,
  validateAssetLinks,
  validateExpoAppLinks,
  validateFingerprint,
} from './lib/app-links.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const contract = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'apps/mobile/app-links.json'), 'utf8'),
)
const expo = JSON.parse(readFileSync(resolve(repositoryRoot, 'apps/mobile/app.json'), 'utf8')).expo
const live = process.argv.includes('--live')
const errors = [...validateAppLinksContract(contract), ...validateExpoAppLinks(expo, contract)]

function fail(message) {
  errors.push(message)
}

async function fetchWithoutRedirect(url) {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'Bondfires-App-Links-Preflight/1.0' },
  })
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${url} redirects to ${response.headers.get('location') ?? 'an unknown URL'}`)
  }
  return response
}

async function fetchAssociationFile(host, fileName) {
  const url = `https://${host}/.well-known/${fileName}`
  const response = await fetchWithoutRedirect(url)
  if (response.status !== 200) throw new Error(`${url} returned HTTP ${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(
      `${url} returned ${contentType || 'no Content-Type'}, expected application/json`,
    )
  }
  try {
    return JSON.parse(await response.text())
  } catch (error) {
    throw new Error(
      `${url} returned invalid JSON: ${error instanceof Error ? error.message : error}`,
    )
  }
}

async function validateLive() {
  const environmentFingerprints = splitFingerprints(process.env.BONDFIRES_PLAY_APP_SIGNING_SHA256)
  const expectedFingerprints = [
    ...(contract.playAppSigningSha256Fingerprints ?? []),
    ...environmentFingerprints,
  ]
  if (expectedFingerprints.length === 0) {
    fail(
      'Google Play App Signing SHA-256 is not configured. Add the public fingerprint to apps/mobile/app-links.json or set BONDFIRES_PLAY_APP_SIGNING_SHA256.',
    )
    return
  }
  expectedFingerprints.forEach((fingerprint, index) => {
    errors.push(...validateFingerprint(fingerprint, `expected Play fingerprint ${index + 1}`))
    if (
      (contract.nonPlaySigningSha256Fingerprints ?? [])
        .map(normalizeFingerprint)
        .includes(normalizeFingerprint(fingerprint))
    ) {
      fail(`Expected Play fingerprint ${fingerprint} is classified as a non-Play signing key`)
    }
  })

  for (const host of contract.hosts) {
    try {
      const assetLinks = await fetchAssociationFile(host, 'assetlinks.json')
      errors.push(
        ...validateAssetLinks(assetLinks, {
          packageName: contract.packageName,
          expectedFingerprints,
        }).map((message) => `${host}: ${message}`),
      )
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }

    try {
      const aasa = await fetchAssociationFile(host, 'apple-app-site-association')
      errors.push(
        ...validateAasa(aasa, {
          appId: contract.appleAppId,
          expectedPaths: contract.applePaths,
        }).map((message) => `${host}: ${message}`),
      )
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }

    for (const route of contract.routeSamples) {
      const url = `https://${host}${route}`
      try {
        const response = await fetchWithoutRedirect(url)
        if (response.status !== 200) fail(`${url} returned HTTP ${response.status}`)
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
    }
  }
}

if (live && errors.length === 0) await validateLive()

if (errors.length > 0) {
  console.error(`App Links validation failed:\n- ${errors.join('\n- ')}`)
  process.exit(1)
}

if (live) {
  process.stdout.write(`Live App Links verified for ${contract.hosts.join(', ')}\n`)
} else {
  process.stdout.write('Offline App Links contract verified\n')
  if ((contract.playAppSigningSha256Fingerprints ?? []).length === 0) {
    process.stdout.write(
      'Play App Signing fingerprint is pending; Android release preflight will remain blocked.\n',
    )
  }
}
