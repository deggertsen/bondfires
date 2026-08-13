import { BondfireRow, type BondfireRowProps } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { Flame } from '@tamagui/lucide-icons'
import { Image } from 'expo-image'
import type { BondfireThumbnailFields } from '../lib/bondfireThumbnails'
import { getBondfireThumbnailPlayback } from '../lib/bondfireThumbnails'
import type { BondfireThumbnailUrls$ } from '../lib/useBondfireThumbnails'

type ThumbnailBondfire = BondfireThumbnailFields & { _id: string }

type BondfireThumbnailSubscriptionProps = {
  bondfire: ThumbnailBondfire
  thumbnailUrls$: BondfireThumbnailUrls$
}

function useBondfireThumbnailUrl({ bondfire, thumbnailUrls$ }: BondfireThumbnailSubscriptionProps) {
  const playback = getBondfireThumbnailPlayback(bondfire)
  return useValue(() => (playback ? (thumbnailUrls$[playback.cacheKey].get() ?? null) : null))
}

export function BondfireThumbnailRow({
  bondfire,
  thumbnailUrls$,
  ...rowProps
}: Omit<BondfireRowProps, 'thumbnailUrl'> & BondfireThumbnailSubscriptionProps) {
  return (
    <BondfireRow
      {...rowProps}
      thumbnailUrl={null}
      thumbnailContent={
        <BondfireThumbnailContent
          bondfire={bondfire}
          thumbnailUrls$={thumbnailUrls$}
          fallbackSize={30}
        />
      }
    />
  )
}

export function BondfireThumbnailContent({
  bondfire,
  thumbnailUrls$,
  fallbackSize = 18,
}: BondfireThumbnailSubscriptionProps & { fallbackSize?: number }) {
  const thumbnailUrl = useBondfireThumbnailUrl({ bondfire, thumbnailUrls$ })

  return thumbnailUrl ? (
    <Image
      source={{ uri: thumbnailUrl }}
      style={{ width: '100%', height: '100%' }}
      contentFit="cover"
      cachePolicy="memory-disk"
    />
  ) : (
    <Flame size={fallbackSize} color="$primary" />
  )
}
