import ExpoModulesCore
import UIKit

struct LivePublisherStartOptions: Record {
  @Field var rtmpsUrl: String = ""
  @Field var streamKey: String = ""
  @Field var width: Int = 720
  @Field var height: Int = 1280
  @Field var fps: Int = 30
  @Field var videoBitrate: Int = 2_500_000
  @Field var audioBitrate: Int = 128_000
  @Field var initialCamera: String = "front"
}

public class BondfireLivePublisherModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BondfireLivePublisher")

    Events("statusChange", "error")

    AsyncFunction("isAvailable") { () -> Bool in
      false
    }

    AsyncFunction("start") { (options: LivePublisherStartOptions) in
      sendEvent("statusChange", "connecting")
      sendEvent("error", [
        "code": "not_implemented",
        "message": "Native RTMPS publishing is scaffolded but not implemented in this build.",
      ])
      throw LivePublisherNotImplementedException()
    }

    AsyncFunction("stop") {
      sendEvent("statusChange", "ended")
    }

    AsyncFunction("swapCamera") {}

    AsyncFunction("setMuted") { (_: Bool) in }

    AsyncFunction("getStats") { () -> [String: Int] in
      return [
        "bitrateBps": 0,
        "rttMs": 0,
        "droppedFrames": 0,
      ]
    }

    View(BondfireLivePublisherView.self) {}
  }
}

final class BondfireLivePublisherView: ExpoView {
  private let previewView = UIView()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    previewView.backgroundColor = UIColor.black
    addSubview(previewView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    previewView.frame = bounds
  }
}

final class LivePublisherNotImplementedException: Exception {
  override var reason: String {
    "Native RTMPS publishing is scaffolded but not implemented in this build."
  }
}
