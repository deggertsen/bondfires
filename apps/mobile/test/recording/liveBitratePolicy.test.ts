import { describe, expect, it } from 'vitest'
import {
  ABR_DOWN_SAMPLE_LIMIT,
  ABR_POST_CUT_HOLD_SAMPLES,
  ABR_UP_SAMPLE_LIMIT,
  composeLiveVideoBitrate,
  createNetworkBitrateController,
  LIVE_AUDIO_BITRATE_BPS,
  LIVE_VIDEO_BITRATE_LADDER,
} from '../../../../packages/app/src/utils/liveBitratePolicy'

const supported = (bitrateBps: number) => ({ bitrateBps, statsSupported: true })
const unsupported = { bitrateBps: 0, statsSupported: false }

function expectedForTier(tier: number) {
  const bitrate = LIVE_VIDEO_BITRATE_LADDER[tier as 0 | 1 | 2 | 3]
  return bitrate + LIVE_AUDIO_BITRATE_BPS
}

describe('liveBitratePolicy', () => {
  it('starts at the ceiling tier', () => {
    const controller = createNetworkBitrateController()
    expect(controller.tier()).toBe(0)
    expect(controller.bitrate()).toBe(LIVE_VIDEO_BITRATE_LADDER[0])
  })

  it('ignores unmeasured samples', () => {
    const controller = createNetworkBitrateController()
    for (let i = 0; i < 10; i++) {
      expect(controller.sample(unsupported).action).toBe('hold')
    }
    expect(controller.tier()).toBe(0)
  })

  it('steps down after sustained congestion', () => {
    const controller = createNetworkBitrateController()
    const congested = supported(expectedForTier(0) * 0.5)

    expect(controller.sample(congested).action).toBe('hold')
    for (let i = 1; i < ABR_DOWN_SAMPLE_LIMIT; i++) {
      const decision = controller.sample(congested)
      if (i === ABR_DOWN_SAMPLE_LIMIT - 1) {
        expect(decision).toMatchObject({
          action: 'step_down',
          tier: 1,
          bitrate: LIVE_VIDEO_BITRATE_LADDER[1],
          fromTier: 0,
        })
      } else {
        expect(decision.action).toBe('hold')
      }
    }
    expect(controller.tier()).toBe(1)
  })

  it('can step down to the survival floor', () => {
    const controller = createNetworkBitrateController()
    for (let tier = 0; tier < LIVE_VIDEO_BITRATE_LADDER.length - 1; tier++) {
      const congested = supported(expectedForTier(tier) * 0.4)
      for (let i = 0; i < ABR_DOWN_SAMPLE_LIMIT; i++) {
        controller.sample(congested)
      }
    }
    expect(controller.tier()).toBe(LIVE_VIDEO_BITRATE_LADDER.length - 1)
    expect(controller.bitrate()).toBe(LIVE_VIDEO_BITRATE_LADDER[3])

    // Already at floor — further congestion holds.
    const stillCongested = supported(expectedForTier(3) * 0.2)
    for (let i = 0; i < ABR_DOWN_SAMPLE_LIMIT + 2; i++) {
      expect(controller.sample(stillCongested).action).toBe('hold')
    }
    expect(controller.tier()).toBe(3)
  })

  it('holds after a cut before allowing recovery probes', () => {
    const controller = createNetworkBitrateController()
    const congested = supported(expectedForTier(0) * 0.4)
    for (let i = 0; i < ABR_DOWN_SAMPLE_LIMIT; i++) {
      controller.sample(congested)
    }
    expect(controller.tier()).toBe(1)

    const healthy = supported(expectedForTier(1) * 0.95)
    for (let i = 0; i < ABR_POST_CUT_HOLD_SAMPLES; i++) {
      expect(controller.sample(healthy).action).toBe('hold')
      expect(controller.tier()).toBe(1)
    }
  })

  it('steps up only after sustained healthy samples past the hold', () => {
    const controller = createNetworkBitrateController()
    const congested = supported(expectedForTier(0) * 0.4)
    for (let i = 0; i < ABR_DOWN_SAMPLE_LIMIT; i++) {
      controller.sample(congested)
    }

    const healthy = supported(expectedForTier(1) * 0.95)
    // Drain post-cut hold
    for (let i = 0; i < ABR_POST_CUT_HOLD_SAMPLES; i++) {
      controller.sample(healthy)
    }

    for (let i = 0; i < ABR_UP_SAMPLE_LIMIT - 1; i++) {
      expect(controller.sample(healthy).action).toBe('hold')
    }
    expect(controller.sample(healthy)).toMatchObject({
      action: 'step_up',
      tier: 0,
      bitrate: LIVE_VIDEO_BITRATE_LADDER[0],
      fromTier: 1,
    })
  })

  it('resets streaks when samples land in the ambiguous band', () => {
    const controller = createNetworkBitrateController()
    const congested = supported(expectedForTier(0) * 0.5)
    controller.sample(congested) // 1 bad

    // ~80% is between 70% down and 90% up thresholds
    const ambiguous = supported(expectedForTier(0) * 0.8)
    controller.sample(ambiguous)

    // Bad streak must have reset — one more congested sample should not step.
    expect(controller.sample(congested).action).toBe('hold')
    expect(controller.tier()).toBe(0)
  })

  it('judges congestion against the bitrate actually configured by thermal mitigation', () => {
    const controller = createNetworkBitrateController()
    const thermalTarget = 800_000
    const healthyAtThermalTarget = supported((thermalTarget + LIVE_AUDIO_BITRATE_BPS) * 0.95)

    for (let i = 0; i < ABR_DOWN_SAMPLE_LIMIT + 2; i++) {
      expect(
        controller.sample({
          ...healthyAtThermalTarget,
          targetVideoBitrateBps: thermalTarget,
          recoveryCeilingBps: thermalTarget,
        }).action,
      ).toBe('hold')
    }
    expect(controller.tier()).toBe(0)
  })

  it('skips network tiers that cannot lower a thermally constrained encoder', () => {
    const controller = createNetworkBitrateController()
    const thermalTarget = 800_000
    const congested = supported((thermalTarget + LIVE_AUDIO_BITRATE_BPS) * 0.5)

    controller.sample({
      ...congested,
      targetVideoBitrateBps: thermalTarget,
      recoveryCeilingBps: thermalTarget,
    })
    expect(
      controller.sample({
        ...congested,
        targetVideoBitrateBps: thermalTarget,
        recoveryCeilingBps: thermalTarget,
      }),
    ).toMatchObject({
      action: 'step_down',
      tier: 3,
      bitrate: LIVE_VIDEO_BITRATE_LADDER[3],
      fromTier: 0,
    })
  })

  it('does not recover into a tier hidden by the thermal ceiling', () => {
    const controller = createNetworkBitrateController()
    controller.reset(2)
    const thermalTarget = 800_000
    const healthy = supported((thermalTarget + LIVE_AUDIO_BITRATE_BPS) * 0.95)

    for (let i = 0; i < ABR_UP_SAMPLE_LIMIT + 2; i++) {
      expect(
        controller.sample({
          ...healthy,
          targetVideoBitrateBps: thermalTarget,
          recoveryCeilingBps: thermalTarget,
        }).action,
      ).toBe('hold')
    }
    expect(controller.tier()).toBe(2)
  })

  it('composes network and thermal ceilings with min()', () => {
    expect(composeLiveVideoBitrate(2_500_000, 800_000)).toBe(800_000)
    expect(composeLiveVideoBitrate(600_000, 1_500_000)).toBe(600_000)
  })

  it('reset restores the ceiling', () => {
    const controller = createNetworkBitrateController()
    const congested = supported(expectedForTier(0) * 0.4)
    for (let i = 0; i < ABR_DOWN_SAMPLE_LIMIT; i++) {
      controller.sample(congested)
    }
    expect(controller.tier()).toBe(1)

    controller.reset()
    expect(controller.tier()).toBe(0)
    expect(controller.bitrate()).toBe(LIVE_VIDEO_BITRATE_LADDER[0])
  })
})
