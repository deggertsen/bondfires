import { telemetry } from '@bondfires/app'
import { useEffect } from 'react'
import type { Doc, Id } from '../../../../../../convex/_generated/dataModel'
import type { BondfireDetailData } from './bondfireDetailHelpers'
import { withLiveDvrStart } from './bondfireDetailHelpers'

type GetVideoUrls = (args: {
  muxPlaybackId: string
  muxPlaybackPolicy?: Doc<'bondfires'>['muxPlaybackPolicy']
  bondfireId?: Id<'bondfires'>
  bondfireVideoId?: Id<'bondfireVideos'>
}) => Promise<{ hdUrl: string }>

export function useBondfireVideoUrls({
  bondfireData,
  getVideoUrls,
  setVideoUrls,
}: {
  bondfireData: BondfireDetailData | null | undefined
  getVideoUrls: GetVideoUrls
  setVideoUrls: (urls: (string | null)[]) => void
}) {
  useEffect(() => {
    if (!bondfireData) return

    const loadUrls = async () => {
      const mainPlaybackId =
        bondfireData.videoStatus === 'live'
          ? bondfireData.muxLivePlaybackId
          : bondfireData.muxPlaybackId
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

        setVideoUrls([
          withLiveDvrStart(mainUrl.hdUrl, bondfireData.videoStatus === 'live'),
          ...responseUrls.map((responseUrl, index) =>
            withLiveDvrStart(responseUrl.hdUrl, playableResponses[index]?.videoStatus === 'live'),
          ),
        ])

        telemetry.info('video:urls:resolved', 'Video URLs resolved', {
          bondfireId: bondfireData._id,
          mainHasToken: mainUrl.hdUrl.includes('token='),
          responseCount: responseUrls.length,
          totalVideos: 1 + responseUrls.length,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        telemetry.error('video:urls:failed', message, {
          bondfireId: bondfireData._id,
          muxPlaybackId: mainPlaybackId,
          muxPlaybackPolicy: bondfireData.muxPlaybackPolicy,
        })
      }
    }

    loadUrls()
  }, [bondfireData, getVideoUrls, setVideoUrls])
}
