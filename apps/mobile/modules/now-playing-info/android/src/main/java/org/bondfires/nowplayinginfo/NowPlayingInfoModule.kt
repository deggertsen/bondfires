package org.bondfires.nowplayinginfo

import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NowPlayingInfoModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var mediaSession: MediaSessionCompat? = null

  private val mediaSessionCallback = object : MediaSessionCompat.Callback() {
    override fun onPlay() {
      sendEvent("remoteCommand", mapOf("command" to "play"))
    }

    override fun onPause() {
      sendEvent("remoteCommand", mapOf("command" to "pause"))
    }

    override fun onSeekTo(positionMs: Long) {
      sendEvent(
        "remoteCommand",
        mapOf(
          "command" to "seek",
          "position" to positionMs.coerceAtLeast(0L) / MILLIS_PER_SECOND,
        ),
      )
    }
  }

  override fun definition() = ModuleDefinition {
    Name("NowPlayingInfo")

    Events("remoteCommand")

    AsyncFunction("setMetadata") {
      artist: String,
      title: String,
      album: String,
      duration: Double,
      ->
      val session = ensureMediaSession()
      val durationMs = secondsToMilliseconds(duration)
      session.setMetadata(
        MediaMetadataCompat.Builder()
          .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
          .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
          .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
          .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
          .build(),
      )
      session.isActive = true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setPlaybackState") { playing: Boolean, position: Double ->
      val session = ensureMediaSession()
      val state = if (playing) {
        PlaybackStateCompat.STATE_PLAYING
      } else {
        PlaybackStateCompat.STATE_PAUSED
      }
      val speed = if (playing) 1f else 0f
      session.setPlaybackState(
        PlaybackStateCompat.Builder()
          .setActions(PLAYBACK_ACTIONS)
          .setState(state, secondsToMilliseconds(position), speed, SystemClock.elapsedRealtime())
          .build(),
      )
      session.isActive = true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearMetadata") {
      clearSessionMetadata()
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      val session = mediaSession
      mediaSession = null
      mainHandler.post {
        session?.release()
      }
    }
  }

  private fun ensureMediaSession(): MediaSessionCompat {
    mediaSession?.let { return it }

    val context = appContext.reactContext
      ?: throw IllegalStateException("React context is unavailable")
    return MediaSessionCompat(context, SESSION_TAG).also { session ->
      session.setCallback(mediaSessionCallback)
      session.setPlaybackToLocal(AudioManager.STREAM_MUSIC)
      session.setFlags(
        MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
          MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS,
      )
      mediaSession = session
    }
  }

  private fun clearSessionMetadata() {
    mediaSession?.apply {
      setMetadata(null)
      setPlaybackState(
        PlaybackStateCompat.Builder()
          .setState(PlaybackStateCompat.STATE_NONE, 0L, 0f)
          .build(),
      )
      isActive = false
    }
  }

  private fun secondsToMilliseconds(seconds: Double): Long {
    if (!seconds.isFinite() || seconds <= 0) return 0L
    return (seconds * MILLIS_PER_SECOND).toLong()
  }

  private companion object {
    const val SESSION_TAG = "BondfiresNowPlaying"
    const val MILLIS_PER_SECOND = 1_000.0
    const val PLAYBACK_ACTIONS =
      PlaybackStateCompat.ACTION_PLAY or
        PlaybackStateCompat.ACTION_PAUSE or
        PlaybackStateCompat.ACTION_PLAY_PAUSE or
        PlaybackStateCompat.ACTION_SEEK_TO
  }
}
