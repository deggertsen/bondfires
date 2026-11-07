const { withGradleProperties } = require('expo/config-plugins')

// Expo's template caps the Gradle daemon at -Xmx2048m -XX:MaxMetaspaceSize=512m.
// The 1.0.109 release bundle ran out of Metaspace in :app:signReleaseBundle once
// the device age-signal native module was added. Give the daemon more room.
const JVM_ARGS = '-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8'

function setJvmArgs(properties) {
  const existing = properties.find(
    (item) => item.type === 'property' && item.key === 'org.gradle.jvmargs',
  )
  if (existing) {
    existing.value = JVM_ARGS
  } else {
    properties.push({ type: 'property', key: 'org.gradle.jvmargs', value: JVM_ARGS })
  }
  return properties
}

module.exports = (config) =>
  withGradleProperties(config, (result) => {
    result.modResults = setJvmArgs(result.modResults)
    return result
  })
module.exports.setJvmArgs = setJvmArgs
module.exports.JVM_ARGS = JVM_ARGS
