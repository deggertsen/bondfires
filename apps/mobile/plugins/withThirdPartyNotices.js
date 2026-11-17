const fs = require('node:fs/promises')
const path = require('node:path')
const { IOSConfig, withDangerousMod, withXcodeProject } = require('expo/config-plugins')

const noticeFile = 'ThirdPartyNotices.txt'

async function writeNotice(projectRoot, destinationDirectory) {
  const license = await fs.readFile(
    path.resolve(projectRoot, '../../packages/ui/src/icons/LICENSE'),
    'utf8',
  )
  await fs.mkdir(destinationDirectory, { recursive: true })
  await fs.writeFile(
    path.join(destinationDirectory, noticeFile),
    `@tamagui/lucide-icons@1.144.4\n\n${license}`,
  )
}

module.exports = (config) => {
  config = withXcodeProject(config, async (result) => {
    const { projectRoot, platformProjectRoot } = result.modRequest
    await writeNotice(projectRoot, platformProjectRoot)
    IOSConfig.XcodeUtils.ensureGroupRecursively(result.modResults, 'Resources')
    IOSConfig.XcodeUtils.addResourceFileToGroup({
      filepath: noticeFile,
      groupName: 'Resources',
      isBuildFile: true,
      project: result.modResults,
    })
    return result
  })

  return withDangerousMod(config, [
    'android',
    async (result) => {
      const { projectRoot, platformProjectRoot } = result.modRequest
      await writeNotice(projectRoot, path.join(platformProjectRoot, 'app/src/main/assets'))
      return result
    },
  ])
}
