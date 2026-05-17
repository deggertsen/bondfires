package org.bondfires.livepublisher

import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.MediaFormat
import android.util.Log
import android.util.Size
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.views.ExpoView
import io.github.thibaultbee.streampack.core.elements.sources.audio.audiorecord.MicrophoneSourceFactory
import io.github.thibaultbee.streampack.core.interfaces.startStream
import io.github.thibaultbee.streampack.core.streamers.single.AudioConfig
import io.github.thibaultbee.streampack.core.streamers.single.SingleStreamer
import io.github.thibaultbee.streampack.core.streamers.single.VideoConfig
import io.github.thibaultbee.streampack.core.streamers.single.cameraSingleStreamer
import io.github.thibaultbee.streampack.ui.views.PreviewView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class LivePublisherStartOptions : Record {
  @Field val rtmpsUrl: String = ""
  @Field val streamKey: String = ""
  @Field val width: Int = 720
  @Field val height: Int = 1280
  @Field val fps: Int = 30
  @Field val videoBitrate: Int = 2_500_000
  @Field val audioBitrate: Int = 128_000
  @Field val initialCamera: String = "front"
}

class BondfireLivePublisherModule : Module() {
  companion object {
    private const val TAG = "BondfireLivePublisher"

    @Volatile
    var currentInstance: BondfireLivePublisherModule? = null
      private set
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var streamer: SingleStreamer? = null
  private var isMuted = false

  var previewView: PreviewView? = null
    private set

  override fun definition() = ModuleDefinition {
    Name("BondfireLivePublisher")

    Events("statusChange", "error")

    OnCreate {
      BondfireLivePublisherModule.currentInstance = this@BondfireLivePublisherModule
    }

    OnDestroy {
      BondfireLivePublisherModule.currentInstance = null
      scope.launch {
        cleanupStreamer()
      }
    }

    AsyncFunction("isAvailable") {
      true
    }

    AsyncFunction("start") { options: LivePublisherStartOptions ->
      val context = appContext.reactContext
        ?: throw LivePublisherException("No React context available")

      // Build the RTMPS URL
      val rtmpsUrl = buildRtmpsUrl(options.rtmpsUrl, options.streamKey)

      // Create camera + microphone streamer
      val newStreamer = cameraSingleStreamer(
        context,
        audioSourceFactory = MicrophoneSourceFactory()
      )
      streamer = newStreamer

      // Configure audio
      val audioConfig = AudioConfig(
        mimeType = MediaFormat.MIMETYPE_AUDIO_AAC,
        startBitrate = options.audioBitrate,
        sampleRate = 44100,
        channelConfig = AudioFormat.CHANNEL_IN_MONO,
      )
      newStreamer.setAudioConfig(audioConfig)

      // Configure video
      val videoConfig = VideoConfig(
        startBitrate = options.videoBitrate,
        resolution = Size(options.width, options.height),
        fps = options.fps,
      )
      newStreamer.setVideoConfig(videoConfig)

      // Set initial camera lens facing
      setLensFacing(newStreamer, options.initialCamera)

      // Bind preview if already set
      previewView?.let { pv ->
        pv.setVideoSourceProvider(newStreamer)
      }

      // Ensure unmuted at start
      isMuted = false

      // Connect and start streaming
      try {
        sendEvent("statusChange", "connecting")
        newStreamer.startStream(rtmpsUrl)
        // startStream blocks until successful connection or throws
        sendEvent("statusChange", "live")
      } catch (e: Exception) {
        Log.e(TAG, "Failed to start stream", e)
        sendEvent(
          "error", mapOf(
            "code" to "start_stream_failed",
            "message" to (e.message ?: "Failed to start RTMPS stream")
          )
        )
        sendEvent("statusChange", "errored")
        throw LivePublisherException("Failed to start RTMPS stream: ${e.message}")
      }
    }

    AsyncFunction("stop") {
      sendEvent("statusChange", "ended")
      cleanupStreamer()
    }

    AsyncFunction("swapCamera") {
      val s = streamer ?: return@AsyncFunction
      // Toggle between front and back — StreamPack uses camera IDs.
      // For simplicity, use the front/back lens facing API.
      val currentFacing = s.getLensFacing() ?: return@AsyncFunction
      // getLensFacing returns null if camera info is unavailable
      if (currentFacing == android.hardware.camera2.CameraCharacteristics.LENS_FACING_FRONT) {
        setLensFacing(s, "back")
      } else {
        setLensFacing(s, "front")
      }
    }

    AsyncFunction("setMuted") { muted: Boolean ->
      val s = streamer ?: return@AsyncFunction
      isMuted = muted
      // StreamPack 3.x doesn't have a direct mute() on the streamer.
      // We swap audio source: null for mute, MicrophoneSourceFactory for unmute.
      if (muted) {
        s.setAudioSource(null)
      } else {
        s.setAudioSource(MicrophoneSourceFactory())
      }
    }

    AsyncFunction("getStats") {
      mapOf(
        "bitrateBps" to 0,
        "rttMs" to 0,
        "droppedFrames" to 0,
      )
    }

    View(BondfireLivePublisherView::class) {}
  }

  private fun buildRtmpsUrl(rtmpsUrl: String, streamKey: String): String {
    return if (rtmpsUrl.endsWith("/")) {
      rtmpsUrl + streamKey
    } else {
      "$rtmpsUrl/$streamKey"
    }
  }

  private fun setLensFacing(streamer: SingleStreamer, facing: String) {
    val cameraId = if (facing == "back") {
      findCameraId(android.hardware.camera2.CameraCharacteristics.LENS_FACING_BACK)
    } else {
      findCameraId(android.hardware.camera2.CameraCharacteristics.LENS_FACING_FRONT)
    }
    if (cameraId != null) {
      streamer.setCameraId(cameraId)
    }
  }

  private fun findCameraId(lensFacing: Int): String? {
    val context = appContext.reactContext ?: return null
    val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as? android.hardware.camera2.CameraManager
      ?: return null
    return cameraManager.cameraIdList.firstOrNull { id ->
      val characteristics = cameraManager.getCameraCharacteristics(id)
      characteristics.get(android.hardware.camera2.CameraCharacteristics.LENS_FACING) == lensFacing
    }
  }

  private suspend fun cleanupStreamer() {
    val s = streamer ?: return
    try {
      s.stopStream()
    } catch (e: Exception) {
      Log.w(TAG, "Error stopping stream", e)
    }
    try {
      s.close()
    } catch (e: Exception) {
      Log.w(TAG, "Error closing streamer", e)
    }
    try {
      s.release()
    } catch (e: Exception) {
      Log.w(TAG, "Error releasing streamer", e)
    }
    streamer = null
    isMuted = false
  }
}

class BondfireLivePublisherView(context: Context, appContext: expo.modules.kotlin.AppContext) :
  ExpoView(context, appContext) {

  val previewView: PreviewView = PreviewView(context, appContext)

  init {
    addView(previewView)
    val module = BondfireLivePublisherModule.currentInstance
    module?.previewView = previewView

    // Bind video source if streamer already exists
    module?.let { m ->
      m.previewView?.setVideoSourceProvider(it)
    }
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    previewView.layout(0, 0, right - left, bottom - top)
  }
}

class LivePublisherException(message: String) : CodedException(message)
