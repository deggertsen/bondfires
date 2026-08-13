Pod::Spec.new do |s|
  s.name           = 'NowPlayingInfo'
  s.version        = '0.1.0'
  s.summary        = 'Now Playing metadata and remote commands for Bondfires video playback'
  s.description    = 'Local Expo module that publishes active Bondfires video metadata to system media controls.'
  s.author         = 'Bondfires'
  s.homepage       = 'https://bondfires.app'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'AVFoundation', 'MediaPlayer'
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.swift_version = '5.9'
end
