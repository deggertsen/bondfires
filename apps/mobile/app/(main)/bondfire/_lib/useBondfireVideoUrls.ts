import { telemetry } from '@bondfires/app'
import { useEffect, useRef } from 'react'
import type { Doc, Id } from '../../../../../../convex/_generated/dataModel'
import type { BondfireDetailData } from './bondfireDetailHelpers'
import { withLiveDvrStart } from './bondfireDetailHelpers'

type GetVideoUrls = (args: {
  muxPlaybackId: string
  muxPlaybackPolicy?: Doc<'bondfires'>['muxPlaybackPolicy']
  bondfireId?: Id<'bondfires'>
  bondfireVideoId?: Id<'bondfireVideos'>
}) => Promise<{ hdUrl: string }>

function getPlaybackIdForVideo(
  video: Pick<BondfireDetailData, 'videoStatus' | 'muxLivePlaybackId' | 'muxPlaybackId'>,
) {
  return (video.videoStatus ?? 'ready') === 'live' ? video.muxLivePlaybackId : video.muxPlaybackId
}

function shouldLoadMainVideoUrls(bondfireData: BondfireDetailData) {
  const status = bondfireData.videoStatus ?? 'ready'
  return status === 'ready' || status === 'live'
}

function getVideoUrlSetKey(bondfireData: BondfireDetailData) {
  return [
    bondfireData._id,
    bondfireData.videoStatus ?? 'ready',
    getPlaybackIdForVideo(bondfireData) ?? '',
    ...bondfireData.videos.map(
      (video) =>
        `${video._id}:${video.videoStatus ?? 'ready'}:${getPlaybackIdForVideo(video) ?? ''}`,
    ),
  ].join('|')
}

export function useBondfireVideoUrls({
  bondfireData,
  getVideoUrls,
  setVideoUrls,
}: {
  bondfireData: BondfireDetailData | null | undefined
  getVideoUrls: GetVideoUrls
  setVideoUrls: (urls: (string | null)[]) => void
}) {
  const videoUrlSetKeyRef = useRef<string | null>(null)
  const loadedVideoUrlSetKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!bondfireData) {
      if (videoUrlSetKeyRef.current !== null) {
        videoUrlSetKeyRef.current = null
        loadedVideoUrlSetKeyRef.current = null
        setVideoUrls([])
      }
      return
    }

    let isCancelled = false
    const videoUrlSetKey = getVideoUrlSetKey(bondfireData)
    if (videoUrlSetKeyRef.current !== videoUrlSetKey) {
      videoUrlSetKeyRef.current = videoUrlSetKey
      loadedVideoUrlSetKeyRef.current = null
      setVideoUrls(Array.from({ length: 1 + bondfireData.videos.length }, () => null))
    }

    if (!shouldLoadMainVideoUrls(bondfireData)) {
      return () => {
        isCancelled = true
      }
    }

    if (loadedVideoUrlSetKeyRef.current === videoUrlSetKey) {
      return () => {
        isCancelled = true
      }
    }

    const loadUrls = async () => {
      const mainPlaybackId = getPlaybackIdForVideo(bondfireData)
      if (!mainPlaybackId) {
        telemetry.warn('video:urls:missing_playback_id', 'No playback ID for bondfire', {
          bondfireId: bondfireData._id,
          videoStatus: bondfireData.videoStatus,
        })
        return
      }

      try {
        const mainUrl = await getVideoUrls({
          muxPlaybackId: mainPlaybackId,
          muxPlaybackPolicy: bondfireData.muxPlaybackPolicy,
          bondfireId: bondfireData._id,
        })

        const playableResponses = bondfireData.videos.filter((video) =>
          video.videoStatus === 'live' ? !!video.muxLivePlaybackId : !!video.muxPlaybackId,
        )
        const responseUrls = await Promise.all(
          playableResponses.map((video) =>
            getVideoUrls({
              muxPlaybackId:
                video.videoStatus === 'live'
                  ? (video.muxLivePlaybackId as string)
                  : (video.muxPlaybackId as string),
              muxPlaybackPolicy: video.muxPlaybackPolicy,
              bondfireVideoId: video._id,
            }),
          ),
        )

        if (isCancelled) return

        setVideoUrls([
          withLiveDvrStart(mainUrl.hdUrl, bondfireData.videoStatus === 'live'),
          ...responseUrls.map((responseUrl, index) =>
            withLiveDvrStart(responseUrl.hdUrl, playableResponses[index]?.videoStatus === 'live'),
          ),
        ])
        loadedVideoUrlSetKeyRef.current = videoUrlSetKey
      } catch (error) {
        if (isCancelled) return

        const message = error instanceof Error ? error.message : String(error)
        telemetry.error('video:urls:failed', message, {
          bondfireId: bondfireData._id,
          muxPlaybackId: mainPlaybackId,
          muxPlaybackPolicy: bondfireData.muxPlaybackPolicy,
        })
      }
    }

    loadUrls()

    return () => {
      isCancelled = true
    }
  }, [bondfireData, getVideoUrls, setVideoUrls])
}
