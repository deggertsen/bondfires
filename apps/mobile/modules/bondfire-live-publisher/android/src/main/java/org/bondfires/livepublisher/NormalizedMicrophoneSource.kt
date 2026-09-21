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
  override suspend fun create(context: Context): IAudioSourceInternal = NormalizedMicrophoneSource(
    MicrophoneSourceFactory(audioSource).create(context), audioSource
  )

  override fun isSourceEquals(source: IAudioSourceInternal?) =
    source is NormalizedMicrophoneSource && source.audioSource == audioSource
}

private class NormalizedMicrophoneSource(
  private val delegate: IAudioSourceInternal,
  val audioSource: Int,
) : IAudioSourceInternal by delegate {
  private var leveler: SpeechLeveler? = null

  override suspend fun configure(config: AudioSourceConfig) {
    require(config.byteFormat == AudioFormat.ENCODING_PCM_16BIT && config.channelConfig == AudioFormat.CHANNEL_IN_MONO)
    delegate.configure(config)
    leveler = SpeechLeveler(config.sampleRate)
  }

  override fun fillAudioFrame(frame: RawFrame): RawFrame = normalize(delegate.fillAudioFrame(frame))
  override fun getAudioFrame(frameFactory: IReadOnlyRawFrameFactory): RawFrame = normalize(delegate.getAudioFrame(frameFactory))

  private fun normalize(frame: RawFrame): RawFrame {
    try {
      checkNotNull(leveler).process(frame.rawBuffer)
      return frame
    } catch (error: Throwable) {
      frame.close()
      throw error
    }
  }
}
