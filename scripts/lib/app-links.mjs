export const HANDLE_ALL_URLS_RELATION = 'delegate_permission/common.handle_all_urls'
export const SHA256_FINGERPRINT_PATTERN = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/

const PLACEHOLDER_PATTERN = /(?:REPLACE|PLACEHOLDER|REQUIRED|TODO|YOUR[_ -])/i

export function normalizeFingerprint(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

export function validateFingerprint(value, label = 'fingerprint') {
  const normalized = normalizeFingerprint(value)
  if (!normalized) return [`${label} is empty`]
  if (PLACEHOLDER_PATTERN.test(normalized)) return [`${label} contains a placeholder`]
  if (!SHA256_FINGERPRINT_PATTERN.test(normalized)) {
    return [`${label} must be a colon-delimited SHA-256 certificate fingerprint`]
  }
  return []
}

function sameValues(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

export function validateAppLinksContract(contract) {
  const errors = []
  if (contract?.version !== 1) errors.push('app-links.json must use version 1')
  if (!/^[a-zA-Z][a-zA-Z0-9_.]+$/.test(contract?.packageName ?? '')) {
    errors.push('app-links.json packageName is invalid')
  }
  if (!/^[A-Z0-9]+\.[a-zA-Z][a-zA-Z0-9_.]+$/.test(contract?.appleAppId ?? '')) {
    errors.push('app-links.json appleAppId is invalid')
  }
  for (const field of ['hosts', 'androidPathPrefixes', 'applePaths', 'routeSamples']) {
    if (!Array.isArray(contract?.[field]) || contract[field].length === 0) {
      errors.push(`app-links.json ${field} must be a non-empty array`)
    }
  }
  for (const host of contract?.hosts ?? []) {
    if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..')) errors.push(`Invalid host: ${host}`)
  }
  for (const route of [
    ...(contract?.androidPathPrefixes ?? []),
    ...(contract?.routeSamples ?? []),
  ]) {
    if (!route.startsWith('/')) errors.push(`App Link path must start with /: ${route}`)
  }
  for (const path of contract?.applePaths ?? []) {
    if (!path.startsWith('/')) errors.push(`Apple path must start with /: ${path}`)
  }
  for (const route of contract?.routeSamples ?? []) {
    if (!(contract?.androidPathPrefixes ?? []).some((prefix) => route.startsWith(prefix))) {
      errors.push(`Route sample is not covered by an Android path prefix: ${route}`)
    }
    if (
      !(contract?.applePaths ?? []).some((path) =>
        path.endsWith('*') ? route.startsWith(path.slice(0, -1)) : route === path,
      )
    ) {
      errors.push(`Route sample is not covered by an Apple path: ${route}`)
    }
  }
  for (const [kind, fingerprints] of [
    ['Play App Signing', contract?.playAppSigningSha256Fingerprints ?? []],
    ['non-Play signing', contract?.nonPlaySigningSha256Fingerprints ?? []],
  ]) {
    if (!Array.isArray(fingerprints)) {
      errors.push(`${kind} fingerprints must be an array`)
      continue
    }
    fingerprints.forEach((fingerprint, index) => {
      errors.push(...validateFingerprint(fingerprint, `${kind} fingerprint ${index + 1}`))
    })
  }
  const nonPlayFingerprints = new Set(
    (contract?.nonPlaySigningSha256Fingerprints ?? []).map(normalizeFingerprint),
  )
  for (const fingerprint of contract?.playAppSigningSha256Fingerprints ?? []) {
    const normalized = normalizeFingerprint(fingerprint)
    if (nonPlayFingerprints.has(normalized)) {
      errors.push(`Play signing fingerprint is also classified as non-Play: ${normalized}`)
    }
  }
  return errors
}

export function validateExpoAppLinks(expo, contract) {
  const errors = []
  if (expo?.android?.package !== contract.packageName) {
    errors.push(`Android package must be ${contract.packageName}`)
  }
  const separator = contract.appleAppId.indexOf('.')
  const appleTeamId = contract.appleAppId.slice(0, separator)
  const appleBundleId = contract.appleAppId.slice(separator + 1)
  if (expo?.ios?.appleTeamId !== appleTeamId || expo?.ios?.bundleIdentifier !== appleBundleId) {
    errors.push(`iOS team and bundle must form ${contract.appleAppId}`)
  }

  const iosDomains = new Set(
    (expo?.ios?.associatedDomains ?? []).map((value) => value.replace(/^applinks:/, '')),
  )
  const entitlementDomains = new Set(
    (expo?.ios?.entitlements?.['com.apple.developer.associated-domains'] ?? []).map((value) =>
      value.replace(/^applinks:/, ''),
    ),
  )
  const expectedHosts = new Set(contract.hosts)
  if (!sameValues(iosDomains, expectedHosts)) errors.push('iOS associatedDomains do not match')
  if (!sameValues(entitlementDomains, expectedHosts)) {
    errors.push('iOS associated-domain entitlements do not match')
  }

  const verifiedData = (expo?.android?.intentFilters ?? [])
    .filter(
      (filter) =>
        filter.autoVerify === true &&
        filter.action === 'VIEW' &&
        filter.category?.includes('BROWSABLE') &&
        filter.category?.includes('DEFAULT'),
    )
    .flatMap((filter) => filter.data ?? [])

  for (const host of contract.hosts) {
    for (const pathPrefix of contract.androidPathPrefixes) {
      const found = verifiedData.some(
        (entry) =>
          entry.scheme === 'https' && entry.host === host && entry.pathPrefix === pathPrefix,
      )
      if (!found) errors.push(`Android autoVerify is missing https://${host}${pathPrefix}`)
    }
  }
  for (const entry of verifiedData) {
    const expected =
      entry.scheme === 'https' &&
      expectedHosts.has(entry.host) &&
      contract.androidPathPrefixes.includes(entry.pathPrefix)
    if (!expected) {
      errors.push(
        `Unexpected Android App Link mapping: ${entry.scheme ?? '(no scheme)'}://${
          entry.host ?? '(no host)'
        }${entry.pathPrefix ?? ''}`,
      )
    }
  }
  return errors
}

export function validateAssetLinks(document, { packageName, expectedFingerprints = [] }) {
  const errors = []
  if (!Array.isArray(document)) return ['assetlinks.json must be a JSON array']
  const matching = document.filter(
    (statement) =>
      statement?.target?.namespace === 'android_app' &&
      statement?.target?.package_name === packageName &&
      statement?.relation?.includes(HANDLE_ALL_URLS_RELATION),
  )
  if (matching.length === 0) {
    return [`assetlinks.json has no handle_all_urls statement for ${packageName}`]
  }
  const fingerprints = new Set()
  for (const statement of matching) {
    const values = statement.target.sha256_cert_fingerprints
    if (!Array.isArray(values) || values.length === 0) {
      errors.push(`assetlinks.json has no fingerprints for ${packageName}`)
      continue
    }
    values.forEach((value, index) => {
      const normalized = normalizeFingerprint(value)
      errors.push(...validateFingerprint(value, `assetlinks fingerprint ${index + 1}`))
      if (fingerprints.has(normalized)) {
        errors.push(`assetlinks.json contains duplicate fingerprint ${normalized}`)
      }
      if (SHA256_FINGERPRINT_PATTERN.test(normalized)) fingerprints.add(normalized)
    })
  }
  for (const expected of expectedFingerprints.map(normalizeFingerprint)) {
    if (!fingerprints.has(expected)) {
      errors.push(`assetlinks.json is missing expected Play App Signing fingerprint ${expected}`)
    }
  }
  return errors
}

export function validateAasa(document, { appId, expectedPaths }) {
  const details = document?.applinks?.details
  if (!Array.isArray(details)) return ['AASA applinks.details must be an array']
  const matching = details.filter((detail) => detail?.appID === appId)
  if (matching.length === 0) return [`AASA has no applinks entry for ${appId}`]
  const paths = new Set(matching.flatMap((detail) => detail.paths ?? []))
  return expectedPaths.filter((path) => !paths.has(path)).map((path) => `AASA is missing ${path}`)
}

export function splitFingerprints(value) {
  if (!value) return []
  return value.split(',').map(normalizeFingerprint).filter(Boolean)
}
