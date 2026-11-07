package org.bondfires.agesignal

import com.google.android.play.agesignals.AgeSignalsAccessRequest
import com.google.android.play.agesignals.AgeSignalsManager
import com.google.android.play.agesignals.AgeSignalsManagerFactory
import com.google.android.play.agesignals.AgeSignalsRequest
import com.google.android.play.agesignals.model.AgeSignalsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Google Play Age Signals (beta). Mirrors `DeviceAgeSignalResult` in
 * apps/mobile/lib/deviceAgeSignal.ts: "shared" with inclusive bounds,
 * "declined" when the user or parent chose not to share, "unavailable" for
 * everything else (no Play Services, API error, cancelled task, no activity).
 * Nothing here ever throws to JS; a failure is never reported as an age.
 */
class BondfireAgeSignalModule : Module() {
  private val manager: AgeSignalsManager? by lazy {
    appContext.reactContext?.applicationContext?.let { AgeSignalsManagerFactory.create(it) }
  }

  override fun definition() = ModuleDefinition {
    Name("BondfireAgeSignal")

    // Play uses its own fixed bands (0-12, 13-15, 16-17, 18+); the gates are
    // accepted for API parity with iOS and intentionally unused.
    AsyncFunction("requestAgeRange") { _: Int, _: Int, promise: Promise ->
      val activity = appContext.currentActivity
      val manager = manager
      if (activity == null || manager == null) {
        promise.resolve(unavailable())
        return@AsyncFunction
      }
      try {
        val accessRequest = AgeSignalsAccessRequest.builder().setActivity(activity).build()
        manager.requestAgeSignalsAccess(accessRequest)
          .addOnSuccessListener { access ->
            when (access.ageSignalsStatus()) {
              AgeSignalsStatus.SHARED -> fetchAgeSignals(manager, promise)
              AgeSignalsStatus.NOT_SHARED -> promise.resolve(result("declined", null, null))
              else -> promise.resolve(unavailable())
            }
          }
          .addOnFailureListener { promise.resolve(unavailable()) }
          .addOnCanceledListener { promise.resolve(unavailable()) }
      } catch (error: Throwable) {
        promise.resolve(unavailable())
      }
    }
  }

  private fun fetchAgeSignals(manager: AgeSignalsManager, promise: Promise) {
    try {
      manager.checkAgeSignals(AgeSignalsRequest.builder().build())
        .addOnSuccessListener { signals ->
          val lower = signals.ageLower()
          val upper = signals.ageUpper()
          if (lower == null && upper == null) {
            promise.resolve(unavailable())
          } else {
            promise.resolve(result("shared", lower, upper))
          }
        }
        .addOnFailureListener { promise.resolve(unavailable()) }
        .addOnCanceledListener { promise.resolve(unavailable()) }
    } catch (error: Throwable) {
      promise.resolve(unavailable())
    }
  }

  private fun unavailable(): Map<String, Any?> = result("unavailable", null, null)

  private fun result(status: String, lower: Int?, upper: Int?): Map<String, Any?> =
    mapOf("status" to status, "lowerBound" to lower, "upperBound" to upper)
}
