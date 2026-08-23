package org.bondfires.livepublisher

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Keeps the already-running native camera/microphone pipeline alive while the
 * creator switches apps. The service never opens capture by itself: Android
 * requires camera/mic foreground services to be started while the app is
 * visible, so the publisher starts it only after a user-initiated recording.
 */
class RecordingForegroundService : Service() {
  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      BondfireLivePublisherModule.requestStopFromNotification()
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }

    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun buildNotification(): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent().setPackage(packageName)
    val returnIntent = PendingIntent.getActivity(
      this,
      0,
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val stopIntent = PendingIntent.getService(
      this,
      1,
      Intent(this, RecordingForegroundService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      Notification.Builder(this)
    }
    return builder
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle("Bondfires is recording")
      .setContentText("Tap to return. Recording continues when you switch apps.")
      .setContentIntent(returnIntent)
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .addAction(0, "Stop & save", stopIntent)
      .build()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        "Active recordings",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Shown while a Bondfires video is recording"
        setSound(null, null)
      },
    )
  }

  companion object {
    const val ACTION_START = "org.bondfires.livepublisher.START_RECORDING"
    const val ACTION_STOP = "org.bondfires.livepublisher.STOP_RECORDING"
    private const val CHANNEL_ID = "bondfires_active_recording"
    private const val NOTIFICATION_ID = 4102
  }
}
