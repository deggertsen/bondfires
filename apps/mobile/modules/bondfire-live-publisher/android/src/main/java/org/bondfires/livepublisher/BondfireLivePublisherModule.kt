package org.bondfires.livepublisher

import android.content.Context
import android.content.pm.PackageManager
import android.content.ComponentCallbacks2
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioFormat
import android.media.MediaCodecList
import android.media.MediaFormat
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.TrafficStats
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
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

    // statsSupported=0 zeros: the JS stall watchdog ignores these samples.
    private val STATS_ZEROS = mapOf(
      "bitrateBps" to 0,
      "rttMs" to 0,
      "droppedFrames" to 0,
      "currentFps" to 0,
      "statsSupported" to 0,
    )

    @Volatile
    var currentInstance: BondfireLivePublisherModule? = null
      private set
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  // Serializes streamer teardown so concurrent stop()/cancel()/auto-stop/
  // OnDestroy callers can never double-tear-down the same StreamPack instance.
  private val teardownLock = Any()
  @Volatile
  private var streamer: SingleStreamer? = null
  // Flow collectors for the current streamer. Cancelled in cleanupStreamer so
  // a torn-down streamer can never emit stale events into a new session.
  private val collectorJobs = mutableListOf<Job>()
  private var isMuted = false
  private var currentFacing: String = "front"
  @Volatile
  private var isStoppingIntentionally = false

  // Guards against duplicate ENDPOINT_CLOSED emissions. The default network
  // callback can fire before the RTMP socket dies, giving us a head start on
  // graceful teardown. isOpenFlow may then report the same socket drop
  // reactively, so only the first signal path should emit.
  @Volatile
  private var networkDropHandled = false

  // The ConnectivityManager.NetworkCallback registered when streaming starts
  // and unregistered during teardown.
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private val networkStateLock = Any()
  private var lastNetworkTransportTypes: Set<Int>? = null
  private var trimMemoryObserver: ComponentCallbacks2? = null

  // Baseline for the TrafficStats-delta throughput measurement in getStats().
  // StreamPack 3.x exposes no byte counters (RtmpEndpoint.getMetrics() throws
  // NotImplementedError), so we measure the app's own TX bytes between polls —
  // during a live publish the RTMP stream dominates app traffic by orders of
  // magnitude, which is exactly the signal the JS stall watchdog needs.
  // txCounterAdvanced guards against stale per-UID counters on buggy devices:
  // until the counter has moved at least once this session, samples are
  // reported unmeasurable (statsSupported=0) rather than as real zeros.
  private val statsLock = Any()
  private var lastTxBytes = -1L
  private var lastTxAtMs = 0L
  private var txCounterAdvanced = false

  // Guards against binding the camera/video source to the preview before the
  // SurfaceView has a real (non-zero) size. Binding at 0x0 makes CameraX open
  // the camera, then tear the session down and reopen once the surface sizes
  // up — and that reconfigure deadlocks the Pixel/Tensor camera HAL
  // (createCaptureSession never returns; CameraX kills it after 5s), wedging
  // the UI on "Preparing camera...". We bind exactly once, after layout.
  @Volatile
  private var previewBound = false

  var previewView: PreviewView? = null

  override fun definition() = ModuleDefinition {
    Name("BondfireLivePublisher")

    Events("statusChange", "error")

    OnCreate {
      BondfireLivePublisherModule.currentInstance = this@BondfireLivePublisherModule
      installTrimMemoryObserver()
    }

    OnDestroy {
      BondfireLivePublisherModule.currentInstance = null
      uninstallTrimMemoryObserver()
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

      // A preview-only streamer can occasionally report RTMP "streaming" while
      // never starting the video encoder after the record tap. Mux then closes
      // the connection ~5s later because it received no video data. Build a
      // fresh capture pipeline for the actual publish transition.
      cleanupStreamer()
      currentFacing = options.initialCamera
      createStreamer(
        fps = options.fps,
        videoBitrate = options.videoBitrate,
        audioBitrate = options.audioBitrate,
      )
      val activeStreamer = streamer
        ?: throw LivePublisherException("Streamer unavailable")

      // Connect and start streaming
      try {
        sendStatus(PublisherStatus.CONNECTING)
        activeStreamer.startStream(rtmpsUrl)
        // startStream blocks until successful connection or throws
        synchronized(networkStateLock) {
          networkDropHandled = false
          lastNetworkTransportTypes = null
        }
        registerNetworkCallback()
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
      if (streamer == null) {
        synchronized(statsLock) {
          lastTxBytes = -1L
          txCounterAdvanced = false
        }
        return@AsyncFunction STATS_ZEROS
      }

      synchronized(statsLock) {
        // The counter read happens inside the lock so the read + baseline
        // commit is atomic — overlapping polls could otherwise commit an
        // older reading over a newer baseline and emit a spurious
        // measured-zero sample. The binder read is sub-millisecond.
        val txBytes = TrafficStats.getUidTxBytes(android.os.Process.myUid())
        if (txBytes < 0) {
          // TrafficStats.UNSUPPORTED on this device — report an unmeasurable
          // zero so the JS stall watchdog ignores the sample.
          return@AsyncFunction STATS_ZEROS
        }

        val now = SystemClock.elapsedRealtime()
        val prevBytes = lastTxBytes
        val prevAt = lastTxAtMs
        lastTxBytes = txBytes
        lastTxAtMs = now
        if (prevBytes < 0 || now <= prevAt) {
          // First poll of this session establishes the baseline; there is no
          // interval to measure yet.
          STATS_ZEROS
        } else {
          if (txBytes != prevBytes) {
            txCounterAdvanced = true
          }
          // A per-UID counter that has never moved this session is stale or
          // broken (this app always produces some TX — telemetry flushes,
          // the Convex websocket — even with a frozen encoder). Report such
          // samples unmeasurable so a broken counter can never fail a
          // healthy recording.
          val supported = if (txCounterAdvanced) 1 else 0
          val bitrateBps = ((txBytes - prevBytes) * 8_000L / (now - prevAt))
            .coerceIn(0L, Int.MAX_VALUE.toLong())
          STATS_ZEROS + mapOf(
            "bitrateBps" to bitrateBps.toInt(),
            "statsSupported" to supported,
          )
        }
      }
    }

    // Thermal state — polled from JS during recording.
    // Returns the current PowerManager thermal status.
    AsyncFunction("getThermalState") {
      val context = appContext.reactContext
      val powerManager = context?.getSystemService(Context.POWER_SERVICE) as? PowerManager
      val level = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        powerManager?.currentThermalStatus ?: -1
      } else {
        -1
      }
      val levelName = when (level) {
        PowerManager.THERMAL_STATUS_NONE -> "nominal"
        PowerManager.THERMAL_STATUS_LIGHT -> "light"
        PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
        PowerManager.THERMAL_STATUS_SEVERE -> "severe"
        PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
        PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
        PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
        else -> "unknown"
      }
      mapOf("level" to level, "levelName" to levelName)
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

    // Drop any TX-bytes baseline left over from a previous session so the new
    // session's first getStats() re-establishes it over a fresh interval.
    synchronized(statsLock) {
      lastTxBytes = -1L
      txCounterAdvanced = false
    }

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
          // The ConnectivityManager NetworkCallback may have already fired
          // ENDPOINT_CLOSED on onLost (before the socket actually died).
          // Skip the duplicate emission if we already handled the drop.
          if (networkDropHandled) {
            Log.i(TAG, "isOpenFlow closed, but networkDropHandled already true — skipping duplicate ENDPOINT_CLOSED")
          } else {
            sendEvent(
              "statusChange", mapOf("status" to PublisherStatus.ENDPOINT_CLOSED.wire)
            )
          }
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

    // Bind preview — but only once the view has a real size (see
    // bindPreviewIfReady). If the view isn't laid out yet, the view's onLayout
    // callback will trigger the bind.
    previewBound = false
    bindPreviewIfReady()

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
    // A freshly mounted create screen brings a brand-new PreviewView. The
    // module (and its streamer) is a singleton that outlives any single screen
    // instance, so when the screen remounts while a streamer is still alive
    // (e.g. an orphaned preview session that wasn't torn down), previewBound is
    // still true from the *previous* view and bindPreviewIfReady would no-op —
    // leaving the new view permanently black / stuck on "Preparing camera...".
    // Reset the guard so this view (re)binds to the current streamer. The bind
    // itself still waits for a non-zero layout via bindPreviewIfReady.
    previewBound = false
    bindPreviewIfReady()
  }

  /**
   * Bind the camera/video source to the preview view, but only once both the
   * streamer exists AND the view has a real (non-zero) size. Binding while the
   * SurfaceView is still 0x0 makes CameraX open the camera and then reconfigure
   * the capture session when the surface finally sizes up — a reconfigure that
   * deadlocks the Pixel/Tensor camera HAL and wedges the UI on "Preparing
   * camera...". Binding once, after layout, lets CameraX configure a single
   * stable session. Idempotent and Main-thread only, so the previewBound guard
   * is race-free.
   */
  private fun bindPreviewIfReady() {
    if (previewBound) return
    val s = streamer ?: return
    val view = previewView ?: return
    if (view.width <= 0 || view.height <= 0) return
    previewBound = true
    scope.launch {
      try {
        view.setVideoSourceProvider(s)
        Log.i(TAG, "bindPreviewIfReady: bound preview at ${view.width}x${view.height}")
      } catch (e: Exception) {
        Log.e(TAG, "bindPreviewIfReady: failed to bind preview source", e)
        previewBound = false
      }
    }
  }

  /** Called by the view once it has a laid-out, non-zero size. */
  fun onPreviewLaidOut() {
    bindPreviewIfReady()
  }

  /**
   * Register a ConnectivityManager.NetworkCallback to proactively detect
   * default network loss or active transport changes during streaming.
   */
  private fun registerNetworkCallback() {
    val context = appContext.reactContext ?: return
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
      ?: return

    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onLost(network: Network) {
        emitNetworkDrop("default network lost")
      }

      override fun onAvailable(network: Network) {
        Log.i(TAG, "NetworkCallback.onAvailable — default network available")
      }

      override fun onCapabilitiesChanged(
        network: Network,
        capabilities: NetworkCapabilities
      ) {
        val currentTypes = activeTransportTypes(capabilities)
        if (currentTypes.isEmpty()) {
          return
        }

        val transportChanged = synchronized(networkStateLock) {
          val previousTypes = lastNetworkTransportTypes
          lastNetworkTransportTypes = currentTypes
          previousTypes != null && previousTypes != currentTypes
        }

        if (transportChanged) {
          emitNetworkDrop("default network transport changed")
        }
      }
    }

    cm.registerDefaultNetworkCallback(callback)
    networkCallback = callback
    Log.i(TAG, "registerNetworkCallback: default network callback registered")
  }

  /**
   * Unregister the ConnectivityManager.NetworkCallback if active.
   * Called during streamer teardown.
   */
  private fun unregisterNetworkCallback() {
    val callback = networkCallback ?: return
    networkCallback = null
    synchronized(networkStateLock) {
      lastNetworkTransportTypes = null
    }
    val context = appContext.reactContext ?: return
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    if (cm != null) {
      try {
        cm.unregisterNetworkCallback(callback)
        Log.i(TAG, "unregisterNetworkCallback: callback unregistered")
      } catch (e: Exception) {
        Log.w(TAG, "unregisterNetworkCallback: failed to unregister", e)
      }
    }
  }

  private fun activeTransportTypes(capabilities: NetworkCapabilities): Set<Int> =
    listOf(
      NetworkCapabilities.TRANSPORT_WIFI,
      NetworkCapabilities.TRANSPORT_CELLULAR,
      NetworkCapabilities.TRANSPORT_ETHERNET,
      NetworkCapabilities.TRANSPORT_VPN,
      NetworkCapabilities.TRANSPORT_BLUETOOTH,
      NetworkCapabilities.TRANSPORT_LOWPAN,
    ).filter { capabilities.hasTransport(it) }.toSet()

  private fun emitNetworkDrop(reason: String) {
    val shouldEmit = synchronized(networkStateLock) {
      if (networkDropHandled || isStoppingIntentionally || streamer == null) {
        false
      } else {
        networkDropHandled = true
        true
      }
    }

    if (!shouldEmit) {
      Log.i(TAG, "emitNetworkDrop: skipping $reason (already handled or stopping)")
      return
    }

    scope.launch {
      if (isStoppingIntentionally || streamer == null) {
        Log.i(TAG, "emitNetworkDrop: skipping $reason (stopped before event dispatch)")
        return@launch
      }
      Log.i(TAG, "emitNetworkDrop: $reason — emitting ENDPOINT_CLOSED")
      sendEvent("statusChange", mapOf("status" to PublisherStatus.ENDPOINT_CLOSED.wire))
    }
  }

  private fun sendStatus(status: PublisherStatus) {
    sendEvent("statusChange", mapOf("status" to status.wire))
  }

  private suspend fun cleanupStreamer() {
    // Atomically claim the active streamer. stop(), cancel(), the duration-cap
    // auto-stop, start()'s pre-publish reset, and OnDestroy can all reach here —
    // sometimes on different threads at the same moment (tapping Stop just as
    // the duration cap fires, or a blur teardown racing a manual stop). Without
    // this guard two callers each read the same non-null streamer and both call
    // close()+release() on it: a double MediaCodec teardown that SIGSEGVs the
    // whole process before stop telemetry can flush (the "crash on stop"
    // repro). Whoever wins the lock nulls the field and tears down; everyone
    // else sees null and returns.
    val claimed = synchronized(teardownLock) {
      val current = streamer ?: return
      streamer = null
      isStoppingIntentionally = true
      isMuted = false
      // Next session must rebind its preview from scratch.
      previewBound = false
      // Snapshot + clear collectors under the same lock so the loser of the
      // race can't cancel jobs the winner is still using.
      val jobs = collectorJobs.toList()
      collectorJobs.clear()
      current to jobs
    }
    val s = claimed.first

    // Cancel the flow collectors before tearing anything down. If release()
    // times out below, the old streamer's flows stay live in the background —
    // without this, a late emission after isStoppingIntentionally resets
    // would surface as a bogus error/drop on the next session.
    claimed.second.forEach { it.cancel() }

    // Unregister the proactive network callback — the streamer is being torn
    // down, so we no longer need to watch for network swaps.
    unregisterNetworkCallback()

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

  /// Listen for Android memory pressure (onTrimMemory) and forward to JS as
  /// error events with code 'memory_warning'. The JS hook catches these and
  /// logs 'live:memory_warning' telemetry without failing the recording.
  private fun installTrimMemoryObserver() {
    if (trimMemoryObserver != null) return
    val context = appContext.reactContext ?: return
    val observer = object : ComponentCallbacks2 {
      override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {}
      override fun onLowMemory() {
        sendEvent("error", mapOf(
          "code" to "memory_warning",
          "message" to "Android onLowMemory"
        ))
      }
      override fun onTrimMemory(level: Int) {
        if (level >= 15) {
          sendEvent("error", mapOf(
            "code" to "memory_warning",
            "message" to "Android onTrimMemory level=$level"
          ))
        }
      }
    }
    context.registerComponentCallbacks(observer)
    trimMemoryObserver = observer
  }

  private fun uninstallTrimMemoryObserver() {
    val observer = trimMemoryObserver ?: return
    trimMemoryObserver = null
    appContext.reactContext?.unregisterComponentCallbacks(observer)
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
    // ever created and the camera preview renders black. StreamPack also drives
    // its own SurfaceView (re)creation through these layout passes, so we must
    // always forward them.
    previewView.measure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
    )
    previewView.layout(0, 0, width, height)
    // Once the view has a real, non-zero size, it's safe to bind the camera
    // source (bindPreviewIfReady is idempotent and a no-op at 0x0).
    if (width > 0 && height > 0) {
      BondfireLivePublisherModule.currentInstance?.onPreviewLaidOut()
    }
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
