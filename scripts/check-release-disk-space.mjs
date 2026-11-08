#!/usr/bin/env node

import { statfsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from './lib/repository-intelligence.mjs'

export function checkReleaseDiskSpace(directory, minimum = '25') {
  if (!/^\d+(\.\d+)?$/.test(minimum) || !Number.isFinite(Number(minimum)) || Number(minimum) <= 0) {
    throw new Error('RELEASE_MIN_FREE_GB must be a positive number')
  }
  const { bavail, bsize } = statfsSync(directory)
  const freeGb = (bavail * bsize) / 1024 ** 3
  const minimumGb = Number(minimum)
  if (freeGb < minimumGb) {
    throw new Error(
      `Only ${freeGb.toFixed(1)} GiB free; local release builds need ${minimumGb} GiB. Free space or adjust RELEASE_MIN_FREE_GB.`,
    )
  }
  return freeGb
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const freeGb = checkReleaseDiskSpace(repositoryRoot, process.env.RELEASE_MIN_FREE_GB)
    console.info(`💾 ${freeGb.toFixed(1)} GiB free`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
