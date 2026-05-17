package org.bondfires.livepublisher

import android.content.Context
import android.media.AudioFormat
import android.media.MediaFormat
import android.util.Log
import android.util.Size
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.views.ExpoView
import io.github.thibaultbee.streampack.core.elements.encoders.AudioCodecConfig
import io.github.thibaultbee.streampack.core.elements.encoders.VideoCodecConfig
import io.github.thibaultbee.streampack.core.elements.sources.audio.audiorecord.MicrophoneSourceFactory
import io.github.thibaultbee.streampack.core.elements.sources.video.camera.CameraSourceFactory
import io.github.thibaultbee.streampack.core.interfaces.startStream
import io.github.thibaultbee.streampack.core.streamers.single.SingleStreamer
import io.github.thibaultbee.streampack.core.streamers.single.cameraSingleStreamer
import io.github.thibaultbee.streampack.ext.rtmp.elements.endpoints.RtmpEndpointFactory
import io.github.thibaultbee.streampack.ui.views.PreviewView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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
  private var currentFacing: String = "front"

  var previewView: PreviewView? = null

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

    AsyncFunction("start") Coroutine { options: LivePublisherStartOptions ->
      val context = appContext.reactContext
        ?: throw LivePublisherException("No React context available")

      // Build the RTMPS URL
      val rtmpsUrl = buildRtmpsUrl(options.rtmpsUrl, options.streamKey)
      currentFacing = options.initialCamera
      val cameraId = findCameraIdForFacing(currentFacing)

      // Create camera + microphone streamer
      val newStreamer = cameraSingleStreamer(
        context,
        cameraId = cameraId,
        audioSourceFactory = MicrophoneSourceFactory(),
        endpointFactory = RtmpEndpointFactory(),
      )
      streamer = newStreamer

      // Configure audio
      val audioConfig = AudioCodecConfig(
        mimeType = MediaFormat.MIMETYPE_AUDIO_AAC,
        startBitrate = options.audioBitrate,
        sampleRate = 44100,
        channelConfig = AudioFormat.CHANNEL_IN_MONO,
        byteFormat = AudioFormat.ENCODING_PCM_16BIT,
      )
      newStreamer.setAudioConfig(audioConfig)

      // Configure video
      val videoConfig = VideoCodecConfig(
        mimeType = MediaFormat.MIMETYPE_VIDEO_AVC,
        startBitrate = options.videoBitrate,
        resolution = Size(options.width, options.height),
        fps = options.fps,
        gopDurationInS = 2.0f,
      )
      newStreamer.setVideoConfig(videoConfig)

      // Bind preview if already set
      previewView?.let { pv ->
        pv.setVideoSourceProvider(newStreamer)
      }

      // Ensure unmuted at start
      isMuted = false

      // Connect and start streaming
      try {
        sendStatus("connecting")
        newStreamer.startStream(rtmpsUrl)
        // startStream blocks until successful connection or throws
        sendStatus("live")
      } catch (e: Exception) {
        Log.e(TAG, "Failed to start stream", e)
        sendEvent(
          "error", mapOf(
            "code" to "start_stream_failed",
            "message" to (e.message ?: "Failed to start RTMPS stream")
          )
        )
        sendStatus("errored")
        throw LivePublisherException("Failed to start RTMPS stream: ${e.message}")
      }
    }

    AsyncFunction("stop") Coroutine { ->
      sendStatus("ended")
      cleanupStreamer()
    }

    AsyncFunction("swapCamera") Coroutine { ->
      val s = streamer ?: return@Coroutine
      currentFacing = if (currentFacing == "front") "back" else "front"
      s.setVideoSource(CameraSourceFactory(findCameraIdForFacing(currentFacing)))
      previewView?.setVideoSourceProvider(s)
    }

    AsyncFunction("setMuted") Coroutine { muted: Boolean ->
      val s = streamer ?: return@Coroutine
      isMuted = muted
      s.audioInput?.isMuted = muted
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

  private fun findCameraIdForFacing(facing: String): String {
    val lensFacing = if (facing == "back") {
      android.hardware.camera2.CameraCharacteristics.LENS_FACING_BACK
    } else {
      android.hardware.camera2.CameraCharacteristics.LENS_FACING_FRONT
    }
    val context = appContext.reactContext
      ?: throw LivePublisherException("No React context available")
    val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as? android.hardware.camera2.CameraManager
      ?: throw LivePublisherException("Camera service unavailable")
    return cameraManager.cameraIdList.firstOrNull { id ->
      val characteristics = cameraManager.getCameraCharacteristics(id)
      characteristics.get(android.hardware.camera2.CameraCharacteristics.LENS_FACING) == lensFacing
    } ?: cameraManager.cameraIdList.firstOrNull()
      ?: throw LivePublisherException("No camera available")
  }

  fun attachPreview(view: PreviewView) {
    previewView = view
    streamer?.let { s ->
      scope.launch {
        view.setVideoSourceProvider(s)
      }
    }
  }

  private fun sendStatus(status: String) {
    sendEvent("statusChange", mapOf("status" to status))
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

  val previewView: PreviewView = PreviewView(context)

  init {
    addView(previewView)
    BondfireLivePublisherModule.currentInstance?.attachPreview(previewView)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    previewView.layout(0, 0, right - left, bottom - top)
  }
}

class LivePublisherException(message: String) : CodedException(message)
