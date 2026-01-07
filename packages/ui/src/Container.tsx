import { styled, YStack, GetProps } from 'tamagui'

export const Container = styled(YStack, {
  name: 'Container',
  flex: 1,
  backgroundColor: '$background',
  
  variants: {
    centered: {
      true: {
        alignItems: 'center',
        justifyContent: 'center',
      },
    },
    padded: {
      true: {
        padding: '$4',
      },
      sm: {
        padding: '$2',
      },
      md: {
        padding: '$4',
      },
      lg: {
        padding: '$6',
      },
    },
    safe: {
      true: {
        paddingTop: '$6',
        paddingBottom: '$4',
      },
    },
  } as const,
})

export const Row = styled(YStack, {
  name: 'Row',
  flexDirection: 'row',
  alignItems: 'center',
  
  variants: {
    gap: {
      sm: { gap: '$2' },
      md: { gap: '$3' },
      lg: { gap: '$4' },
    },
    justify: {
      start: { justifyContent: 'flex-start' },
      center: { justifyContent: 'center' },
      end: { justifyContent: 'flex-end' },
      between: { justifyContent: 'space-between' },
      around: { justifyContent: 'space-around' },
    },
  } as const,
})

export const Column = styled(YStack, {
  name: 'Column',
  
  variants: {
    gap: {
      sm: { gap: '$2' },
      md: { gap: '$3' },
      lg: { gap: '$4' },
    },
    align: {
      start: { alignItems: 'flex-start' },
      center: { alignItems: 'center' },
      end: { alignItems: 'flex-end' },
      stretch: { alignItems: 'stretch' },
    },
  } as const,
})

export type ContainerProps = GetProps<typeof Container>
export type RowProps = GetProps<typeof Row>
export type ColumnProps = GetProps<typeof Column>

