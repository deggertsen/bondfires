package org.bondfires.livepublisher

import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
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
  @Field val width: Int = 1080
  @Field val height: Int = 1920
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
      val context = appContext.reactContext ?: return@AsyncFunction false

      // 1) Camera permission via package manager
      val hasCameraPerm = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
        context.checkSelfPermission(android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
      } else {
        // Pre-M permissions are granted at install time
        true
      }

      if (!hasCameraPerm) {
        Log.w(TAG, "isAvailable: CAMERA permission not granted")
        return@AsyncFunction false
      }

      // 2) At least one camera available
      return@AsyncFunction try {
        val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
        val cameras = cameraManager?.cameraIdList
        val available = !cameras.isNullOrEmpty()
        if (!available) {
          Log.w(TAG, "isAvailable: no cameras found on device")
        }
        available
      } catch (e: Exception) {
        Log.e(TAG, "isAvailable: error enumerating cameras", e)
        false
      }
    }

    AsyncFunction("getCameraCount") {
      val context = appContext.reactContext ?: return@AsyncFunction 0
      return@AsyncFunction try {
        val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
        cameraManager?.cameraIdList?.size ?: 0
      } catch (e: Exception) {
        Log.e(TAG, "getCameraCount: error enumerating cameras", e)
        0
      }
    }

    AsyncFunction("start") Coroutine { options: LivePublisherStartOptions ->
      val context = appContext.reactContext
        ?: throw LivePublisherException("No React context available")

      // Build the RTMPS URL
      val rtmpsUrl = buildRtmpsUrl(options.rtmpsUrl, options.streamKey)
      currentFacing = options.initialCamera
      val cameraId = findCameraIdForFacing(currentFacing)

      // Query camera for best supported output resolution to avoid fisheye distortion
      val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
      val resolution = getBestCameraResolution(cameraManager, cameraId, options.width, options.height)

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
        resolution = resolution,
        fps = options.fps,
        gopDurationInS = 2.0f,
      )
      newStreamer.setVideoConfig(videoConfig)

      // Bind preview with proper aspect ratio
      previewView?.let { pv ->
        pv.setVideoSourceProvider(newStreamer)
        pv.scaleType = android.widget.ImageView.ScaleType.CENTER_CROP
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

  /**
   * Query the camera's supported output resolutions and pick the best match for encoding.
   * Matching the camera's output aspect ratio avoids stretching a 9:16 encoder size
   * across sensors that expose a different native video shape.
   */
  private fun getBestCameraResolution(
    cameraManager: CameraManager,
    cameraId: String,
    desiredWidth: Int,
    desiredHeight: Int,
  ): Size {
    return try {
      val characteristics = cameraManager.getCameraCharacteristics(cameraId)
      val configMap = characteristics.get(
        CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP
      )
      val outputSizes = configMap?.getOutputSizes(android.media.MediaCodec::class.java)
        ?: configMap?.getOutputSizes(android.graphics.SurfaceTexture::class.java)
        ?: return Size(1080, 1920)

      val portraitSizes = outputSizes
        .filter { it.height >= it.width && it.height >= 480 }
        .sortedByDescending { it.width.toLong() * it.height.toLong() }

      if (portraitSizes.isEmpty()) {
        return Size(1080, 1920)
      }

      val requestedAspectRatio = desiredWidth.toDouble() / desiredHeight.toDouble()
      val targetPixels = desiredWidth * desiredHeight
      val aspectRatioTolerance = 0.05

      val matchedSizes = portraitSizes.filter { size ->
        val aspectRatio = size.width.toDouble() / size.height.toDouble()
        Math.abs(aspectRatio - requestedAspectRatio) < aspectRatioTolerance
      }

      if (matchedSizes.isNotEmpty()) {
        return matchedSizes.minByOrNull { size ->
          Math.abs(size.width * size.height - targetPixels)
        } ?: Size(1080, 1920)
      }

      val aspectRatioGroups = portraitSizes.groupBy { size ->
        Math.round(size.width.toDouble() / size.height.toDouble() * 100.0) / 100.0
      }
      val largestAspectRatioGroup =
        aspectRatioGroups.maxByOrNull { it.value.size }?.value ?: portraitSizes

      val fullHdPortraitPixels = 1080 * 1920
      largestAspectRatioGroup.minByOrNull { size ->
        Math.abs(size.width * size.height - fullHdPortraitPixels)
      } ?: Size(1080, 1920)
    } catch (e: Exception) {
      Log.w(TAG, "Failed to query camera resolutions, falling back to 1080x1920", e)
      Size(1080, 1920)
    }
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
