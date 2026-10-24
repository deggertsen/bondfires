@main
struct CameraMicrophoneSelectionTests {
  static func main() {
    typealias Source = CameraMicrophoneDataSource
    let sources: [Source] = [
      .init(orientation: .bottom, isUpper: false),
      .init(orientation: .back, isUpper: true),
      .init(orientation: .front, isUpper: true),
    ]
    precondition(cameraMicrophoneDataSourceIndex(in: sources, cameraIsFront: true) == 2)
    precondition(cameraMicrophoneDataSourceIndex(in: sources, cameraIsFront: false) == 1)
    // A camera swap must reselect, independent of the previous choice or source order.
    let reversed = Array(sources.reversed())
    precondition(cameraMicrophoneDataSourceIndex(in: reversed, cameraIsFront: true) == 0)
    precondition(cameraMicrophoneDataSourceIndex(in: reversed, cameraIsFront: false) == 1)

    for cameraIsFront in [true, false] {
      let orientation: Source.Orientation = cameraIsFront ? .front : .back
      let matching: [Source] = [
        .init(orientation: orientation, isUpper: false),
        .init(orientation: orientation, isUpper: true),
        .init(orientation: orientation, isUpper: true),
      ]
      precondition(cameraMicrophoneDataSourceIndex(in: matching, cameraIsFront: cameraIsFront) == 1,
        "Prefer the first upper matching source")
      precondition(cameraMicrophoneDataSourceIndex(in: Array(matching.prefix(1)), cameraIsFront: cameraIsFront) == 0,
        "Matching orientation remains usable without an upper location")
      let mixedLocations: [Source] = [
        .init(orientation: cameraIsFront ? .back : .front, isUpper: true),
        .init(orientation: orientation, isUpper: false),
      ]
      precondition(cameraMicrophoneDataSourceIndex(in: mixedLocations, cameraIsFront: cameraIsFront) == 1,
        "Camera orientation takes precedence over an opposite-facing upper mic")
      precondition(cameraMicrophoneDataSourceIndex(in: [], cameraIsFront: cameraIsFront) == nil)
      let noMatch: [Source] = [
        .init(orientation: .none, isUpper: true),
        .init(orientation: .bottom, isUpper: false),
        .init(orientation: cameraIsFront ? .back : .front, isUpper: true),
      ]
      precondition(cameraMicrophoneDataSourceIndex(in: noMatch, cameraIsFront: cameraIsFront) == nil,
        "Missing/unknown orientation or opposite-facing sources must preserve the OS choice")
    }
    print("PASS: camera-matched microphone selection, swaps, locations and missing-source fallback")
  }
}
