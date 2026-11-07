import { createElement, useState } from 'react'
// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { LimitControl } from '../../components/camps/CampSettingsControls'

vi.mock('@bondfires/app', () => ({ useAppThemeColors: () => ({ colors: { color: '#000000' } }) }))
vi.mock('@bondfires/ui', () => ({ Text: 'Text' }))
vi.mock('@tamagui/lucide-icons', () => ({
  Check: 'Check',
  Globe: 'Globe',
  Lock: 'Lock',
  Minus: 'Minus',
  Plus: 'Plus',
}))
vi.mock('react-native', () => ({ Pressable: 'Pressable', TextInput: 'TextInput' }))
vi.mock('tamagui', () => ({ XStack: 'XStack', YStack: 'YStack' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('camp numeric limits', () => {
  it('saves typed limits before blur while allowing multi-digit age entry', async () => {
    let current: number | null = null
    function Harness() {
      const [value, setValue] = useState<number | null>(21)
      current = value
      return createElement(LimitControl, {
        label: 'Minimum age',
        min: 18,
        max: 120,
        defaultValue: 21,
        value,
        onChange: setValue,
      })
    }
    let renderer: ReturnType<typeof create>
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    try {
      const input = () => renderer.root.findByType('TextInput')
      await act(async () => {
        input().props.onFocus()
      })
      await act(async () => {
        input().props.onChangeText('3')
      })
      expect(input().props.value).toBe('3')
      await act(async () => {
        input().props.onChangeText('35')
      })
      // This is the value Save reads, with no blur or submit event.
      expect(current).toBe(35)
      expect(input().props.value).toBe('35')
      const raise = renderer.root
        .findAllByType('Pressable')
        .find(
          (button: { props: { accessibilityLabel?: string } }) =>
            button.props.accessibilityLabel === 'Raise minimum age',
        )
      await act(async () => {
        raise.props.onPress()
      })
      expect(current).toBe(36)
      expect(input().props.value).toBe('36')
      await act(async () => {
        input().props.onChangeText('999')
      })
      expect(current).toBe(120)
      await act(async () => {
        input().props.onBlur()
      })
      expect(input().props.value).toBe('120')
    } finally {
      await act(async () => {
        renderer.unmount()
      })
    }
  })

  it('bounds a newly enabled age limit by the other age field', async () => {
    const onChange = vi.fn()
    let renderer: ReturnType<typeof create>
    await act(async () => {
      renderer = create(
        createElement(LimitControl, {
          label: 'Maximum age',
          min: 80,
          max: 120,
          defaultValue: 65,
          value: null,
          onChange,
        }),
      )
    })
    try {
      const options = renderer.root.findAllByType('Pressable')
      await act(async () => {
        options[1].props.onPress()
      })
      expect(onChange).toHaveBeenCalledWith(80)
    } finally {
      await act(async () => {
        renderer.unmount()
      })
    }
  })
})
