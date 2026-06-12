package org.bondfires.livepublisher

import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioFormat
import android.media.MediaCodecList
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
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

class LivePublisherStartOptions : Record {
  @Field val rtmpsUrl: String = ""
  @Field val streamKey: String = ""
  @Field val width: Int = 0
  @Field val height: Int = 0
  @Field val fps: Int = 30
  @Field val videoBitrate: Int = 2_500_000
  @Field val audioBitrate: Int = 128_000
  @Field val initialCamera: String = "front"
}

class LivePublisherPreviewOptions : Record {
  @Field val fps: Int = 30
  @Field val videoBitrate: Int = 2_500_000
  @Field val audioBitrate: Int = 128_000
  @Field val initialCamera: String = "front"
}

/**
 * Wire statuses — keep in sync with NATIVE_PUBLISHER_STATUSES in
 * packages/app/src/store/livePublisherContract.ts and the Swift
 * PublisherStatus enum (parity table in the module README).
 */
enum class PublisherStatus(val wire: String) {
  CONNECTING("connecting"),
  LIVE("live"),
  RECONNECTING("reconnecting"),
  ENDED("ended"),
  ERRORED("errored"),
  STREAM_STOPPED_UNEXPECTEDLY("stream_stopped_unexpectedly"),
  ENDPOINT_CLOSED("endpoint_closed"),
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
  // Flow collectors for the current streamer. Cancelled in cleanupStreamer so
  // a torn-down streamer can never emit stale events into a new session.
  private val collectorJobs = mutableListOf<Job>()
  private var isMuted = false
  private var currentFacing: String = "front"
  @Volatile
  private var isStoppingIntentionally = false

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

    AsyncFunction("startPreview") Coroutine { options: LivePublisherPreviewOptions ->
      // Camera preview only — nothing is connected or streamed until start() is called.
      if (streamer != null) {
        return@Coroutine
      }
      currentFacing = options.initialCamera
      createStreamer(
        fps = options.fps,
        videoBitrate = options.videoBitrate,
        audioBitrate = options.audioBitrate,
      )
    }

    AsyncFunction("start") Coroutine { options: LivePublisherStartOptions ->
      // Build the RTMPS URL
      val rtmpsUrl = buildRtmpsUrl(options.rtmpsUrl, options.streamKey)

      // Reuse the previewing streamer when startPreview() already ran;
      // otherwise set the capture pipeline up now.
      if (streamer == null) {
        currentFacing = options.initialCamera
        createStreamer(
          fps = options.fps,
          videoBitrate = options.videoBitrate,
          audioBitrate = options.audioBitrate,
        )
      }
      val activeStreamer = streamer
        ?: throw LivePublisherException("Streamer unavailable")

      // Connect and start streaming
      try {
        sendStatus(PublisherStatus.CONNECTING)
        activeStreamer.startStream(rtmpsUrl)
        // startStream blocks until successful connection or throws
        sendStatus(PublisherStatus.LIVE)
      } catch (e: Exception) {
        Log.e(TAG, "Failed to start stream", e)
        sendEvent(
          "error", mapOf(
            "code" to "start_stream_failed",
            "message" to (e.message ?: "Failed to start RTMPS stream")
          )
        )
        sendStatus(PublisherStatus.ERRORED)
        throw LivePublisherException("Failed to start RTMPS stream: ${e.message}")
      }
    }

