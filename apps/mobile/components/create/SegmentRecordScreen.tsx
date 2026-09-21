import { telemetry, usePresence } from '@bondfires/app'
import { Spinner, Text } from '@bondfires/ui'
import { Flame, X } from '@tamagui/lucide-icons'
import { useConvex } from 'convex/react'
import type { FunctionArgs } from 'convex/server'
import * as Crypto from 'expo-crypto'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, AppState, BackHandler, Pressable, StatusBar } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { serializeSegmentCapture } from '../../lib/media/segmentCapture'
import {
  hasSavedDraftCapture,
  markSegmentCapture,
  prepareSegmentJob,
  runSegmentUploads,
  segmentUploadClient,
  segmentUploadError,
} from '../../lib/media/segmentUploads'
import { useOptionalQuery } from '../../lib/media/useOptionalQuery'
import { BondfireLivePublisher, LivePublisherView } from '../../modules/bondfire-live-publisher'
import { CompletionScreen } from '../CompletionScreen'
import { InviteSheet } from '../InviteSheet'
import { NotepadOverlay } from '../NotepadOverlay'
import { ViewerPresenceStack } from '../ViewerPresenceStack'
import { VIDEO_OVERLAY_COLORS } from '../videoOverlayColors'
import { RecordingHeaderActions } from './RecordingHeaderActions'

