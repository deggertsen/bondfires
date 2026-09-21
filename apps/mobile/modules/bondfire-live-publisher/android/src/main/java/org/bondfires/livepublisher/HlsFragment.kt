package org.bondfires.livepublisher

import java.nio.ByteBuffer

/** Convert Media3 1.11's file-relative fragments into independently addressable HLS fragments. */
internal object HlsFragment {
  data class Result(val bytes: ByteArray, val nextDecodeTimes: Map<Int, Long>)
  private data class Box(val type: String, val data: ByteArray) {
    fun bytes(): ByteArray = ByteBuffer.allocate(8 + data.size)
      .putInt(8 + data.size).put(type.toByteArray(Charsets.US_ASCII)).put(data).array()
  }

  private fun boxes(bytes: ByteArray): List<Box> {
    val input = ByteBuffer.wrap(bytes)
    val result = mutableListOf<Box>()
    while (input.hasRemaining()) {
      require(input.remaining() >= 8) { "Incomplete MP4 box" }
      val size = input.int
      val type = ByteArray(4).also { input.get(it) }.toString(Charsets.US_ASCII)
      require(size >= 8 && size - 8 <= input.remaining()) { "Invalid MP4 box size" }
      result += Box(type, ByteArray(size - 8).also { input.get(it) })
    }
    return result
  }

  private fun pack(boxes: List<Box>): ByteArray {
    val encoded = boxes.map { it.bytes() }
    return ByteBuffer.allocate(encoded.sumOf { it.size }).apply { encoded.forEach { put(it) } }.array()
  }

  fun initialization(bytes: ByteArray): ByteArray {
    val root = boxes(bytes)
    require(root.count { it.type == "ftyp" } == 1 && root.count { it.type == "moov" } == 1)
    // HLS fMP4 requires ISO Base Media File Format version 6 compatibility.
    return pack(root.map { box ->
      if (box.type == "ftyp") Box("ftyp", box.data + "iso6".toByteArray(Charsets.US_ASCII)) else box
    })
  }

  fun convert(bytes: ByteArray, decodeTimes: Map<Int, Long>): Result {
    val root = boxes(bytes)
    require(root.count { it.type == "moof" } == 1 && root.count { it.type == "mdat" } == 1)
    val children = boxes(root.single { it.type == "moof" }.data)
    // Each traf loses an 8-byte absolute base offset and gains a 20-byte tfdt.
    val growth = children.count { it.type == "traf" } * 12
    val next = decodeTimes.toMutableMap()
    val converted = children.map { child ->
      if (child.type != "traf") return@map child
      val trackBoxes = boxes(child.data)
      require(trackBoxes.none { it.type == "tfdt" }) { "Unexpected Media3 timing layout" }
      val header = ByteBuffer.wrap(trackBoxes.single { it.type == "tfhd" }.data)
      require(header.remaining() == 16 && header.int == 1) { "Unexpected Media3 track header" }
      val trackId = header.int
      val decodeTime = requireNotNull(decodeTimes[trackId]) { "Missing track timestamp" }
      var duration = 0L
      val runs = trackBoxes.filter { it.type == "trun" }.map { run ->
        val copy = run.data.copyOf()
        val input = ByteBuffer.wrap(copy)
        val flags = input.int and 0xffffff
        require(flags == 0x701 || flags == 0xf01) { "Unexpected Media3 sample table" }
        val count = input.int
        val stride = if (flags and 0x800 != 0) 16 else 12
        require(count in 1..10000 && input.remaining() == 4 + count * stride)
        val oldOffset = input.int
        input.putInt(8, Math.addExact(oldOffset, growth))
        repeat(count) {
          duration += input.int.toLong() and 0xffffffffL
          input.position(input.position() + stride - 4)
        }
        Box("trun", copy)
      }
      require(runs.isNotEmpty())
      next[trackId] = Math.addExact(decodeTime, duration)
      val tfhd = Box("tfhd", ByteBuffer.allocate(8).putInt(0x020000).putInt(trackId).array())
      val tfdt = Box("tfdt", ByteBuffer.allocate(12).putInt(0x01000000).putLong(decodeTime).array())
      require(trackBoxes.size == runs.size + 1) { "Unexpected Media3 fragment boxes" }
      Box("traf", pack(listOf(tfhd, tfdt) + runs))
    }
    return Result(pack(root.map { if (it.type == "moof") Box("moof", pack(converted)) else it }), next)
  }
}