    AsyncFunction("stop") Coroutine { ->
      sendStatus(PublisherStatus.ENDED)
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

  /**
   * Create the camera + microphone streamer and bind the preview view.
   * This powers the camera preview but does NOT open any network connection —
   * streaming only begins when startStream() is called in start().
   */
  private suspend fun createStreamer(fps: Int, videoBitrate: Int, audioBitrate: Int) {
    val context = appContext.reactContext
      ?: throw LivePublisherException("No React context available")

    val cameraId = findCameraIdForFacing(currentFacing)

    // Query camera for a supported output resolution to avoid stretching frames.
    val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val resolution = getBestCameraResolution(cameraManager, cameraId, 0, 0)
    Log.i(TAG, "Using camera output resolution ${resolution.width}x${resolution.height}")

    // Create camera + microphone streamer
    val newStreamer = cameraSingleStreamer(
      context,
      cameraId = cameraId,
      audioSourceFactory = MicrophoneSourceFactory(),
      endpointFactory = RtmpEndpointFactory(),
    )
    streamer = newStreamer

    // Collect StreamPack internal errors (encoder failures, codec crashes,
    // camera disconnects, etc.) and forward them to JS as error events.
    // Without this, the app has zero visibility into why a recording freezes
    // or truncates.
    collectorJobs += scope.launch {
      newStreamer.throwableFlow.collect { throwable ->
        if (throwable == null) return@collect
        val msg = throwable.message ?: throwable.javaClass.simpleName
        Log.e(TAG, "Streamer internal error: $msg", throwable)
        // Errors surfacing during/after teardown belong to a dead session;
        // forwarding them would mark a subsequent healthy session as failed.
        if (streamer !== newStreamer || isStoppingIntentionally) return@collect
        sendEvent(
          "error", mapOf(
            "code" to "streamer_internal_error",
            "message" to msg,
            "throwableClass" to throwable.javaClass.name,
          )
        )
      }
    }

    // Track streaming state changes so we can detect unexpected drops.
    // If isStreaming goes false without us calling stop(), the encoder
    // crashed or the RTMP connection dropped.
    // NOTE: isStreamingFlow is a StateFlow — it replays its current value
    // (false) on subscribe, and it also goes false during intentional stop().
    // Only a true -> false transition outside an intentional stop is a drop.
    collectorJobs += scope.launch {
      var wasStreaming = false
      newStreamer.isStreamingFlow.collect { isStreaming ->
        Log.i(TAG, "Streamer isStreaming changed: $isStreaming (intentionalStop=$isStoppingIntentionally)")
        val dropped = wasStreaming && !isStreaming
        wasStreaming = isStreaming
        if (dropped && !isStoppingIntentionally && streamer === newStreamer) {
          sendEvent(
            "statusChange", mapOf("status" to PublisherStatus.STREAM_STOPPED_UNEXPECTEDLY.wire)
          )
        }
      }
    }

    // Track endpoint open/close state — if the RTMP connection drops
    // (network, Mux side), isOpen goes false.
    // NOTE: isOpenFlow is also a StateFlow with the same replay/intentional
    // stop caveats as isStreamingFlow above.
    collectorJobs += scope.launch {
      var wasOpen = false
      newStreamer.isOpenFlow.collect { isOpen ->
        Log.i(TAG, "Streamer isOpen changed: $isOpen (intentionalStop=$isStoppingIntentionally)")
        val closed = wasOpen && !isOpen
        wasOpen = isOpen
        if (closed && !isStoppingIntentionally && streamer === newStreamer) {
          sendEvent(
            "statusChange", mapOf("status" to PublisherStatus.ENDPOINT_CLOSED.wire)
          )
        }
      }
    }

    // Configure audio
    val audioConfig = AudioCodecConfig(
      mimeType = MediaFormat.MIMETYPE_AUDIO_AAC,
      startBitrate = audioBitrate,
      sampleRate = 44100,
      channelConfig = AudioFormat.CHANNEL_IN_MONO,
      byteFormat = AudioFormat.ENCODING_PCM_16BIT,
    )
    newStreamer.setAudioConfig(audioConfig)

    // Configure video
    val videoConfig = VideoCodecConfig(
      mimeType = MediaFormat.MIMETYPE_VIDEO_AVC,
      startBitrate = videoBitrate,
      resolution = resolution,
      fps = fps,
      gopDurationInS = 2.0f,
    )
    try {
      newStreamer.setVideoConfig(videoConfig)
    } catch (e: Exception) {
      Log.w(TAG, "Video config with ${resolution.width}x${resolution.height} failed, falling back to 720x1280", e)
      val fallbackConfig = VideoCodecConfig(
        mimeType = MediaFormat.MIMETYPE_VIDEO_AVC,
        startBitrate = videoBitrate,
        resolution = Size(720, 1280),
        fps = fps,
        gopDurationInS = 2.0f,
      )
      newStreamer.setVideoConfig(fallbackConfig)
    }

    // Bind preview — StreamPack PreviewView fills the view by default.
    previewView?.setVideoSourceProvider(newStreamer)

    // Ensure unmuted at start
    isMuted = false
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
   * Query the camera's supported output resolutions and pick an encoder size that
   * matches the selected camera's native output shape. Hardcoding portrait sizes
   * can stretch landscape camera frames and cause distorted recordings.
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
        ?: return fallbackCameraResolution(desiredWidth, desiredHeight)

      val usableSizes = outputSizes.filter { it.width > 0 && it.height > 0 }

      if (usableSizes.isEmpty()) {
        return fallbackCameraResolution(desiredWidth, desiredHeight)
      }

      val sensorRect = characteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
      val requestedAspectRatio =
        if (desiredWidth > 0 && desiredHeight > 0) {
          normalizedAspectRatio(desiredWidth, desiredHeight)
        } else if (sensorRect != null && sensorRect.width() > 0 && sensorRect.height() > 0) {
          normalizedAspectRatio(sensorRect.width(), sensorRect.height())
        } else {
          normalizedAspectRatio(1920, 1080)
        }
      val aspectRatioTolerance = 0.05

      val matchedSizes = usableSizes.filter { size ->
        val aspectRatio = normalizedAspectRatio(size.width, size.height)
        Math.abs(aspectRatio - requestedAspectRatio) < aspectRatioTolerance
      }
      val candidateSizes = if (matchedSizes.isNotEmpty()) matchedSizes else usableSizes
      val fullHdPixels = 1920L * 1080L
      val cappedSizes = candidateSizes.filter { size ->
        size.width.toLong() * size.height.toLong() <= fullHdPixels
      }
      val preferredSizes = if (cappedSizes.isNotEmpty()) cappedSizes else candidateSizes

      val bestSize = preferredSizes.maxByOrNull { size ->
        size.width.toLong() * size.height.toLong()
      } ?: return fallbackCameraResolution(desiredWidth, desiredHeight)

      // Validate that the AVC encoder actually supports this resolution.
      // Some devices report MediaCodec output sizes that their hardware AVC
      // encoder rejects with InvalidParameterException.
      val avcEncoder = try {
        MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.firstOrNull { info ->
          info.isEncoder && info.supportedTypes.contains(MediaFormat.MIMETYPE_VIDEO_AVC)
        }
      } catch (_: Exception) {
        null
      }
      if (avcEncoder != null) {
        val capabilities = avcEncoder.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
        val encoderCaps = capabilities.videoCapabilities
        if (encoderCaps != null && !encoderCaps.isSizeSupported(bestSize.width, bestSize.height)) {
          Log.w(TAG, "AVC encoder does not support ${bestSize.width}x${bestSize.height}, falling back")
          return fallbackCameraResolution(desiredWidth, desiredHeight)
        }
      }

      bestSize
    } catch (e: Exception) {
      Log.w(TAG, "Failed to query camera resolutions, falling back to default", e)
      fallbackCameraResolution(desiredWidth, desiredHeight)
    }
  }