export function SegmentRecordScreen({
  userId,
  options,
  maxDuration,
  campName,
  isScreenFocused,
  isAppActive,
  onBack,
  onContinue,
  onRecordAnother,
}: {
  userId: string
  options: Omit<FunctionArgs<typeof api.segmentMedia.begin>, 'localId'>
  maxDuration: number
  campName?: string
  isScreenFocused: boolean
  isAppActive: boolean
  onBack: () => void
  onContinue: (bondfireId?: Id<'bondfires'>, responseId?: Id<'bondfireVideos'>) => void
  onRecordAnother: (bondfireId: Id<'bondfires'>) => void
}) {
  const client = useConvex()
  const insets = useSafeAreaInsets()
  const [showNotes, setShowNotes] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [switchingCamera, setSwitchingCamera] = useState(false)
  const [phase, setPhase] = useState<
    'warming' | 'ready' | 'starting' | 'recording' | 'saving' | 'saved' | 'error' | 'uploading'
  >('warming')
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const durationLimit = useRef(maxDuration)
  durationLimit.current = maxDuration
  const localId = useRef(Crypto.randomUUID().toLowerCase())
  // This subscription follows the uploader; recording never waits on it.
  const { data: destination, error: destinationError } = useOptionalQuery(
    api.segmentMedia.getOwnRecording,
    { localId: localId.current },
  )
  const metadataError = destinationError?.message
  useEffect(() => {
    if (metadataError) telemetry.error('segment:destination:failed', metadataError)
  }, [metadataError])
  const bondfireId = destination?.bondfireId ?? options.draftBondfireId ?? options.bondfireId
  const ownedBondfireId = options.isResponse ? undefined : bondfireId
  const { viewers } = usePresence({
    videoType: options.isResponse ? 'response' : 'bondfire',
    videoId: options.isResponse ? destination?.responseId : bondfireId,
    isActive: phase === 'recording' && destination?.videoStatus === 'live',
    isScreenFocused,
    isAppActive,
    currentUserId: userId,
  })
  const started = useRef(0)
  const recording = useRef(false)
  const busy = useRef(false)
  const initialOptions = useRef(options)
  const mounted = useRef(true)
  const hasRecorded = useRef(false)
  const interrupted = useRef(false)
  const pending = useRef<Promise<void>>(Promise.resolve())
  const enqueue = useCallback((operation: () => Promise<void>) => {
    pending.current = serializeSegmentCapture(operation)
    return pending.current
  }, [])
  const reportError = useCallback((stage: string, value: unknown) => {
    const message = value instanceof Error ? value.message : String(value)
    telemetry.error(`segment:${stage}:failed`, message)
    if (mounted.current) setError(message)
  }, [])
  const stopRef = useRef<() => Promise<void>>(async () => {})
  const closeRef = useRef<() => void>(() => {})
  useEffect(() => {
    mounted.current = true
    void enqueue(async () => {
      try {
        const draftId = initialOptions.current.draftBondfireId
        if (draftId && (await hasSavedDraftCapture(userId, draftId))) {
          hasRecorded.current = true
          if (mounted.current) setPhase('uploading')
          void runSegmentUploads(segmentUploadClient(client), userId)
          return
        }
        await prepareSegmentJob(userId, { ...initialOptions.current, localId: localId.current })
        await BondfireLivePublisher.startSegmentPreview({ initialCamera: 'front' })
        if (mounted.current && !interrupted.current) setPhase('ready')
      } catch (e) {
        if (mounted.current) {
          reportError('preview', e)
          setPhase('error')
        }
      }
    })
    const timer = setInterval(() => {
      if (recording.current) {
        const seconds = (Date.now() - started.current) / 1000
        setElapsed(seconds)
        if (seconds >= durationLimit.current) void stopRef.current()
      }
      const uploadError = segmentUploadError()
      if (uploadError) setError(uploadError)
    }, 250)
    const state = AppState.addEventListener('change', (value) => {
      // Stop deliberately on background/interruption, preserving complete media.
      interrupted.current = value !== 'active'
      if (value !== 'active') {
        if (!hasRecorded.current) setPhase('warming')
        void (async () => {
          await pending.current.catch(() => {})
          if (!mounted.current) return
          await stopRef.current()
          await enqueue(async () => {
            // A quick permission-sheet/background round trip may already have
            // queued the next preview. Never tear it down from a stale event.
            if (mounted.current && interrupted.current) await BondfireLivePublisher.stop()
          })
        })().catch((e) => {
          if (mounted.current) reportError('background', e)
        })
      } else if (!hasRecorded.current) {
        setPhase('warming')
        void enqueue(async () => {
          if (!mounted.current || interrupted.current || hasRecorded.current) return
          await BondfireLivePublisher.startSegmentPreview({ initialCamera: 'front' })
          if (mounted.current && !interrupted.current) setPhase('ready')
        }).catch((e) => {
          if (mounted.current) {
            reportError('resume', e)
            setPhase('error')
          }
        })
      }
    })
    const nativeError = BondfireLivePublisher.addListener('error', (event) => {
      reportError('native', event.message)
      if (recording.current) void stopRef.current()
    })
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (recording.current || busy.current) {
        closeRef.current()
        return true
      }
      return false
    })
    return () => {
      mounted.current = false
      clearInterval(timer)
      state.remove()
      nativeError.remove()
      back.remove()
      void enqueue(async () => {
        if (recording.current) {
          try {
            await BondfireLivePublisher.stopSegmentRecording()
          } catch {}
        }
        markSegmentCapture(localId.current, false)
        await BondfireLivePublisher.stop()
      }).catch(() => {})
      void deactivateKeepAwake('segment-recording')
    }
  }, [client, enqueue, reportError, userId])
  async function start() {
    if (busy.current || phase !== 'ready') return
    busy.current = true
    setPhase('starting')
    try {
      await enqueue(async () => {
        if (!mounted.current || interrupted.current) throw new Error('Camera is not active')
        const draftId = initialOptions.current.draftBondfireId
        if (draftId && (await hasSavedDraftCapture(userId, draftId))) {
          hasRecorded.current = true
          if (mounted.current) setPhase('uploading')
          void runSegmentUploads(segmentUploadClient(client), userId)
          return
        }
        markSegmentCapture(localId.current, true)
        await activateKeepAwakeAsync('segment-recording')
        await BondfireLivePublisher.startSegmentRecording(localId.current, maxDuration)
        started.current = Date.now()
        recording.current = true
        hasRecorded.current = true
        if (mounted.current) setPhase('recording')
      })
    } catch (e) {
      markSegmentCapture(localId.current, false)
      reportError('start', e)
      setPhase('error')
    } finally {
      busy.current = false
      if (interrupted.current && recording.current) void stopRef.current()
    }
  }
  async function stop() {
    // A camera swap may be queued/running. Stop must still queue behind it,
    // including the duration limit and background interruption paths.
    if (!recording.current) return
    busy.current = true
    recording.current = false
    setPhase('saving')
    try {
      await enqueue(async () => {
        await BondfireLivePublisher.stopSegmentRecording()
        await BondfireLivePublisher.stop()
      })
      markSegmentCapture(localId.current, false)
      setPhase('saved')
      void runSegmentUploads(segmentUploadClient(client), userId)
    } catch (e) {
      reportError('stop', e)
      setPhase('error')
    } finally {
      markSegmentCapture(localId.current, false)
      busy.current = false
      void deactivateKeepAwake('segment-recording')
    }
  }
  stopRef.current = stop
  function close() {
    if (recording.current) {
      Alert.alert('Stop recording?', 'Your Bondfire will be saved and shared.', [
        { text: 'Keep Recording', style: 'cancel' },
        { text: 'Stop & Save', onPress: () => void stopRef.current() },
      ])
    } else if (!busy.current) {
      onBack()
    }
  }
  closeRef.current = close

  async function retryPreview() {
    if (busy.current || hasRecorded.current) return
    busy.current = true
    setError(null)
    setPhase('warming')
    try {
      await enqueue(async () => {
        await BondfireLivePublisher.stop()
        // A failed native start may still have written media. Leave its journal
        // for recovery and give the retry a fresh destination on this device.
        markSegmentCapture(localId.current, false)
        localId.current = Crypto.randomUUID().toLowerCase()
        await prepareSegmentJob(userId, { ...initialOptions.current, localId: localId.current })
        await BondfireLivePublisher.startSegmentPreview({ initialCamera: 'front' })
      })
      if (mounted.current) setPhase('ready')
    } catch (e) {
      reportError('preview_retry', e)
      if (mounted.current) setPhase('error')
    } finally {
      busy.current = false
    }
  }
  async function switchCamera() {
    if (busy.current || (phase !== 'ready' && phase !== 'recording')) return
    busy.current = true
    setSwitchingCamera(true)
    try {
      await enqueue(async () => {
        if (mounted.current && !interrupted.current) await BondfireLivePublisher.swapCamera()
      })
    } catch (e) {
      reportError('flip', e)
    } finally {
      busy.current = false
      if (mounted.current) setSwitchingCamera(false)
    }
  }
  if (phase === 'saved' || phase === 'uploading') {
    return (
      <CompletionScreen
        bondfireId={ownedBondfireId}
        campName={campName}
        inviteMode={options.personalCamp ? 'personal-bondfire' : 'bondfire'}
        detail={
          destination?.videoStatus === 'ready'
            ? undefined
            : error
              ? 'Your recording is saved on this device. Uploading will resume when the connection is available.'
              : 'Your recording is saved. You can keep using the app while it finishes uploading.'
        }
        onContinue={() => onContinue(bondfireId, destination?.responseId)}
        onRecordAnother={bondfireId ? () => onRecordAnother(bondfireId) : undefined}
      />
    )
  }
  const isRecording = phase === 'recording'
  const isBusy = phase === 'warming' || phase === 'starting' || phase === 'saving'
  const recordDisabled = !isRecording && (switchingCamera || phase !== 'ready')
  const remaining = Math.max(0, Math.ceil(maxDuration - elapsed))
  const countdown = isRecording && remaining <= 30
  const timerSeconds = countdown ? remaining : Math.floor(elapsed)
  const timerLabel = `${Math.floor(timerSeconds / 60)}:${String(timerSeconds % 60).padStart(2, '0')}`
  const statusLabel = isRecording
    ? countdown
      ? `${remaining}s remaining`
      : 'Tap to stop'
    : phase === 'ready'
      ? 'Tap to record'
      : phase === 'warming'
        ? 'Preparing camera…'
        : phase === 'starting'
          ? 'Starting recording…'
          : phase === 'saving'
            ? 'Saving your recording…'
            : 'Recording unavailable'
  return (
    <YStack flex={1} backgroundColor="$background">
      {/* Fixed overlay colors preserve contrast over the camera in both themes. */}
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <LivePublisherView style={{ flex: 1 }} />
      <XStack
        position="absolute"
        top={0}
        left={0}
        right={0}
        paddingTop={Math.max(insets.top + 12, 60)}
        paddingHorizontal={20}
        justifyContent="space-between"
        alignItems="center"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close recording"
          onPress={close}
          disabled={phase === 'starting' || phase === 'saving'}
        >
          <YStack
            width={40}
            height={40}
            borderRadius={20}
            backgroundColor={VIDEO_OVERLAY_COLORS.pillBackground}
            alignItems="center"
            justifyContent="center"
          >
            <X size={24} color={VIDEO_OVERLAY_COLORS.textPrimary} />
          </YStack>
        </Pressable>
        {isRecording && (
          <YStack
            backgroundColor={countdown ? '$warning' : '$error'}
            paddingHorizontal={16}
            paddingVertical={6}
            borderRadius={16}
          >
            <Text color={VIDEO_OVERLAY_COLORS.textPrimary} fontWeight="800" fontSize={14}>
              {`● REC ${timerLabel}`}
            </Text>
          </YStack>
        )}
        <RecordingHeaderActions
          onSwitchCamera={() => void switchCamera()}
          cameraSwitchDisabled={(phase !== 'ready' && phase !== 'recording') || switchingCamera}
          cameraSwitchInProgress={switchingCamera}
          onOpenNotes={options.isResponse ? () => setShowNotes(true) : undefined}
        />
      </XStack>
      {isRecording && destination?.videoStatus === 'live' && (
        <ViewerPresenceStack
          liveViewers={viewers}
          style={{ top: Math.max(insets.top + 62, 110), left: 20 }}
        />
      )}
      <YStack
        position="absolute"
        left={0}
        right={0}
        top="40%"
        alignItems="center"
        pointerEvents="box-none"
        paddingHorizontal={24}
      >
        {phase === 'ready' && (
          <YStack alignItems="center" gap={12} pointerEvents="none">
            <XStack alignItems="center" gap={8}>
              <Flame size={28} color="$primary" />
              <Text color={VIDEO_OVERLAY_COLORS.textPrimary} fontSize={22} fontWeight="700">
                {options.isResponse ? 'Respond' : (campName ?? 'Spark a Bondfire')}
              </Text>
            </XStack>
            <Text color={VIDEO_OVERLAY_COLORS.textSecondary} fontSize={14}>
              Tap to record
            </Text>
          </YStack>
        )}
        {isBusy && (
          <YStack alignItems="center" gap={12} pointerEvents="none">
            <Spinner size="large" color={VIDEO_OVERLAY_COLORS.textPrimary} />
            <Text color={VIDEO_OVERLAY_COLORS.textPrimary} fontSize={18} fontWeight="700">
              {statusLabel}
            </Text>
          </YStack>
        )}
        {phase === 'error' && (
          <YStack alignItems="center" gap={16}>
            <Text color={VIDEO_OVERLAY_COLORS.textPrimary} fontSize={18} fontWeight="700">
              {hasRecorded.current ? 'Recording interrupted' : "Camera couldn't start"}
            </Text>
            <Text color={VIDEO_OVERLAY_COLORS.textSecondary} textAlign="center">
              {hasRecorded.current
                ? 'We’ll keep trying to upload the saved portions of your recording.'
                : error}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                hasRecorded.current
                  ? onContinue(bondfireId, destination?.responseId)
                  : void retryPreview()
              }
            >
              <YStack
                paddingHorizontal={24}
                paddingVertical={10}
                borderRadius={20}
                backgroundColor="$primary"
              >
                <Text color={VIDEO_OVERLAY_COLORS.textPrimary} fontWeight="800">
                  {hasRecorded.current ? 'Continue' : 'Try Again'}
                </Text>
              </YStack>
            </Pressable>
          </YStack>
        )}
      </YStack>
      <YStack
        position="absolute"
        left={0}
        right={0}
        bottom={Math.max(insets.bottom + 16, 40)}
        alignItems="center"
      >
        {ownedBondfireId && (phase === 'ready' || isRecording) && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Share Bondfire link"
            onPress={() => setShowInvite(true)}
          >
            <YStack
              paddingHorizontal={14}
              paddingVertical={8}
              borderRadius={16}
              backgroundColor={VIDEO_OVERLAY_COLORS.pillBackground}
              marginBottom={14}
            >
              <Text color={VIDEO_OVERLAY_COLORS.textPrimary} fontSize={13} fontWeight="800">
                Share Link
              </Text>
            </YStack>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isRecording ? 'Stop recording' : 'Start recording'}
          accessibilityState={{ disabled: recordDisabled }}
          disabled={recordDisabled}
          onPress={() => void (isRecording ? stop() : start())}
        >
          <YStack
            width={80}
            height={80}
            borderRadius={40}
            borderWidth={4}
            borderColor={VIDEO_OVERLAY_COLORS.textPrimary}
            alignItems="center"
            justifyContent="center"
            backgroundColor={isRecording ? '$error' : 'transparent'}
            opacity={recordDisabled ? 0.7 : 1}
          >
            {isBusy ? (
              <Spinner size="small" color={VIDEO_OVERLAY_COLORS.textPrimary} />
            ) : (
              <YStack
                width={isRecording ? 30 : 60}
                height={isRecording ? 30 : 60}
                borderRadius={isRecording ? 6 : 30}
                backgroundColor={isRecording ? VIDEO_OVERLAY_COLORS.textPrimary : '$primary'}
              />
            )}
          </YStack>
        </Pressable>
        <Text color={VIDEO_OVERLAY_COLORS.textSecondary} fontSize={13} marginTop={12}>
          {statusLabel}
        </Text>
      </YStack>
      {ownedBondfireId && (
        <InviteSheet
          mode={options.personalCamp ? 'personal-bondfire' : 'bondfire'}
          id={ownedBondfireId}
          open={showInvite}
          onClose={() => setShowInvite(false)}
        />
      )}
      {showNotes && <NotepadOverlay autoFocus={false} onClose={() => setShowNotes(false)} />}
    </YStack>
  )
}
