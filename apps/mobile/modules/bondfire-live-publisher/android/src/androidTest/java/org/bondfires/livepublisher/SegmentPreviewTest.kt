package org.bondfires.livepublisher

import android.Manifest
import android.media.AudioFormat
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Size
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import io.github.thibaultbee.streampack.core.elements.encoders.AudioCodecConfig
import io.github.thibaultbee.streampack.core.elements.encoders.VideoCodecConfig
import io.github.thibaultbee.streampack.core.streamers.single.cameraSingleStreamer
import java.io.File
import java.util.UUID
import java.nio.ByteBuffer
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SegmentPreviewTest {
  @get:Rule val permissions = GrantPermissionRule.grant(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)

  @Test fun previewThenRecordProducesAudioAndVideoWithoutNetwork() = runBlocking {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val localId = UUID.randomUUID().toString()
    val directory = File(context.filesDir, "segments/$localId")
    val streamer = cameraSingleStreamer(context, endpointFactory = CaptureTransportEndpointFactory(true))
    try {
      streamer.setAudioConfig(AudioCodecConfig(mimeType = MediaFormat.MIMETYPE_AUDIO_AAC, startBitrate = 128000, sampleRate = 44100, channelConfig = AudioFormat.CHANNEL_IN_MONO, byteFormat = AudioFormat.ENCODING_PCM_16BIT))
      streamer.setVideoConfig(VideoCodecConfig(mimeType = MediaFormat.MIMETYPE_VIDEO_AVC, startBitrate = 1500000, resolution = Size(640, 480), fps = 24, gopDurationInS = 2.0f))
      streamer.startSegmentPreviewCapture()
      assertTrue(streamer.isStreamingFlow.value)
      assertFalse(directory.exists())
      val fanout = streamer.endpoint as CaptureTransportEndpoint
      assertFalse(fanout.transportIsOpen)
      val sink = fanout.captureSink as SegmentEndpoint
      assertNotNull(sink.info)
      sink.begin(localId, 30)
      streamer.videoEncoder?.requestKeyFrame()
      // Wait for a fragment committed during capture, then capture the tail.
      // Emulator camera/encoder throughput need not match wall-clock speed.
      withTimeout(20000) {
        while (!File(directory, "segment-000000.m4s").exists()) delay(100)
      }
      delay(2000)
      assertNull("Capture must not silently lose frames", sink.throwableFlow.value)
      val count = sink.finish()
      assertTrue("Expected committed media fragments", count >= 2)
      assertTrue(File(directory, "finished.json").exists())
      for (i in 0 until count) {
        val piece = File(directory, "piece.mp4")
        piece.outputStream().use { output ->
          File(directory, "init.mp4").inputStream().use { it.copyTo(output) }
          File(directory, "segment-%06d.m4s".format(java.util.Locale.US, i)).inputStream().use { it.copyTo(output) }
        }
        val reader = MediaExtractor()
        try {
          reader.setDataSource(piece.path)
          assertEquals(2, reader.trackCount)
          for (track in 0 until reader.trackCount) {
            reader.selectTrack(track)
            reader.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
            assertTrue("Segment $i track $track must be independently readable", reader.readSampleData(ByteBuffer.allocate(1024 * 1024), 0) > 0)
            if (reader.getTrackFormat(track).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) {
              assertTrue("AAC must start with a sync sample or ExoPlayer drops it", reader.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0)
            }
            // MediaExtractor can rebase a standalone file's first timestamp.
            assertTrue("Fragment must expose a valid sample timestamp", reader.sampleTime >= 0)
            reader.unselectTrack(track)
          }
        } finally { reader.release() }
      }
      val movie = File(directory, "check.mp4")
      movie.outputStream().use { output ->
        File(directory, "init.mp4").inputStream().use { it.copyTo(output) }
        for (i in 0 until count) File(directory, "segment-%06d.m4s".format(java.util.Locale.US, i)).inputStream().use { it.copyTo(output) }
      }
      movie.copyTo(File(context.cacheDir, "segment-preview-check.mp4"), overwrite = true)
      val extractor = MediaExtractor()
      try {
        extractor.setDataSource(movie.path)
        assertEquals(2, extractor.trackCount)
        val mimes = (0 until extractor.trackCount).map { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME) }
        assertTrue(mimes.contains("video/avc"))
        assertTrue(mimes.contains("audio/mp4a-latm"))
        for (track in 0 until extractor.trackCount) {
          extractor.selectTrack(track)
          extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
          assertTrue("Track $track must contain samples", extractor.sampleTime >= 0)
          assertTrue("Track $track should start promptly: ${extractor.sampleTime}", extractor.sampleTime < 500000)
          var samples = 0
          var lastSampleTime = 0L
          var maxGapUs = 0L
          do {
            samples++
            maxGapUs = maxOf(maxGapUs, extractor.sampleTime - lastSampleTime)
            lastSampleTime = extractor.sampleTime
          } while (extractor.advance())
          android.util.Log.i("SegmentPreviewTest", "track=$track samples=$samples lastUs=$lastSampleTime maxGapUs=$maxGapUs")
          assertTrue("Track $track must remain continuous ($samples samples, $maxGapUs gap)", samples >= 10 && maxGapUs < 500000)
          assertTrue("Track $track must cover the recording", lastSampleTime > 5000000)
          extractor.unselectTrack(track)
          extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
        }
      } finally { extractor.release() }
    } finally {
      streamer.release()
      directory.deleteRecursively()
    }
  }
}
