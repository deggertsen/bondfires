package org.bondfires.livepublisher

import android.content.Context
import io.github.thibaultbee.streampack.core.configuration.mediadescriptor.MediaDescriptor
import io.github.thibaultbee.streampack.core.elements.data.FrameWithCloseable
import io.github.thibaultbee.streampack.core.elements.encoders.CodecConfig
import io.github.thibaultbee.streampack.core.elements.endpoints.CombineEndpoint
import io.github.thibaultbee.streampack.core.elements.endpoints.IEndpointInternal
import io.github.thibaultbee.streampack.core.elements.endpoints.MediaMuxerEndpointFactory
import io.github.thibaultbee.streampack.core.pipelines.IDispatcherProvider
import io.github.thibaultbee.streampack.ext.rtmp.elements.endpoints.RtmpEndpointFactory
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Fans one StreamPack encode into a durable file sink and a detachable RTMP
 * sink. Unlike StreamPack's stock [CombineEndpoint], transport open/close does
 * not stop the encoder or the file sink, so a reconnect cannot cut capture.
 *
 * The encoding pipeline registers each codec configuration with the sinks that
 * are open when encoding starts. RTMP may then register those saved configs and
 * attach later without rebuilding camera, microphone, or MediaCodec.
 */
class CaptureTransportEndpoint(
  private val transportEndpoint: IEndpointInternal,
  private val captureEndpoint: IEndpointInternal,
  dispatcherProvider: IDispatcherProvider,
) : CombineEndpoint(
    listOf(transportEndpoint, captureEndpoint),
    dispatcherProvider.default,
  ) {
  private val lifecycleMutex = Mutex()
  private val frameRoutingMutex = Mutex()
  private val registeredStreams = linkedMapOf<CodecConfig, Int>()
  private var nextFanoutStreamId = 0
  private var transportAttached = false

  val transportIsOpen: Boolean
    get() = transportEndpoint.isOpenFlow.value

  val captureIsOpen: Boolean
    get() = captureEndpoint.isOpenFlow.value

  val captureSink: IEndpointInternal
    get() = captureEndpoint

  val transportSink: IEndpointInternal
    get() = transportEndpoint

  suspend fun openCapture(descriptor: MediaDescriptor) = lifecycleMutex.withLock {
    if (!captureEndpoint.isOpenFlow.value) {
      captureEndpoint.open(descriptor)
    }
  }

  suspend fun openTransport(descriptor: MediaDescriptor) = lifecycleMutex.withLock {
    detachTransportFromFrameRouting()
    if (transportEndpoint.isOpenFlow.value) {
      transportEndpoint.close()
    }
    transportEndpoint.open(descriptor)
  }

  /** Attach RTMP to an encoder that is already feeding the local file. */
  suspend fun connectTransport(descriptor: MediaDescriptor) = lifecycleMutex.withLock {
    detachTransportFromFrameRouting()
    // RtmpEndpoint keeps FLV sequence-header state across close/open. Reset the
    // transport stream and re-register the same codec configs so each Mux
    // reconnect receives fresh AAC/AVC headers. The fanout stream ids exposed
    // to the encoder remain stable; only their RTMP child mapping changes.
    transportEndpoint.stopStream()
    if (transportEndpoint.isOpenFlow.value) {
      transportEndpoint.close()
    }
    val transportStreamIds = registeredStreams.map { (config, fanoutStreamId) ->
      fanoutStreamId to transportEndpoint.addStream(config)
    }
    transportEndpoint.open(descriptor)
    transportEndpoint.startStream()

    // The socket and publish handshake intentionally happen while RTMP is
    // detached from frame routing. Commit its completed stream map atomically
    // afterward, so a slow reconnect never stalls MediaMuxer writes and no
    // frame can reach an open-but-not-started transport.
    frameRoutingMutex.withLock {
      transportStreamIds.forEach { (fanoutStreamId, transportStreamId) ->
        endpointsToStreamIdsMap[Pair(transportEndpoint, fanoutStreamId)] = transportStreamId
      }
      transportAttached = true
    }
  }

  /** Drop only RTMP. Capture and encoder ownership stay untouched. */
  suspend fun disconnectTransport() = lifecycleMutex.withLock {
    detachTransportFromFrameRouting()
    if (transportEndpoint.isOpenFlow.value) {
      transportEndpoint.close()
    }
  }

  /** Start whichever sinks were opened before the encoding pipeline starts. */
  override suspend fun startStream() = lifecycleMutex.withLock {
    endpointInternals.filter { it.isOpenFlow.value }.forEach { it.startStream() }
    if (transportEndpoint.isOpenFlow.value) {
      frameRoutingMutex.withLock {
        transportAttached = true
      }
    }
  }

  override suspend fun addStreams(
    streamConfigs: List<CodecConfig>,
  ): Map<CodecConfig, Int> = lifecycleMutex.withLock {
    streamConfigs.associateWith { registerStream(it) }
  }

  override suspend fun addStream(streamConfig: CodecConfig): Int = lifecycleMutex.withLock {
    registerStream(streamConfig)
  }

  /**
   * StreamPack registers encoder streams after the selected endpoint opens.
   * Register only the sinks that are open at that moment: MediaMuxerEndpoint
   * requires open() before addStream(), while RTMP-only sessions deliberately
   * leave the file sink closed. A later transport attach uses the saved codec
   * configs to add the RTMP mapping without changing the encoder-facing id.
   */
  private suspend fun registerStream(streamConfig: CodecConfig): Int {
    val fanoutStreamId = nextFanoutStreamId++
    registeredStreams[streamConfig] = fanoutStreamId
    val childStreamIds = endpointInternals.filter { it.isOpenFlow.value }.map { endpoint ->
      endpoint to endpoint.addStream(streamConfig)
    }
    frameRoutingMutex.withLock {
      childStreamIds.forEach { (endpoint, childStreamId) ->
        endpointsToStreamIdsMap[Pair(endpoint, fanoutStreamId)] = childStreamId
      }
    }
    return fanoutStreamId
  }

  /** Route capture continuously while RTMP performs its network handshake. */
  override suspend fun write(closeableFrame: FrameWithCloseable, streamPid: Int) =
    frameRoutingMutex.withLock {
      if (transportAttached) {
        super.write(closeableFrame, streamPid)
        return@withLock
      }

      val captureStreamId = endpointsToStreamIdsMap[Pair(captureEndpoint, streamPid)]
      if (captureEndpoint.isOpenFlow.value && captureStreamId != null) {
        captureEndpoint.write(closeableFrame, captureStreamId)
      } else {
        // RTMP-only startup has no frame destination until startStream marks
        // the completed transport handshake attached.
        closeableFrame.close()
      }
    }

  private suspend fun detachTransportFromFrameRouting() = frameRoutingMutex.withLock {
    transportAttached = false
    endpointsToStreamIdsMap.keys.removeAll { (endpoint, _) -> endpoint === transportEndpoint }
  }

  override suspend fun stopStream() = lifecycleMutex.withLock {
    detachTransportFromFrameRouting()
    endpointInternals.filter { it.isOpenFlow.value }.forEach { it.stopStream() }
    frameRoutingMutex.withLock {
      endpointsToStreamIdsMap.clear()
    }
    registeredStreams.clear()
    nextFanoutStreamId = 0
  }

  override suspend fun close() = lifecycleMutex.withLock {
    detachTransportFromFrameRouting()
    endpointInternals.forEach { endpoint ->
      if (endpoint.isOpenFlow.value) {
        endpoint.close()
      }
    }
  }
}

class CaptureTransportEndpointFactory : IEndpointInternal.Factory {
  override fun create(
    context: Context,
    dispatcherProvider: IDispatcherProvider,
  ): IEndpointInternal = CaptureTransportEndpoint(
    RtmpEndpointFactory().create(context, dispatcherProvider),
    MediaMuxerEndpointFactory().create(context, dispatcherProvider),
    dispatcherProvider,
  )
}
