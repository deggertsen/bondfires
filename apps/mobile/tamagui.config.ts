// Re-export the config from the shared package
// This file is needed for the babel plugin to find the config
export { config, tamaguiConfig } from '@bondfires/config'
export default require('@bondfires/config').config

