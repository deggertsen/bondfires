import { describe, expect, it } from 'vitest'
import {
  completeBannerExit,
  nextBannerPresence,
  UPLOAD_BANNER_HIDDEN,
  type UploadBannerPresence,
} from '../../../packages/app/src/utils/uploadBannerPresence'

const show = { visible: true, immediateHide: false }
const hideAnimated = { visible: false, immediateHide: false }
const hideImmediate = { visible: false, immediateHide: true }

const shown: UploadBannerPresence = { mounted: true, exiting: false }
const exiting: UploadBannerPresence = { mounted: true, exiting: true }

describe('nextBannerPresence', () => {
  it('mounts on show', () => {
    expect(nextBannerPresence(UPLOAD_BANNER_HIDDEN, show)).toEqual({
      mounted: true,
      exiting: false,
    })
  })

  it('returns the same object when a visible state is unchanged', () => {
    expect(nextBannerPresence(shown, show)).toBe(shown)
  })

  it('animates the exit for a status-driven hide', () => {
    expect(nextBannerPresence(shown, hideAnimated)).toEqual({ mounted: true, exiting: true })
  })

  it('keeps exiting stable rather than restarting it', () => {
    expect(nextBannerPresence(exiting, hideAnimated)).toBe(exiting)
  })

  it('hides immediately for the camera/recording lock or create route', () => {
    expect(nextBannerPresence(shown, hideImmediate)).toEqual({ mounted: false, exiting: false })
    expect(nextBannerPresence(exiting, hideImmediate)).toEqual({ mounted: false, exiting: false })
  })

  it('does nothing when already hidden', () => {
    expect(nextBannerPresence(UPLOAD_BANNER_HIDDEN, hideAnimated)).toBe(UPLOAD_BANNER_HIDDEN)
    expect(nextBannerPresence(UPLOAD_BANNER_HIDDEN, hideImmediate)).toBe(UPLOAD_BANNER_HIDDEN)
  })

  it('cancels an in-flight exit when the strip is shown again', () => {
    expect(nextBannerPresence(exiting, show)).toEqual({ mounted: true, exiting: false })
  })
})

describe('completeBannerExit', () => {
  it('unmounts once an in-flight exit finishes', () => {
    expect(completeBannerExit(exiting)).toBe(UPLOAD_BANNER_HIDDEN)
  })

  it('ignores a late completion after a re-show cancelled the exit', () => {
    expect(completeBannerExit(shown)).toBe(shown)
  })

  it('is a no-op when already hidden', () => {
    expect(completeBannerExit(UPLOAD_BANNER_HIDDEN)).toBe(UPLOAD_BANNER_HIDDEN)
  })

  it('composes with a re-show: show during exit, then late completion, stays mounted', () => {
    const reshown = nextBannerPresence(exiting, show)
    expect(completeBannerExit(reshown)).toBe(reshown)
  })
})