  private fun normalizedAspectRatio(width: Int, height: Int): Double {
    val longEdge = maxOf(width, height).toDouble()
    val shortEdge = minOf(width, height).toDouble()
    return longEdge / shortEdge
  }

  private fun fallbackCameraResolution(width: Int, height: Int): Size {
    return if (width > 0 && height > 0) {
      Size(width, height)
    } else {
      Size(1920, 1080)
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

  private fun sendStatus(status: PublisherStatus) {
    sendEvent("statusChange", mapOf("status" to status.wire))
  }

  private suspend fun cleanupStreamer() {
    val s = streamer ?: return
    isStoppingIntentionally = true
    streamer = null
    isMuted = false

    // Cancel the flow collectors before tearing anything down. If release()
    // times out below, the old streamer's flows stay live in the background —
    // without this, a late emission after isStoppingIntentionally resets
    // would surface as a bogus error/drop on the next session.
    collectorJobs.forEach { it.cancel() }
    collectorJobs.clear()

    // On some devices, calling stopStream() triggers a native SIGSEGV inside
    // MediaCodec teardown — a signal-level crash that no Kotlin try/catch can
    // survive. The app dies, Mux never sees an RTMP disconnect, and the stream
    // runs until server-side timeout.
    //
    // We skip stopStream() entirely and go directly to close() + release()
    // with a generous timeout on a background thread. If the encoder is hung,
    // the timeout cancels the coroutine and we accept a small resource leak in
    // exchange for keeping the app alive.
    Log.i(TAG, "cleanupStreamer: beginning teardown (no stopStream)")
    runBlockingWithTimeout(5000) {
      try {
        // close() sends an RTMP disconnect and tears down the encoder;
        // it's equivalent to stopStream+close but without the synchronous
        // MediaCodec.stop() that triggers the SIGSEGV on affected devices.
        s.close()
        Log.i(TAG, "cleanupStreamer: close() completed")
      } catch (e: Exception) {
        Log.w(TAG, "Error closing streamer (encoder may have already crashed)", e)
      }

      delay(200)

      try {
        s.release()
        Log.i(TAG, "cleanupStreamer: release() completed")
      } catch (e: Exception) {
        Log.w(TAG, "Error releasing streamer", e)
      }
    }

    isStoppingIntentionally = false
  }

  /**
   * Run [block] on the IO dispatcher, cancelling it after [timeoutMs].
   * This protects against native codec teardown hangs that would otherwise
   * block the calling coroutine forever.
   */
  private suspend fun runBlockingWithTimeout(
    timeoutMs: Long,
    block: suspend () -> Unit,
  ) {
    try {
      kotlinx.coroutines.withTimeout(timeoutMs) {
        kotlinx.coroutines.withContext(Dispatchers.IO) {
          block()
        }
      }
    } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
      Log.w(TAG, "Streamer cleanup timed out after ${timeoutMs}ms — resources may leak", e)
    } catch (e: Exception) {
      Log.w(TAG, "Unexpected error during streamer cleanup", e)
    }
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
    val width = right - left
    val height = bottom - top
    // React Native skips the native measure pass for manually-added children.
    // Without an explicit measure, PreviewView's measured size stays 0x0 and it
    // lays out its internal SurfaceView at zero size, so no preview surface is
    // ever created and the camera preview renders black.
    previewView.measure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
    )
    previewView.layout(0, 0, width, height)
  }

  // React Native owns layout via Yoga and ignores native requestLayout() calls,
  // so when StreamPack's viewfinder resizes its internal SurfaceView after the
  // camera surface is ready, the layout pass never happens. Re-run it manually.
  override fun requestLayout() {
    super.requestLayout()
    post(measureAndLayout)
  }

  private val measureAndLayout = Runnable {
    measure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
    )
    layout(left, top, right, bottom)
  }
}

class LivePublisherException(message: String) : CodedException(message)
