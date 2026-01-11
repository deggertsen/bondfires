// Re-export the config from the shared package
// This file is needed for the babel plugin to find the config
import { config as tamaguiConfig } from '@bondfires/config'
export { config, tamaguiConfig } from '@bondfires/config'
export default tamaguiConfig

