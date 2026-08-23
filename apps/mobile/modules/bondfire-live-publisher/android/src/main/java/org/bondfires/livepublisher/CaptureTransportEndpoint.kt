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
 * Stream registration still belongs to [CombineEndpoint]. The encoding
 * pipeline calls addStreams once when local capture starts, registering the
 * same codec configuration with both children. RTMP may then be opened and
 * started later without rebuilding camera, microphone, or MediaCodec.
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
  private val registeredStreams = linkedMapOf<CodecConfig, Int>()
  private var nextFanoutStreamId = 0

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
    if (transportEndpoint.isOpenFlow.value) {
      transportEndpoint.close()
    }
    transportEndpoint.open(descriptor)
  }

  /** Attach RTMP to an encoder that is already feeding the local file. */
  suspend fun connectTransport(descriptor: MediaDescriptor) = lifecycleMutex.withLock {
    // RtmpEndpoint keeps FLV sequence-header state across close/open. Reset the
    // transport stream and re-register the same codec configs so each Mux
    // reconnect receives fresh AAC/AVC headers. The fanout stream ids exposed
    // to the encoder remain stable; only their RTMP child mapping changes.
    transportEndpoint.stopStream()
    if (transportEndpoint.isOpenFlow.value) {
      transportEndpoint.close()
    }
    registeredStreams.forEach { (config, fanoutStreamId) ->
      endpointsToStreamIdsMap[Pair(transportEndpoint, fanoutStreamId)] =
        transportEndpoint.addStream(config)
    }
    transportEndpoint.open(descriptor)
    transportEndpoint.startStream()
  }

  /** Drop only RTMP. Capture and encoder ownership stay untouched. */
  suspend fun disconnectTransport() = lifecycleMutex.withLock {
    if (transportEndpoint.isOpenFlow.value) {
      transportEndpoint.close()
    }
  }

  /** Start whichever sinks were opened before the encoding pipeline starts. */
  override suspend fun startStream() = lifecycleMutex.withLock {
    endpointInternals.filter { it.isOpenFlow.value }.forEach { it.startStream() }
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
    endpointInternals.filter { it.isOpenFlow.value }.forEach { endpoint ->
      endpointsToStreamIdsMap[Pair(endpoint, fanoutStreamId)] = endpoint.addStream(streamConfig)
    }
    return fanoutStreamId
  }

  /**
   * CombineEndpoint's write path reads its LinkedHashMap directly. Serialize
   * frames with attach/detach so reconnect cannot mutate that map while an
   * encoder frame is being fanned out, or write to RTMP between open and the
   * completed start handshake.
   */
  override suspend fun write(closeableFrame: FrameWithCloseable, streamPid: Int) =
    lifecycleMutex.withLock {
      super.write(closeableFrame, streamPid)
    }

  override suspend fun stopStream() = lifecycleMutex.withLock {
    endpointInternals.filter { it.isOpenFlow.value }.forEach { it.stopStream() }
    endpointsToStreamIdsMap.clear()
    registeredStreams.clear()
    nextFanoutStreamId = 0
  }

  override suspend fun close() = lifecycleMutex.withLock {
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
