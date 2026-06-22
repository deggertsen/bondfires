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
        let audioStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        guard audioStatus == .authorized else {
          return false
        }
        return await MainActor.run { BondfireLivePublisherModule.hasUsableCamera() }
      #endif
    }

    AsyncFunction("getCameraCount") { () -> Int in
      #if targetEnvironment(simulator)
        return 0
      #else
        return await MainActor.run { BondfireLivePublisherModule.usableCameraCount() }
      #endif
    }

    AsyncFunction("startPreview") { (options: LivePublisherStartOptions) in
      // Camera preview only — nothing is connected or streamed until start() is called.
      let publisher = try await MainActor.run { try self.ensurePublisher() }
      await MainActor.run { BondfireLivePublisherView.current?.attachPreviewIfAvailable() }
      try await publisher.startPreview(options: options)
    }

    AsyncFunction("start") { (options: LivePublisherStartOptions) in
      let publisher = try await MainActor.run { try self.ensurePublisher() }
      await MainActor.run { BondfireLivePublisherView.current?.attachPreviewIfAvailable() }
      await MainActor.run { self.sendEvent("statusChange", ["status": PublisherStatus.connecting.rawValue]) }
      try await publisher.start(options: options)
    }

    AsyncFunction("stop") {
      let publisher = self.publisher
      self.publisher = nil
      await publisher?.stop()
    }

    AsyncFunction("swapCamera") {
      guard let publisher = self.publisher else {
        throw LivePublisherException(message: "No active publisher to swap camera")
      }
      try await publisher.swapCamera()
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

  // MARK: - Camera availability

  /// Video capture availability, probed on the main actor with the same
  /// wide-angle camera lookups `LivePublisher.startPreview` uses to attach a
  /// camera.
  ///
  /// `AVCaptureDevice.DiscoverySession` was observed to return an empty device
  /// list on every iOS device in production when called from the Expo
  /// background queue (the `AsyncFunction` execution context). That made
  /// `isAvailable()` report `false` for all iOS users, silently forcing them
  /// onto the legacy upload fallback instead of the live recording path.
  /// `AVCaptureDevice.default(...)` on the main actor is the source of truth for
  /// "can we actually open a camera" because the preview path uses that same
  /// lookup before attaching video.
  #if !targetEnvironment(simulator)
  @MainActor
  fileprivate static func hasUsableCamera() -> Bool {
    camera(for: .front) != nil || camera(for: .back) != nil
  }

  @MainActor
  fileprivate static func usableCameraCount() -> Int {
    [AVCaptureDevice.Position.front, .back].reduce(0) { count, position in
      camera(for: position) == nil ? count : count + 1
    }
  }

  @MainActor
  fileprivate static func camera(for position: AVCaptureDevice.Position) -> AVCaptureDevice? {
    AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
  }
  #endif
}

// MARK: - Live Publisher Events

