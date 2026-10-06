#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
output_dir=$(mktemp -d "${TMPDIR:-/tmp}/bondfires-speech-tests.XXXXXX")
module=apps/mobile/modules/bondfire-live-publisher
swiftc "$module/ios/SpeechLeveler.swift" "$module/tests/SpeechLevelerTests.swift" -o "$output_dir/leveler"
"$output_dir/leveler"
swiftc "$module/ios/SpeechLeveler.swift" "$module/ios/LeveledAudioBuffer.swift" \
  "$module/tests/LeveledAudioBufferTests.swift" -o "$output_dir/conversion"
"$output_dir/conversion"
