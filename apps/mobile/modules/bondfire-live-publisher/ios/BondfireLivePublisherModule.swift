import ExpoModulesCore
import UIKit
import HaishinKit
import AVFoundation
import Foundation

struct LivePublisherStartOptions: Record {
  @Field var rtmpsUrl: String = ""
  @Field var streamKey: String = ""
  @Field var width: Int = 0
  @Field var height: Int = 0
  @Field var fps: Int = 30
  @Field var videoBitrate: Int = 2_500_000
  @Field var audioBitrate: Int = 128_000
  @Field var initialCamera: String = "front"
}

public class BondfireLivePublisherModule: Module {
  fileprivate static var currentInstance: BondfireLivePublisherModule?

  public func definition() -> ModuleDefinition {
    Name("BondfireLivePublisher")

    Events("statusChange", "error")

    OnCreate {
      BondfireLivePublisherModule.currentInstance = self
    }

    OnDestroy {
      BondfireLivePublisherModule.currentInstance = nil
      let publisher = self.publisher
      Task { @MainActor in
        await publisher?.stopWithoutEvent()
      }
    }

    AsyncFunction("isAvailable") { () -> Bool in
      #if targetEnvironment(simulator)
        // No physical camera on simulator
        return false
      #else
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        guard status == .authorized else {
          return false
        }
        // Check that at least one camera exists
        let cameraTypes: [AVCaptureDevice.DeviceType] = [
          .builtInWideAngleCamera,
          .builtInTelephotoCamera,
          .builtInUltraWideCamera,
        ]
        let discovery = AVCaptureDevice.DiscoverySession(
          deviceTypes: cameraTypes,
          mediaType: .video,
          position: .unspecified
        )
        return !discovery.devices.isEmpty
      #endif
    }

    AsyncFunction("getCameraCount") { () -> Int in
      #if targetEnvironment(simulator)
        return 0
      #else
        let cameraTypes: [AVCaptureDevice.DeviceType] = [
          .builtInWideAngleCamera,
          .builtInTelephotoCamera,
          .builtInUltraWideCamera,
        ]
        let discovery = AVCaptureDevice.DiscoverySession(
          deviceTypes: cameraTypes,
          mediaType: .video,
          position: .unspecified
        )
        return discovery.devices.count
      #endif
    }

    AsyncFunction("start") { (options: LivePublisherStartOptions) in
      let publisher = try await MainActor.run { try self.ensurePublisher() }
      await MainActor.run { self.sendEvent("statusChange", ["status": "connecting"]) }
      try await publisher.start(options: options)
    }

    AsyncFunction("stop") {
      let publisher = self.publisher
      self.publisher = nil
      await publisher?.stop()
    }

    AsyncFunction("swapCamera") {
      await self.publisher?.swapCamera()
    }

    AsyncFunction("setMuted") { (muted: Bool) in
      await self.publisher?.setMuted(muted)
    }

    AsyncFunction("getStats") { () -> [String: Int] in
      if let publisher = self.publisher {
        return await publisher.getStats()
      }
      return [
        "bitrateBps": 0,
        "rttMs": 0,
        "droppedFrames": 0,
      ]
    }

    View(BondfireLivePublisherView.self) {}
  }

  // MARK: - Publisher lifecycle

  fileprivate var publisher: LivePublisher?

  @MainActor
  private func ensurePublisher() throws -> LivePublisher {
    if let publisher = publisher {
      return publisher
    }
    let publisher = LivePublisher(eventHandler: { [weak self] event in
      guard let self else { return }
      switch event {
      case .statusChange(let status):
        self.sendEvent("statusChange", ["status": status])
      case .error(let code, let message):
        self.sendEvent("error", [
          "code": code,
          "message": message,
        ])
      }
    })
    self.publisher = publisher
    return publisher
  }
}

// MARK: - Live Publisher Events

enum LivePublisherEvent {
  case statusChange(String)
  case error(String, String)
}

