// Theme-independent colors for controls rendered over video.
// Video content is unpredictable, so these surfaces keep light text on dark overlays.
export const VIDEO_OVERLAY_COLORS = {
  gradientTop: ['rgba(20, 20, 22, 0.9)', 'rgba(20, 20, 22, 0.5)', 'transparent'] as const,
  gradientBottom: ['transparent', 'rgba(20, 20, 22, 0.6)', 'rgba(20, 20, 22, 0.9)'] as const,
  gradientBottomThin: ['transparent', 'rgba(20, 20, 22, 0.9)'] as const,
  pillBackground: 'rgba(31, 32, 35, 0.8)',
  popoverBackground: 'rgba(0, 0, 0, 0.9)',
  playPauseBackground: 'rgba(20, 20, 22, 0.6)',
  loadingBackground: 'rgba(20, 20, 22, 0.7)',
  textPrimary: '#F3F4F6',
  textSecondary: '#9CA3AF',
  progressTrack: 'rgba(255,255,255,0.3)',
  dotInactive: 'rgba(255,255,255,0.4)',
} as const
