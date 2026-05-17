Pod::Spec.new do |s|
  s.name           = 'BondfireLivePublisher'
  s.version        = '0.1.0'
  s.summary        = 'Mux RTMPS live publisher for Bondfires'
  s.description    = 'Local Expo module that hosts the live camera preview and publishes RTMPS streams.'
  s.author         = 'Bondfires'
  s.homepage       = 'https://bondfires.app'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'HaishinKit', '~> 2.0'

  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.swift_version = '5.9'
end
