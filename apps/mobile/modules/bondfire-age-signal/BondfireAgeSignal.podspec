Pod::Spec.new do |s|
  s.name           = 'BondfireAgeSignal'
  s.version        = '0.1.0'
  s.summary        = 'Device age range signal for Bondfires'
  s.description    = 'Local Expo module that asks Apple Declared Age Range (iOS 26+) for a 13/18 age range. Weak-linked so the app keeps its iOS 16.4 deployment target.'
  s.author         = 'Bondfires'
  s.homepage       = 'https://bondfires.app'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # DeclaredAgeRange only exists in the iOS 26 SDK. Weak-link it so older
  # devices launch normally and the Swift availability check decides at runtime.
  s.weak_frameworks = 'DeclaredAgeRange'

  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.swift_version = '5.9'
end
