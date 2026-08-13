import AVFoundation
import ExpoModulesCore
import Foundation
import MediaPlayer

public class NowPlayingInfoModule: Module {
  private var playTarget: Any?
  private var pauseTarget: Any?
  private var togglePlayPauseTarget: Any?
  private var changePlaybackPositionTarget: Any?
  private var isPlaying = false

  public func definition() -> ModuleDefinition {
    Name("NowPlayingInfo")

    Events("remoteCommand")

    AsyncFunction("setMetadata") {
      (artist: String, title: String, album: String, duration: Double) in
      try self.activateAudioSession()
      self.installRemoteCommandTargetsIfNeeded()

      let center = MPNowPlayingInfoCenter.default()
      var info = center.nowPlayingInfo ?? [:]
      info[MPMediaItemPropertyArtist] = artist
      info[MPMediaItemPropertyTitle] = title
      info[MPMediaItemPropertyAlbumTitle] = album
      info[MPMediaItemPropertyPlaybackDuration] = max(0, duration)
      info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.video.rawValue
      center.nowPlayingInfo = info
    }.runOnQueue(.main)

    AsyncFunction("setPlaybackState") { (playing: Bool, position: Double) in
      self.isPlaying = playing

      let center = MPNowPlayingInfoCenter.default()
      var info = center.nowPlayingInfo ?? [:]
      info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, position)
      info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? 1.0 : 0.0
      center.nowPlayingInfo = info
      center.playbackState = playing ? .playing : .paused
    }.runOnQueue(.main)

    AsyncFunction("clearMetadata") {
      self.isPlaying = false
      self.removeRemoteCommandTargets()

      let center = MPNowPlayingInfoCenter.default()
      center.nowPlayingInfo = nil
      center.playbackState = .stopped
    }.runOnQueue(.main)

    OnDestroy {
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.isPlaying = false
        self.removeRemoteCommandTargets()

        let center = MPNowPlayingInfoCenter.default()
        center.nowPlayingInfo = nil
        center.playbackState = .stopped
      }
    }
  }

  private func activateAudioSession() throws {
    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(.playback, mode: .moviePlayback)
    try audioSession.setActive(true)
  }

  private func installRemoteCommandTargetsIfNeeded() {
    guard playTarget == nil,
          pauseTarget == nil,
          togglePlayPauseTarget == nil,
          changePlaybackPositionTarget == nil else {
      return
    }

    let commandCenter = MPRemoteCommandCenter.shared()
    commandCenter.playCommand.isEnabled = true
    commandCenter.pauseCommand.isEnabled = true
    commandCenter.togglePlayPauseCommand.isEnabled = true
    commandCenter.changePlaybackPositionCommand.isEnabled = true

    playTarget = commandCenter.playCommand.addTarget { [weak self] _ in
      guard let self else { return .commandFailed }
      self.sendEvent("remoteCommand", ["command": "play"])
      return .success
    }

    pauseTarget = commandCenter.pauseCommand.addTarget { [weak self] _ in
      guard let self else { return .commandFailed }
      self.sendEvent("remoteCommand", ["command": "pause"])
      return .success
    }

    togglePlayPauseTarget = commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let self else { return .commandFailed }
      let command = self.isPlaying ? "pause" : "play"
      self.sendEvent("remoteCommand", ["command": command])
      return .success
    }

    changePlaybackPositionTarget = commandCenter.changePlaybackPositionCommand.addTarget {
      [weak self] event in
      guard let self,
            let positionEvent = event as? MPChangePlaybackPositionCommandEvent else {
        return .commandFailed
      }
      self.sendEvent("remoteCommand", [
        "command": "seek",
        "position": max(0, positionEvent.positionTime),
      ])
      return .success
    }
  }

  private func removeRemoteCommandTargets() {
    let commandCenter = MPRemoteCommandCenter.shared()
    commandCenter.playCommand.removeTarget(playTarget)
    commandCenter.pauseCommand.removeTarget(pauseTarget)
    commandCenter.togglePlayPauseCommand.removeTarget(togglePlayPauseTarget)
    commandCenter.changePlaybackPositionCommand.removeTarget(changePlaybackPositionTarget)

    playTarget = nil
    pauseTarget = nil
    togglePlayPauseTarget = nil
    changePlaybackPositionTarget = nil
  }
}
