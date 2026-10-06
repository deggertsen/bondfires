package org.bondfires.livepublisher

import android.content.Context
import android.media.AudioFormat
import io.github.thibaultbee.streampack.core.elements.data.RawFrame
import io.github.thibaultbee.streampack.core.elements.sources.audio.AudioSourceConfig
import io.github.thibaultbee.streampack.core.elements.sources.audio.IAudioSourceInternal
import io.github.thibaultbee.streampack.core.elements.sources.audio.audiorecord.MicrophoneSourceFactory
import io.github.thibaultbee.streampack.core.elements.utils.pool.IReadOnlyRawFrameFactory

/** Decorates capture, before mute/encoding; camera swaps never reset gain. */
internal class NormalizedMicrophoneSourceFactory(private val audioSource: Int) : IAudioSourceInternal.Factory {
  // Immutable snapshot published from the audio thread, scoped to this capture.
  @Volatile var audioStats: Map<String, Double> = emptyMap()
    private set

  override suspend fun create(context: Context): IAudioSourceInternal = NormalizedMicrophoneSource(
    MicrophoneSourceFactory(audioSource).create(context), audioSource, { audioStats = it }
  )

  override fun isSourceEquals(source: IAudioSourceInternal?) =
    source is NormalizedMicrophoneSource && source.audioSource == audioSource
}

private class NormalizedMicrophoneSource(
  private val delegate: IAudioSourceInternal,
  val audioSource: Int,
  private val onStats: (Map<String, Double>) -> Unit,
) : IAudioSourceInternal by delegate {
  private var leveler: SpeechLeveler? = null

  override suspend fun configure(config: AudioSourceConfig) {
    require(config.byteFormat == AudioFormat.ENCODING_PCM_16BIT && config.channelConfig == AudioFormat.CHANNEL_IN_MONO)
    delegate.configure(config)
    leveler = SpeechLeveler(config.sampleRate)
    onStats(emptyMap())
  }

  override fun fillAudioFrame(frame: RawFrame): RawFrame = normalize(delegate.fillAudioFrame(frame))
  override fun getAudioFrame(frameFactory: IReadOnlyRawFrameFactory): RawFrame = normalize(delegate.getAudioFrame(frameFactory))

  private fun normalize(frame: RawFrame): RawFrame {
    try {
      val activeLeveler = checkNotNull(leveler)
      activeLeveler.process(frame.rawBuffer)
      onStats(activeLeveler.audioStats())
      return frame
    } catch (error: Throwable) {
      frame.close()
      throw error
    }
  }
}
