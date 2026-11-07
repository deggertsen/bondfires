import ExpoModulesCore
import UIKit
#if canImport(DeclaredAgeRange)
import DeclaredAgeRange
#endif

/// Mirrors `DeviceAgeSignalResult` in apps/mobile/lib/deviceAgeSignal.ts.
/// `status` is "shared" with inclusive bounds, "declined", or "unavailable".
/// Anything that is not a clear share is reported as unavailable so JS never
/// treats a failure as an age.
struct AgeSignalResult: Record {
  @Field var status: String = "unavailable"
  @Field var lowerBound: Int? = nil
  @Field var upperBound: Int? = nil
}

public class BondfireAgeSignalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BondfireAgeSignal")

    // Age gates are the app's own boundaries (13 and 18). Apple may override
    // them regionally; the returned bounds are still mapped by the server.
    AsyncFunction("requestAgeRange") { (minimumGate: Int, adultGate: Int) async -> AgeSignalResult in
      #if canImport(DeclaredAgeRange)
      guard #available(iOS 26.0, *) else { return AgeSignalResult() }
      let viewController: UIViewController? = await MainActor.run { [appContext] in
        appContext?.utilities?.currentViewController()
      }
      guard let viewController else { return AgeSignalResult() }
      do {
        let response = try await AgeRangeService.shared.requestAgeRange(
          ageGates: minimumGate, adultGate, nil, in: viewController)
        switch response {
        case .sharing(let range):
          var result = AgeSignalResult()
          result.status = "shared"
          result.lowerBound = range.lowerBound
          result.upperBound = range.upperBound
          return result
        case .declinedSharing:
          var result = AgeSignalResult()
          result.status = "declined"
          return result
        @unknown default:
          return AgeSignalResult()
        }
      } catch {
        // notAvailable (not signed in to an Apple Account), invalidRequest,
        // or anything new: no signal. JS falls back to month/year.
        return AgeSignalResult()
      }
      #else
      // Built with an SDK older than iOS 26: the framework does not exist.
      return AgeSignalResult()
      #endif
    }
  }
}