// MARK: - Live Publisher

@MainActor
final class LivePublisher {
  // useManualCapture: true gives us explicit control over when capture starts
  private let mixer = MediaMixer(multiCamSessionEnabled: false, useManualCapture: true)
  private var session: (any Session)?
  private var currentOptions: LivePublisherStartOptions?
  private var currentCameraPosition: AVCaptureDevice.Position = .front
  private let eventHandler: (LivePublisherEvent) -> Void

  /// MTHKView registered as a mixer output — HaishinKit 2.x preview approach
  private lazy var previewView: MTHKView = {
    let view = MTHKView(frame: .zero)
    view.videoGravity = .resizeAspectFill
    return view
  }()

  /// The preview UIView exposed to BondfireLivePublisherView
  var cameraPreviewView: UIView { previewView }

  init(eventHandler: @escaping (LivePublisherEvent) -> Void) {
    self.eventHandler = eventHandler
  }

  // MARK: - Start

  func start(options: LivePublisherStartOptions) async throws {
    currentOptions = options

    let position: AVCaptureDevice.Position = options.initialCamera == "back" ? .back : .front
    currentCameraPosition = position

    setupAudioSession()

    let urlString: String
    if options.rtmpsUrl.hasSuffix("/") {
      urlString = options.rtmpsUrl + options.streamKey
    } else {
      urlString = options.rtmpsUrl + "/" + options.streamKey
    }

    guard let url = URL(string: urlString) else {
      emitError("invalid_url", "Could not parse RTMPS URL: \(urlString)")
      emitStatusChange("errored")
      return
    }

    // build() returns (any Session)? — guard-unwrap required
    let newSession: any Session
    do {
      guard let built = try await SessionBuilderFactory.shared.make(url).build() else {
        emitError("session_build_failed", "Session builder returned nil for URL: \(urlString)")
        emitStatusChange("errored")
        throw LivePublisherException(message: "Session builder returned nil")
      }
      newSession = built
    } catch let e as LivePublisherException {
      throw e
    } catch {
      emitError("session_build_failed", "Failed to build RTMP session: \(error.localizedDescription)")
      emitStatusChange("errored")
      throw LivePublisherException(message: "Failed to build RTMP session: \(error.localizedDescription)")
    }
    self.session = newSession

    // Wire stream output and preview view into the mixer
    await mixer.addOutput(newSession.stream)
    await mixer.addOutput(previewView)

    guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) else {
      emitError("camera_not_found", "No camera for position: \(position == .back ? "back" : "front")")
      emitStatusChange("errored")
      return
    }
    do {
      if position == .front {
        try await mixer.attachVideo(camera, track: 0) { videoUnit in
          videoUnit.isVideoMirrored = true
        }
      } else {
        try await mixer.attachVideo(camera, track: 0)
      }
    } catch {
      emitError("attachCamera_failed", error.localizedDescription)
    }

    if let audioDevice = AVCaptureDevice.default(for: .audio) {
      do {
        try await mixer.attachAudio(audioDevice)
      } catch {
        emitError("attachAudio_failed", error.localizedDescription)
      }
    } else {
      emitError("no_mic", "No audio input device found.")
    }

    await mixer.startRunning()

    let captureSize = resolveCameraVideoSize(
      camera,
      fallbackWidth: options.width,
      fallbackHeight: options.height
    )

    mixer.videoMixerSettings.videoSize = .init(
      width: captureSize.width,
      height: captureSize.height
    )
    // Use screen refresh rate as a hint, never exceed requested fps
    let maxFps = UIScreen.main.maximumFramesPerSecond
    mixer.videoMixerSettings.frameRate = min(Float64(options.fps), Float64(maxFps > 0 ? maxFps : 30))

    var videoSettings = await newSession.stream.videoSettings
    videoSettings.bitRate = options.videoBitrate
    videoSettings.videoSize = .init(width: captureSize.width, height: captureSize.height)
    await newSession.stream.setVideoSettings(videoSettings)

