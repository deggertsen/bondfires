import AVFoundation
import HaishinKit
import UniformTypeIdentifiers

/// One continuous encode, with immutable HLS fragments committed atomically.
/// The mixer is already running when this output is attached at Record.
final class SegmentedRecorder: NSObject, MediaMixerOutput, AVAssetWriterDelegate, @unchecked Sendable {
  var videoTrackId: UInt8? { get async { UInt8.max } }
  var audioTrackId: UInt8? { get async { UInt8.max } }
  private let queue = DispatchQueue(label: "org.bondfires.segment-capture")
  private let diskQueue = DispatchQueue(label: "org.bondfires.segment-disk")
  private let directory: URL
  private let writer: AVAssetWriter
  private let video: AVAssetWriterInput
  private let audio: AVAssetWriterInput
  private var startTime: CMTime?
  private var accepting = true
  private var segmentCount = 0
  private var diskError: Error?
  private let maxDuration: Double
  private let onFailure: @Sendable (String) -> Void
  private var stopTask: Task<Int, Error>?

  init(localId: String, maxDuration: Int, onFailure: @escaping @Sendable (String) -> Void = { _ in }) throws {
    guard UUID(uuidString: localId) != nil, maxDuration > 0, maxDuration <= 3600 else {
      throw NSError(domain: "SegmentedRecorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid recording options"])
    }
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    directory = documents.appendingPathComponent("segments/\(localId.lowercased())", isDirectory: true)
    guard !FileManager.default.fileExists(atPath: directory.path) else {
      throw NSError(domain: "SegmentedRecorder", code: 2, userInfo: [NSLocalizedDescriptionKey: "Recording already exists"])
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var folder = directory
    var resources = URLResourceValues()
    resources.isExcludedFromBackup = true
    try folder.setResourceValues(resources)
    self.maxDuration = Double(maxDuration)
    self.onFailure = onFailure
    writer = AVAssetWriter(contentType: UTType.mpeg4Movie)
    writer.outputFileTypeProfile = .mpeg4AppleHLS
    writer.preferredOutputSegmentInterval = CMTime(seconds: 4, preferredTimescale: 600)
    video = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: 720, AVVideoHeightKey: 1280,
      AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_500_000,
        AVVideoMaxKeyFrameIntervalDurationKey: 2, AVVideoAllowFrameReorderingKey: false],
    ])
    audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
      AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000,
      AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 128000,
    ])
    video.expectsMediaDataInRealTime = true
    audio.expectsMediaDataInRealTime = true
    super.init()
    writer.delegate = self
    writer.add(video)
    writer.add(audio)
  }

  func selectTrack(_ id: UInt8?, mediaType: CMFormatDescription.MediaType) async {}

  func mixer(_ mixer: MediaMixer, didOutput sampleBuffer: CMSampleBuffer) {
    queue.async { self.append(sampleBuffer, input: self.video) }
  }

  func mixer(_ mixer: MediaMixer, didOutput buffer: AVAudioPCMBuffer, when: AVAudioTime) {
    // Copy PCM into a CMBlockBuffer before the mixer reuses its audio buffer.
    var sample: CMSampleBuffer?
    let pts = CMTime(seconds: AVAudioTime.seconds(forHostTime: when.hostTime), preferredTimescale: 1_000_000_000)
    guard CMAudioSampleBufferCreateWithPacketDescriptions(allocator: kCFAllocatorDefault,
      dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil,
      formatDescription: buffer.format.formatDescription, sampleCount: Int(buffer.frameLength),
      presentationTimeStamp: pts, packetDescriptions: nil, sampleBufferOut: &sample) == noErr,
      let sample,
      CMSampleBufferSetDataBufferFromAudioBufferList(sample, blockBufferAllocator: kCFAllocatorDefault,
        blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: buffer.audioBufferList) == noErr else { return }
    queue.async { self.append(sample, input: self.audio) }
  }

  private func append(_ sample: CMSampleBuffer, input: AVAssetWriterInput) {
    guard accepting else { return }
    let pts = sample.presentationTimeStamp
    if startTime == nil {
      // Start on the first video frame, discarding earlier audio; no preroll.
      guard input === video else { return }
      startTime = pts
      writer.initialSegmentStartTime = .zero
      guard writer.startWriting() else { accepting = false; onFailure(writer.error?.localizedDescription ?? "Could not start recording"); return }
      writer.startSession(atSourceTime: .zero)
    }
    guard let startTime, pts >= startTime else { return }
    if (pts - startTime).seconds >= maxDuration {
      accepting = false
      Task { _ = try? await self.stop() }
      return
    }
    var timingCount = 0
    guard CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &timingCount) == noErr else { accepting = false; return }
    var timings = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .invalid, decodeTimeStamp: .invalid), count: timingCount)
    guard CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: timingCount, arrayToFill: &timings, entriesNeededOut: nil) == noErr else { accepting = false; return }
    for index in timings.indices {
      timings[index].presentationTimeStamp = timings[index].presentationTimeStamp - startTime
      if timings[index].decodeTimeStamp.isValid { timings[index].decodeTimeStamp = timings[index].decodeTimeStamp - startTime }
    }
    var normalized: CMSampleBuffer?
    guard CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: sample, sampleTimingEntryCount: timingCount, sampleTimingArray: &timings, sampleBufferOut: &normalized) == noErr, let normalized else { accepting = false; return }
    if input.isReadyForMoreMediaData, !input.append(normalized) { accepting = false; onFailure(writer.error?.localizedDescription ?? "Could not save recording") }
  }

  func assetWriter(_ writer: AVAssetWriter, didOutputSegmentData data: Data,
                   segmentType: AVAssetSegmentType, segmentReport: AVAssetSegmentReport?) {
    diskQueue.sync {
      guard diskError == nil else { return }
      do {
        let filename = segmentType == .initialization ? "init.mp4" : String(format: "segment-%06d.m4s", segmentCount)
        try data.write(to: directory.appendingPathComponent(filename), options: .atomic)
        if segmentType != .initialization { segmentCount += 1 }
      } catch { diskError = error; onFailure(error.localizedDescription) }
    }
  }

  func stop() async throws -> Int {
    let task: Task<Int, Error> = queue.sync {
      if let stopTask { return stopTask }
      accepting = false
      let task = Task<Int, Error> {
        guard self.writer.status == .writing else {
          throw self.writer.error ?? NSError(domain: "SegmentedRecorder", code: 3, userInfo: [NSLocalizedDescriptionKey: "No media was captured"])
        }
        self.video.markAsFinished()
        self.audio.markAsFinished()
        await self.writer.finishWriting()
        guard self.writer.status == .completed else {
          throw self.writer.error ?? NSError(domain: "SegmentedRecorder", code: 4)
        }
        return try self.diskQueue.sync {
          if let error = self.diskError { throw error }
          let marker = try JSONSerialization.data(withJSONObject: ["segmentCount": self.segmentCount])
          try marker.write(to: self.directory.appendingPathComponent("finished.json"), options: .atomic)
          return self.segmentCount
        }
      }
      stopTask = task
      return task
    }
    return try await task.value
  }
}
