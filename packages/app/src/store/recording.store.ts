import { observable } from '@legendapp/state'
import { telemetry } from '../services/telemetry'

// ── Recording flow state machine ─────────────────────────────────────────────
//
// Single source of truth for "what is the recording flow doing", shared by
// the create router, LiveRecordScreen, and LegacyRecordScreen. Phase changes
// go through recordingActions.setPhase, which validates against the
// transition table below and logs `recording:invalid_transition` telemetry
// for anything unexpected — the transition is still applied (observability
// over wedging), but every invalid edge is a bug to fix.
//
// This machine tracks the user-facing flow. Transport-level publisher state
// (connecting/live/reconnecting/…) stays in livePublishStore$ — the live
// screen maps transport events onto flow transitions.
//
//   idle ──────────────► pre_connected ───► recording ───► stopping
//    │  (live pre-connect)      │   ▲           │              │
//    │                  (cancel)│   └(connect   │              │
//    └► recording (legacy tap)  ▼     failed)   ▼              ▼
//                              idle        completion ◄── processing ─► uploading
//                                               │              ▲            │
//                                               └──► idle      └────────────┘

export type RecordingPhase =
  | 'idle'
  | 'pre_connected'
  | 'recording'
  | 'stopping'
  | 'processing'
  | 'uploading'
  | 'completion'

const VALID_TRANSITIONS: Record<RecordingPhase, readonly RecordingPhase[]> = {
  idle: ['pre_connected', 'recording'],
  // recording: record tap. idle: cancel / lost focus / preview expired.
  pre_connected: ['recording', 'idle'],
  // stopping: stop tap (legacy). completion: live stop (no local processing).
  // processing: legacy finalize. idle: failure reset.
  recording: ['stopping', 'processing', 'completion', 'idle'],
  stopping: ['processing', 'completion', 'idle'],
  processing: ['uploading', 'completion', 'idle'],
  uploading: ['completion', 'idle'],
  completion: ['idle'],
}

export type CameraFacing = 'front' | 'back'

export interface RecordingState {
  phase: RecordingPhase
  /** Which camera the user wants. The publisher/camera owns the real state. */
  facing: CameraFacing
  /** Mid-recording camera swap target (legacy segment path). */
  pendingFacing: CameraFacing | null
  /** Bumped to force a CameraView remount after a mount error (legacy path). */
  cameraResetCounter: number
  isCameraReady: boolean
  cameraMountError: string | null
  isLivePublisherAvailable: boolean
  /** Seconds recorded so far (ticked by the active screen). */
  recordingDuration: number
  /** Local file URI (legacy) or 'live' sentinel once a recording was saved. */
  videoUri: string | null
  /** Legacy processing/upload progress (0–100) and stage label. */
  progress: number
  progressStage: string
  /** Live pre-connect failed; UI offers retry. */
  preConnectFailed: boolean
  /** Idle preview hit the expiry window before the server reaped it. */
  previewExpired: boolean
}

const defaultRecordingState: RecordingState = {
  phase: 'idle',
  facing: 'front',
  pendingFacing: null,
  cameraResetCounter: 0,
  isCameraReady: false,
  cameraMountError: null,
  isLivePublisherAvailable: false,
  recordingDuration: 0,
  videoUri: null,
  progress: 0,
  progressStage: '',
  preConnectFailed: false,
  previewExpired: false,
}

// Not persisted: a recording flow never survives an app restart.
export const recordingStore$ = observable<RecordingState>(defaultRecordingState)

export const recordingActions = {
  /** The only sanctioned way to change phase. */
  setPhase: (phase: RecordingPhase, reason?: string) => {
    const current = recordingStore$.phase.peek()
    if (current === phase) {
      return
    }

    if (!VALID_TRANSITIONS[current].includes(phase)) {
      telemetry.error('recording:invalid_transition', 'Unexpected recording phase transition', {
        from: current,
        to: phase,
        reason,
      })
    }

    recordingStore$.phase.set(phase)
  },

  /**
   * Clear all per-attempt state and return to idle. Camera availability and
   * facing survive — they describe the device/session, not the attempt.
   */
  resetFlow: () => {
    recordingStore$.phase.set('idle')
    recordingStore$.pendingFacing.set(null)
    recordingStore$.recordingDuration.set(0)
    recordingStore$.videoUri.set(null)
    recordingStore$.progress.set(0)
    recordingStore$.progressStage.set('')
  },

  /** Full reset, including device/session flags. For unmount/teardown. */
  reset: () => {
    recordingStore$.set({
      ...defaultRecordingState,
      // Availability is a device property probed once; keep it.
      isLivePublisherAvailable: recordingStore$.isLivePublisherAvailable.peek(),
    })
  },
}
