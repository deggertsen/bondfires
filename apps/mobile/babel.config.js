module.exports = function (api) {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
    // Tamagui v3 compiles through @tamagui/metro-plugin (see metro.config.js);
    // the old @tamagui/babel-plugin no longer exists.
    plugins: ['react-native-reanimated/plugin'],
  }
}