    var audioSettings = await newSession.stream.audioSettings
    audioSettings.bitRate = options.audioBitrate
    await newSession.stream.setAudioSettings(audioSettings)

    do {
      try await newSession.connect(.ingest)
    } catch {
      emitError("connection_failed", "RTMP connection failed: \(error.localizedDescription)")
      emitStatusChange("errored")
      throw LivePublisherException(message: "RTMP connection failed: \(error.localizedDescription)")
    }

    emitStatusChange("live")
  }

  private func resolveCameraVideoSize(
    _ camera: AVCaptureDevice,
    fallbackWidth: Int,
    fallbackHeight: Int
  ) -> CMVideoDimensions {
    let dimensions = camera.activeFormat.formatDescription.dimensions
    if dimensions.width > 0 && dimensions.height > 0 {
      return dimensions
    }

    if fallbackWidth > 0 && fallbackHeight > 0 {
      return CMVideoDimensions(width: Int32(fallbackWidth), height: Int32(fallbackHeight))
    }

    return CMVideoDimensions(width: 1920, height: 1080)
  }

  // MARK: - Stop

  func stop() async {
    emitStatusChange("ended")
    await cleanup()
  }

  func stopWithoutEvent() async {
    await cleanup()
  }

  private func cleanup() async {
    do {
      try await session?.close()
    } catch {
      // Best effort close
    }
    await mixer.stopRunning()
    do {
      try await mixer.attachAudio(nil)
      try await mixer.attachVideo(nil, track: 0)
    } catch {
      // Best effort detach
    }
    session = nil
    currentOptions = nil
  }

  // MARK: - Swap Camera

  func swapCamera() async {
    let newPosition: AVCaptureDevice.Position = currentCameraPosition == .front ? .back : .front
    guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: newPosition) else {
      emitError("camera_not_found", "Could not find camera at position \(newPosition)")
      return
    }

    do {
      try await mixer.attachVideo(camera, track: 0) { videoUnit in
        videoUnit.isVideoMirrored = newPosition == .front
      }
      currentCameraPosition = newPosition
    } catch {
      emitError("swapCamera_failed", error.localizedDescription)
    }
  }

  // MARK: - Mute

  func setMuted(_ muted: Bool) async {
    var audioSettings = await mixer.audioMixerSettings
    audioSettings.isMuted = muted
    await mixer.setAudioMixerSettings(audioSettings)
  }

  // MARK: - Stats

  func getStats() async -> [String: Int] {
    return [
      "bitrateBps": 0,
      "rttMs": 0,
      "droppedFrames": 0,
    ]
  }

  // MARK: - Audio Session

  private func setupAudioSession() {
    let audioSession = AVAudioSession.sharedInstance()
    do {
      try audioSession.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
      try audioSession.setActive(true)
    } catch {
      emitError("audio_session_failed", error.localizedDescription)
    }
  }

  // MARK: - Event emission

  private func emitStatusChange(_ status: String) {
    eventHandler(.statusChange(status))
  }

  private func emitError(_ code: String, _ message: String) {
    eventHandler(.error(code, message))
  }
}

// MARK: - Live Publisher View

final class BondfireLivePublisherView: ExpoView {
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = UIColor.black
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    attachPreviewIfAvailable()
  }

  private func attachPreviewIfAvailable() {
    guard let module = BondfireLivePublisherModule.currentInstance,
          let publisher = module.publisher else {
      return
    }
    let previewView = publisher.cameraPreviewView
    if previewView.superview != self {
      previewView.removeFromSuperview()
      addSubview(previewView)
      previewView.frame = bounds
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    for subview in subviews {
      subview.frame = bounds
    }
  }
}

// MARK: - Exception

final class LivePublisherException: Exception {
  let message: String

  init(message: String) {
    self.message = message
    super.init()
  }

  override var reason: String {
    message
  }
}
