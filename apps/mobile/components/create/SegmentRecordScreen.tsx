import { useAppThemeColors } from '@bondfires/app'
import { Button, Text } from '@bondfires/ui'
import { useConvex } from 'convex/react'
import type { FunctionArgs } from 'convex/server'
import * as Crypto from 'expo-crypto'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, BackHandler } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { XStack, YStack } from 'tamagui'
import type { api } from '../../../../convex/_generated/api'
import { serializeSegmentCapture } from '../../lib/media/segmentCapture'
import {
  markSegmentCapture,
  prepareSegmentJob,
  runSegmentUploads,
  segmentUploadClient,
  segmentUploadError,
} from '../../lib/media/segmentUploads'
import { BondfireLivePublisher, LivePublisherView } from '../../modules/bondfire-live-publisher'

export function SegmentRecordScreen({
  userId,
  options,
  maxDuration,
  onBack,
}: {
  userId: string
  options: Omit<FunctionArgs<typeof api.segmentMedia.begin>, 'localId'>
  maxDuration: number
  onBack: () => void
}) {
  const client = useConvex()
  const insets = useSafeAreaInsets()
  const { colors } = useAppThemeColors()
  const [phase, setPhase] = useState<
    'warming' | 'ready' | 'starting' | 'recording' | 'saving' | 'saved' | 'error'
  >('warming')
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const localId = useRef(Crypto.randomUUID().toLowerCase())
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
  const stopRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    mounted.current = true
    void enqueue(async () => {
      try {
        await prepareSegmentJob(userId, { ...initialOptions.current, localId: localId.current })
        await BondfireLivePublisher.startSegmentPreview({ initialCamera: 'front' })
        if (mounted.current) setPhase('ready')
      } catch (e) {
        if (mounted.current) {
          setError(String(e))
          setPhase('error')
        }
      }
    })
    const timer = setInterval(() => {
      if (recording.current) {
        const seconds = (Date.now() - started.current) / 1000
        setElapsed(seconds)
        if (seconds >= maxDuration) void stopRef.current()
      }
      const uploadError = segmentUploadError()
      if (uploadError) setError(uploadError)
    }, 250)
    const state = AppState.addEventListener('change', (value) => {
      // Stop deliberately on background/interruption, preserving complete media.
      interrupted.current = value !== 'active'
      if (value !== 'active') {
        void (async () => {
          await pending.current.catch(() => {})
          await stopRef.current()
          await enqueue(async () => {
            await BondfireLivePublisher.stop()
          })
        })().catch((e) => {
          if (mounted.current) setError(String(e))
        })
      } else if (!hasRecorded.current) {
        setPhase('warming')
        void enqueue(async () => {
          await BondfireLivePublisher.startSegmentPreview({ initialCamera: 'front' })
          if (mounted.current) setPhase('ready')
        }).catch((e) => {
          if (mounted.current) {
            setError(String(e))
            setPhase('error')
          }
        })
      }
    })
    const nativeError = BondfireLivePublisher.addListener('error', (event) => {
      setError(event.message)
      if (recording.current) void stopRef.current()
    })
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (recording.current || busy.current) {
        void stopRef.current()
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
  }, [enqueue, maxDuration, userId])
  async function start() {
    if (busy.current || phase !== 'ready') return
    busy.current = true
    setPhase('starting')
    markSegmentCapture(localId.current, true)
    try {
      await enqueue(async () => {
        if (!mounted.current || interrupted.current) throw new Error('Camera is not active')
        await activateKeepAwakeAsync('segment-recording')
        await BondfireLivePublisher.startSegmentRecording(localId.current, maxDuration)
        started.current = Date.now()
        recording.current = true
        hasRecorded.current = true
        if (mounted.current) setPhase('recording')
      })
    } catch (e) {
      markSegmentCapture(localId.current, false)
      setError(String(e))
      setPhase('error')
    } finally {
      busy.current = false
      if (interrupted.current && recording.current) void stopRef.current()
    }
  }
  async function stop() {
    if (!recording.current || busy.current) return
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
      setError(String(e))
      setPhase('error')
    } finally {
      markSegmentCapture(localId.current, false)
      busy.current = false
      void deactivateKeepAwake('segment-recording')
    }
  }
  stopRef.current = stop
  return (
    <YStack
      flex={1}
      backgroundColor="$background"
      paddingTop={insets.top}
      paddingBottom={insets.bottom}
    >
      <XStack padding="$3" justifyContent="space-between" alignItems="center">
        <Button
          onPress={onBack}
          disabled={phase === 'starting' || phase === 'recording' || phase === 'saving'}
        >
          Back
        </Button>
        <Text color="$color">
          {Math.floor(elapsed / 60)}:{String(Math.floor(elapsed % 60)).padStart(2, '0')}
        </Text>
        <Button
          onPress={() => {
            void BondfireLivePublisher.swapCamera().catch((e) => setError(String(e)))
          }}
          disabled={phase !== 'ready'}
        >
          Flip
        </Button>
      </XStack>
      {phase === 'saved' ? (
        <YStack flex={1} justifyContent="center" padding="$4" gap="$3">
          <Text color="$color">Recording saved</Text>
          <Text color="$color">
            Your video is uploading. You can leave this screen; uploads resume when you reopen the
            app.
          </Text>
          <Button onPress={onBack}>Done</Button>
        </YStack>
      ) : (
        <LivePublisherView style={{ flex: 1, backgroundColor: colors.background }} />
      )}
      {error && (
        <Text padding="$3" color="$error">
          {error}
        </Text>
      )}
      {phase !== 'saved' && (
        <Button
          margin="$3"
          disabled={phase !== 'ready' && phase !== 'recording'}
          onPress={() => {
            void (phase === 'recording' ? stop() : start())
          }}
        >
          {phase === 'recording'
            ? 'Stop recording'
            : phase === 'ready'
              ? 'Record'
              : phase === 'warming'
                ? 'Preparing camera…'
                : phase === 'saving'
                  ? 'Saving…'
                  : 'Recording unavailable'}
        </Button>
      )}
    </YStack>
  )
}
