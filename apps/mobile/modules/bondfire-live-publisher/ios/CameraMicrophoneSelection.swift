/// Hardware-independent description used to choose a camera-facing built-in mic.
struct CameraMicrophoneDataSource {
  enum Orientation: String {
    case front, back, bottom, none
  }

  let orientation: Orientation
  let isUpper: Bool
}

/// Prefer an upper camera-facing mic, but accept any matching orientation.
/// Never fall back to the opposite camera or bottom mic: nil preserves the OS choice.
func cameraMicrophoneDataSourceIndex(
  in sources: [CameraMicrophoneDataSource],
  cameraIsFront: Bool
) -> Int? {
  let orientation: CameraMicrophoneDataSource.Orientation = cameraIsFront ? .front : .back
  return sources.firstIndex { $0.orientation == orientation && $0.isUpper }
    ?? sources.firstIndex { $0.orientation == orientation }
}

#if os(iOS)
import AVFoundation

extension CameraMicrophoneDataSource {
  init(_ source: AVAudioSessionDataSourceDescription) {
    switch source.orientation {
    case AVAudioSession.Orientation.front: orientation = .front
    case AVAudioSession.Orientation.back: orientation = .back
    case AVAudioSession.Orientation.bottom: orientation = .bottom
    default: orientation = .none
    }
    isUpper = source.location == AVAudioSession.Location.upper
  }
}
#endif