/// Wire statuses — keep in sync with NATIVE_PUBLISHER_STATUSES in
/// packages/app/src/store/livePublisherContract.ts and the Kotlin
/// PublisherStatus enum (parity table in the module README).
enum PublisherStatus: String {
  case connecting
  case live
  case reconnecting
  case ended
  case errored
  case streamStoppedUnexpectedly = "stream_stopped_unexpectedly"
  case endpointClosed = "endpoint_closed"
}

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
  private var isCaptureRunning = false
  private var captureSize = CMVideoDimensions(width: 1920, height: 1080)
  private let eventHandler: (LivePublisherEvent) -> Void
  /// True while stop()/cleanup() is tearing the pipeline down, so health
  /// monitoring never reports an intentional stop as a failure. Mirrors
  /// isStoppingIntentionally in the Android module.
  private var isStopping = false
  /// Polls Session.isConnected while publishing. The HaishinKit Session API
  /// exposes no event stream for disconnects, so without this poll an RTMP
  /// drop mid-recording is completely silent on iOS — the UI stays on "REC"
  /// with a frozen pipeline. Android gets the same signal from isOpenFlow.
  private var connectionMonitorTask: Task<Void, Never>?
  private var captureObservers: [NSObjectProtocol] = []

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

  // MARK: - Preview

  /// Start the capture pipeline (camera, mic, preview view) WITHOUT opening any
  /// network connection. Nothing is streamed or recorded until start() runs.
  func startPreview(options: LivePublisherStartOptions) async throws {
    currentOptions = options

    if isCaptureRunning {
      return
    }

    let position: AVCaptureDevice.Position = options.initialCamera == "back" ? .back : .front
    currentCameraPosition = position

    setupAudioSession()
    addCaptureObservers()

    await mixer.addOutput(previewView)

    guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) else {
      emitError("camera_not_found", "No camera for position: \(position == .back ? "back" : "front")")
      throw LivePublisherException(message: "No camera for position: \(position == .back ? "back" : "front")")
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

    captureSize = resolveCameraVideoSize(
      camera,
      fallbackWidth: options.width,
      fallbackHeight: options.height
    )

    // Cap capture fps at the display refresh rate, never exceed requested fps.
    let maxFps = UIScreen.main.maximumFramesPerSecond
    let captureFps = min(Float64(options.fps), Float64(maxFps > 0 ? maxFps : 30))
    await mixer.setFrameRate(captureFps)

    isCaptureRunning = true
  }

  // MARK: - Start

  func start(options: LivePublisherStartOptions) async throws {
    // Reuse the running capture pipeline when startPreview() already ran.
    if !isCaptureRunning {
      try await startPreview(options: options)
    }
    currentOptions = options

    let urlString: String
    if options.rtmpsUrl.hasSuffix("/") {
      urlString = options.rtmpsUrl + options.streamKey
    } else {
      urlString = options.rtmpsUrl + "/" + options.streamKey
    }

    guard let url = URL(string: urlString) else {
      emitError("invalid_url", "Could not parse RTMPS URL: \(urlString)")
      emitStatusChange(.errored)
      return
    }

    // HaishinKit 2.x resolves a URL scheme to a Session via factories that
    // must be registered first; without this, build() throws .notFound. The
    // factory's register() is idempotent, so calling it on every start() is
    // safe and keeps the registration colocated with its only use.
    await SessionBuilderFactory.shared.register(RTMPSessionFactory())

    // build() returns (any Session)? — guard-unwrap required
    let newSession: any Session
    do {
      guard let built = try await SessionBuilderFactory.shared.make(url).build() else {
        emitError("session_build_failed", "Session builder returned nil for URL: \(urlString)")
        emitStatusChange(.errored)
        throw LivePublisherException(message: "Session builder returned nil")
      }
      newSession = built
    } catch let e as LivePublisherException {
      throw e
    } catch {
      emitError("session_build_failed", "Failed to build RTMP session: \(error.localizedDescription)")
      emitStatusChange(.errored)
      throw LivePublisherException(message: "Failed to build RTMP session: \(error.localizedDescription)")
    }
    self.session = newSession

    // Wire the stream output into the already-running mixer
    await mixer.addOutput(newSession.stream)

    var videoSettings = await newSession.stream.videoSettings
    videoSettings.bitRate = options.videoBitrate
    // The mixer emits portrait frames (matching the preview), but
    // activeFormat reports the sensor's landscape dimensions. Encode in
    // portrait orientation so HaishinKit's default .trim scaling doesn't
    // center-crop a portrait frame into a landscape target, which makes the
    // recording look zoomed in even though the preview is correct.
    let shortSide = Int(min(captureSize.width, captureSize.height))
    let longSide = Int(max(captureSize.width, captureSize.height))
    videoSettings.videoSize = CGSize(width: shortSide, height: longSide)
    await newSession.stream.setVideoSettings(videoSettings)

    var audioSettings = await newSession.stream.audioSettings
    audioSettings.bitRate = options.audioBitrate
    await newSession.stream.setAudioSettings(audioSettings)

    do {
      try await newSession.connect(.ingest)
    } catch {
      emitError("connection_failed", "RTMP connection failed: \(error.localizedDescription)")
      emitStatusChange(.errored)
      throw LivePublisherException(message: "RTMP connection failed: \(error.localizedDescription)")
    }

    emitStatusChange(.live)
    startConnectionMonitor()
  }

  // MARK: - Health monitoring

  /// Detect a dropped RTMP connection while publishing. The JS side already
  /// handles "endpoint_closed" by finalizing the partial recording, so this
  /// converts a silent freeze into a graceful auto-stop-and-save.
  private func startConnectionMonitor() {
    connectionMonitorTask?.cancel()
    connectionMonitorTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        guard let self, !Task.isCancelled else { return }
        guard let session = self.session, !self.isStopping else { return }
        let connected = await session.isConnected
        if Task.isCancelled || self.isStopping || self.session == nil { return }
        if !connected {
          self.emitStatusChange(.endpointClosed)
          return
        }
      }
    }
  }

  /// Surface capture-session interruptions (phone call, Slide Over, thermal
  /// shutdown, camera grabbed by another app) and runtime errors while
  /// publishing. Without these observers the preview freezes with no event,
  /// the UI stays on "REC", and nothing is saved.
  private func addCaptureObservers() {
    guard captureObservers.isEmpty else { return }
    let center = NotificationCenter.default

    captureObservers.append(center.addObserver(
      forName: AVCaptureSession.wasInterruptedNotification,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      let reasonValue =
        (notification.userInfo?[AVCaptureSessionInterruptionReasonKey] as? NSNumber)?.intValue
      Task { @MainActor [weak self] in
        guard let self, self.isCaptureRunning, !self.isStopping else { return }
        // Preview-only interruptions (no session yet) resume automatically
        // when the interruption ends; only a publishing pipeline needs to
        // fail fast so the partial recording gets finalized.
        guard self.session != nil else { return }
        self.emitError(
          "capture_interrupted",
          "Camera capture was interrupted (reason: \(reasonValue.map(String.init) ?? "unknown"))"
        )
      }
    })

    captureObservers.append(center.addObserver(
      forName: AVCaptureSession.runtimeErrorNotification,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      let errorDescription =
        (notification.userInfo?[AVCaptureSessionErrorKey] as? NSError)?.localizedDescription
      Task { @MainActor [weak self] in
        guard let self, self.isCaptureRunning, !self.isStopping else { return }
        self.emitError(
          "capture_runtime_error",
          errorDescription ?? "Camera capture hit a runtime error"
        )
      }
    })
  }

  private func removeCaptureObservers() {
    for observer in captureObservers {
      NotificationCenter.default.removeObserver(observer)
    }
    captureObservers = []
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
    emitStatusChange(.ended)
    await cleanup()
  }

  func stopWithoutEvent() async {
    await cleanup()
  }

  private func cleanup() async {
    isStopping = true
    connectionMonitorTask?.cancel()
    connectionMonitorTask = nil
    removeCaptureObservers()
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
    isCaptureRunning = false
    isStopping = false
  }

  // MARK: - Swap Camera

  /// Throws on failure instead of emitting an `error` event. The error event
  /// path is reserved for fatal publisher failures — useLivePublisher escalates
  /// it to livePublishActions.fail(), which would tear down the whole session
  /// state over a non-fatal swap failure. Throwing rejects the JS promise so
  /// toggleLiveFacing can show its "Switch Camera Failed" alert and keep
  /// recording on the current camera. Matches the Android Coroutine behavior.
  func swapCamera() async throws {
    let newPosition: AVCaptureDevice.Position = currentCameraPosition == .front ? .back : .front
    let positionLabel = newPosition == .back ? "back" : "front"
    guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: newPosition) else {
      throw LivePublisherException(message: "Could not find camera at position \(positionLabel)")
    }

    do {
      try await mixer.attachVideo(camera, track: 0) { videoUnit in
        videoUnit.isVideoMirrored = newPosition == .front
      }
      currentCameraPosition = newPosition
    } catch {
      throw LivePublisherException(message: "Camera swap to \(positionLabel) failed: \(error.localizedDescription)")
    }
  }

  // MARK: - Mute

  func setMuted(_ muted: Bool) async {
    var audioSettings = await mixer.audioMixerSettings
    audioSettings.isMuted = muted
    await mixer.setAudioMixerSettings(audioSettings)
  }

  // MARK: - Stats

  /// Real throughput stats while publishing. The Session protocol only
  /// exposes `any HKStream`, but the RTMP implementation is an RTMPStream
  /// actor with per-second byte counts and encoder FPS — downcast to reach
  /// them. The JS stall watchdog uses bitrateBps==0 (after having seen
  /// nonzero) to detect a frozen encoder that the connection poll misses.
  func getStats() async -> [String: Int] {
    let zeros = [
      "bitrateBps": 0,
      "rttMs": 0,
      "droppedFrames": 0,
      "currentFps": 0,
    ]
    guard let session else {
      return zeros
    }
    // `Session.stream` is actor-isolated, so the access must be awaited
    // (mirrors the awaited stream access in start()).
    guard let rtmpStream = await session.stream as? RTMPStream else {
      return zeros
    }

    let info = await rtmpStream.info
    let fps = await rtmpStream.currentFPS
    return [
      "bitrateBps": info.currentBytesPerSecond * 8,
      "rttMs": 0,
      "droppedFrames": 0,
      "currentFps": Int(fps),
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

  private func emitStatusChange(_ status: PublisherStatus) {
    eventHandler(.statusChange(status.rawValue))
  }

  private func emitError(_ code: String, _ message: String) {
    eventHandler(.error(code, message))
  }
}

// MARK: - Live Publisher View

final class BondfireLivePublisherView: ExpoView {
  /// The most recently mounted preview view, so the module can re-attach the
  /// camera preview when the publisher is created after the view mounts.
  static weak var current: BondfireLivePublisherView?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = UIColor.black
    Self.current = self
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      Self.current = self
    }
    attachPreviewIfAvailable()
  }

  func attachPreviewIfAvailable() {
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
