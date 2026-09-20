package org.bondfires.livepublisher

import android.content.Context
import android.media.MediaFormat
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.muxer.BufferInfo
import androidx.media3.muxer.FragmentedMp4Muxer
import io.github.thibaultbee.streampack.core.configuration.mediadescriptor.MediaDescriptor
import io.github.thibaultbee.streampack.core.elements.data.FrameWithCloseable
import io.github.thibaultbee.streampack.core.elements.encoders.CodecConfig
import io.github.thibaultbee.streampack.core.elements.endpoints.IEndpointInternal
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

/** Encodes during preview but discards samples until Record; never persists preroll. */
class SegmentEndpoint(private val context: Context, private val delegate: IEndpointInternal) : IEndpointInternal by delegate {
  override val isOpenFlow = MutableStateFlow(false)
  override val throwableFlow = MutableStateFlow<Throwable?>(null)
  private val lock = Mutex()
  private val ready = CompletableDeferred<Unit>()
  suspend fun awaitReady() { withTimeout(5000) { ready.await() } }
  private var nextStream = 0
  private val formats = mutableMapOf<Int, Format>()
  private val tracks = mutableMapOf<Int, Int>()
  private var muxer: FragmentedMp4Muxer? = null
  private var directory: File? = null
  private var pendingFile: File? = null
  private var scanOffset = 0L
  private var fragmentStart = 0L
  private var count = 0
  private var startUs: Long? = null
  private var maxUs = 0L
  private var armed = false
  private var videoStarted = false

  override suspend fun open(mediaDescriptor: MediaDescriptor) { isOpenFlow.value = true }
  override suspend fun addStream(streamConfig: CodecConfig): Int = nextStream++
  override suspend fun addStreams(streamConfigs: List<CodecConfig>) = streamConfigs.associateWith { addStream(it) }
  override suspend fun startStream() {}
  override suspend fun stopStream() { finish() }
  override suspend fun close() { finish(); isOpenFlow.value = false }
  override suspend fun release() { close(); delegate.release() }

  suspend fun begin(localId: String, maxDuration: Int) = lock.withLock {
    require(localId.matches(Regex("[a-f0-9-]{36}")) && maxDuration in 1..3600)
    check(!armed && muxer == null && formats.size == 2) { "Camera and microphone are warming up" }
    val folder = File(context.filesDir, "segments/$localId")
    check(!folder.exists()) { "Recording already exists" }
    check(folder.mkdirs()) { "Could not create recording directory" }
    directory = folder
    val file = File(folder, "capture.partial")
    pendingFile = file
    val writer = FragmentedMp4Muxer.Builder(FileOutputStream(file)).setFragmentDurationMs(4000).setSampleCopyingEnabled(true).build()
    formats.forEach { (id, format) -> tracks[id] = writer.addTrack(format) }
    muxer = writer
    scanOffset = 0; fragmentStart = 0; count = 0; startUs = null
    maxUs = maxDuration.toLong() * 1_000_000
    videoStarted = false
    armed = true
  }

  override suspend fun write(closeableFrame: FrameWithCloseable, streamPid: Int) {
    try {
      lock.withLock {
        val frame = closeableFrame.frame
        if (!formats.containsKey(streamPid)) formats[streamPid] = mediaFormat(frame.format, frame.extra.orEmpty())
        if (formats.size == 2) ready.complete(Unit)
        val writer = muxer ?: return@withLock
        if (!armed) return@withLock
        val isVideo = frame.format.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
        if (startUs == null) startUs = frame.ptsInUs
        // Preserve audio immediately at Record, including speech before the
        // requested video keyframe arrives. Both tracks share one origin.
        if (isVideo && !videoStarted) {
          if (!frame.isKeyFrame) return@withLock
          videoStarted = true
        }
        val pts = frame.ptsInUs - (startUs ?: return@withLock)
        if (pts < 0) return@withLock
        if (pts >= maxUs) { finishLocked(); return@withLock }
        val track = tracks[streamPid] ?: error("Missing track")
        writer.writeSampleData(track, frame.rawBuffer.duplicate(), BufferInfo(pts, frame.rawBuffer.remaining(), if (frame.isKeyFrame) C.BUFFER_FLAG_KEY_FRAME else 0))
        exportCompleteBoxes()
      }
    } catch (error: Throwable) {
      throwableFlow.value = error
      throw error
    } finally { closeableFrame.close() }
  }

  suspend fun finish(): Int = lock.withLock { finishLocked() }
  private fun finishLocked(): Int {
    val writer = muxer ?: return count
    armed = false
    writer.close()
    muxer = null
    exportCompleteBoxes()
    check(count > 0) { "No media was captured" }
    atomicWrite(File(directory, "finished.json"), JSONObject().put("segmentCount", count).toString().toByteArray())
    pendingFile?.delete()
    tracks.clear()
    return count
  }

  private fun exportCompleteBoxes() {
    val file = pendingFile ?: return
    val folder = directory ?: return
    RandomAccessFile(file, "r").use { input ->
      while (input.length() - scanOffset >= 8) {
        input.seek(scanOffset)
        val size = input.readInt().toLong() and 0xffffffffL
        val typeBytes = ByteArray(4); input.readFully(typeBytes)
        val type = String(typeBytes, Charsets.US_ASCII)
        check(size >= 8 && size <= 8 * 1024 * 1024) { "Invalid fragment size" }
        if (scanOffset + size > input.length()) break
        val end = scanOffset + size
        if (type == "moov" || type == "mdat") {
          check(end - fragmentStart <= 8 * 1024 * 1024)
          val bytes = ByteArray((end - fragmentStart).toInt())
          input.seek(fragmentStart); input.readFully(bytes)
          val name = if (type == "moov") "init.mp4" else "segment-%06d.m4s".format(java.util.Locale.US, count++)
          atomicWrite(File(folder, name), bytes)
          fragmentStart = end
        }
        scanOffset = end
      }
    }
  }

  private fun mediaFormat(format: MediaFormat, extra: List<ByteBuffer>): Format {
    val mime = requireNotNull(format.getString(MediaFormat.KEY_MIME))
    val csd = (0..2).mapNotNull { i -> format.getByteBuffer("csd-$i") }.ifEmpty { extra }
      .map { buffer -> val copy = buffer.duplicate(); ByteArray(copy.remaining()).also { copy.get(it) } }
    val builder = Format.Builder().setSampleMimeType(mime).setInitializationData(csd)
    if (mime.startsWith("video/")) builder.setWidth(format.getInteger(MediaFormat.KEY_WIDTH)).setHeight(format.getInteger(MediaFormat.KEY_HEIGHT))
    else builder.setSampleRate(format.getInteger(MediaFormat.KEY_SAMPLE_RATE)).setChannelCount(format.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
    return builder.build()
  }

  private fun atomicWrite(file: File, bytes: ByteArray) {
    val temp = File(file.parentFile, file.name + ".tmp")
    FileOutputStream(temp).use { it.write(bytes); it.fd.sync() }
    check(temp.renameTo(file)) { "Could not commit media fragment" }
  }
}
