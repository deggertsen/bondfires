import { NativeModules } from 'react-native'

type VideoSegmentMergerModule = {
  mergeVideoSegments(segmentUris: string[]): Promise<string>
}

const VideoSegmentMerger = NativeModules.VideoSegmentMerger as VideoSegmentMergerModule | undefined

export async function mergeVideoSegments(segmentUris: string[]): Promise<string> {
  if (segmentUris.length === 0) {
    throw new Error('At least one segment is required to merge video')
  }

  if (segmentUris.length === 1) {
    return segmentUris[0]
  }

  if (!VideoSegmentMerger) {
    throw new Error('VideoSegmentMerger native module is unavailable')
  }

  return await VideoSegmentMerger.mergeVideoSegments(segmentUris)
}
