package org.bondfires.livepublisher

import android.content.Context
import android.graphics.Color
import android.view.View
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.views.ExpoView

class LivePublisherStartOptions : Record {
  @Field
  val rtmpsUrl: String = ""

  @Field
  val streamKey: String = ""

  @Field
  val width: Int = 720

  @Field
  val height: Int = 1280

  @Field
  val fps: Int = 30

  @Field
  val videoBitrate: Int = 2_500_000

  @Field
  val audioBitrate: Int = 128_000

  @Field
  val initialCamera: String = "front"
}

class BondfireLivePublisherModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BondfireLivePublisher")

    Events("statusChange", "error")

    AsyncFunction("isAvailable") {
      false
    }

    AsyncFunction("start") { _: LivePublisherStartOptions ->
      sendEvent("statusChange", "connecting")
      sendEvent(
        "error",
        mapOf(
          "code" to "not_implemented",
          "message" to "Native RTMPS publishing is scaffolded but not implemented in this build.",
        ),
      )
      throw LivePublisherNotImplementedException()
    }

    AsyncFunction("stop") {
      sendEvent("statusChange", "ended")
    }

    AsyncFunction("swapCamera") {}

    AsyncFunction("setMuted") { _: Boolean -> }

    AsyncFunction("getStats") {
      mapOf(
        "bitrateBps" to 0,
        "rttMs" to 0,
        "droppedFrames" to 0,
      )
    }

    View(BondfireLivePublisherView::class) {}
  }
}

class BondfireLivePublisherView(context: Context, appContext: expo.modules.kotlin.AppContext) :
  ExpoView(context, appContext) {
  private val preview = View(context)

  init {
    preview.setBackgroundColor(Color.BLACK)
    addView(preview)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    preview.layout(0, 0, right - left, bottom - top)
  }
}

class LivePublisherNotImplementedException :
  CodedException("Native RTMPS publishing is scaffolded but not implemented in this build.")
