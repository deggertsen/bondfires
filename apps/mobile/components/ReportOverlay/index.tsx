import { bondfireColors } from '@bondfires/config'
import { useObservable, useValue } from '@legendapp/state/react'
import { X } from '@tamagui/lucide-icons'
import { useMutation } from 'convex/react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
} from 'react-native'
import { YStack, XStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import { CategoryStep } from './CategoryStep'
import { CommentsStep } from './CommentsStep'
import { SubCategoryStep } from './SubCategoryStep'
import { SuccessStep } from './SuccessStep'
import { WarningStep } from './WarningStep'
import {
  CATEGORIES,
  type Category,
  type ReportOverlayProps,
  type ReportStep,
  type SubCategory,
} from './types'

export function ReportOverlay({
  bondfireId,
  bondfireVideoId,
  videoOwnerId,
  onClose,
}: ReportOverlayProps) {
  const state$ = useObservable({
    step: 'category' as ReportStep,
    category: null as Category | null,
    subCategory: null as SubCategory | null,
    comments: '',
    isSubmitting: false,
    error: null as string | null,
  })

  const step = useValue(state$.step)
  const comments = useValue(state$.comments)
  const isSubmitting = useValue(state$.isSubmitting)
  const error = useValue(state$.error)

  const submitReport = useMutation(api.reports.submit)

  const handleCategorySelect = (cat: Category) => {
    state$.category.set(cat)
    const categoryConfig = CATEGORIES.find((c) => c.value === cat)
    if (categoryConfig?.hasSubcategories) {
      state$.step.set('subcategory')
    } else {
      state$.step.set('comments')
    }
  }

  const handleSubCategorySelect = (subCat: SubCategory) => {
    state$.subCategory.set(subCat)
    state$.step.set('comments')
  }

  const handleCommentsNext = () => {
    state$.step.set('warning')
  }

  const handleSubmit = async () => {
    const category = state$.category.get()
    const subCategory = state$.subCategory.get()
    const currentComments = state$.comments.get()

    if (!category) return

    state$.isSubmitting.set(true)
    state$.error.set(null)

    try {
      await submitReport({
        bondfireId,
        bondfireVideoId,
        videoOwnerId,
        category,
        subCategory: subCategory || undefined,
        comments: currentComments.trim(),
      })
      state$.step.set('success')
    } catch (err) {
      state$.error.set(err instanceof Error ? err.message : 'Failed to submit report')
    } finally {
      state$.isSubmitting.set(false)
    }
  }

  const handleBack = () => {
    const currentStep = state$.step.get()
    const category = state$.category.get()

    if (currentStep === 'subcategory') {
      state$.step.set('category')
      state$.category.set(null)
    } else if (currentStep === 'comments') {
      if (category === 'community_guidelines') {
        state$.step.set('subcategory')
        state$.subCategory.set(null)
      } else {
        state$.step.set('category')
        state$.category.set(null)
      }
    } else if (currentStep === 'warning') {
      state$.step.set('comments')
    }
  }

  const renderContent = () => {
    switch (step) {
      case 'category':
        return <CategoryStep onSelect={handleCategorySelect} />

      case 'subcategory':
        return (
          <SubCategoryStep
            onSelect={handleSubCategorySelect}
            onBack={handleBack}
          />
        )

      case 'comments':
        return (
          <CommentsStep
            value={comments}
            onChange={(text) => state$.comments.set(text)}
            onNext={handleCommentsNext}
            onBack={handleBack}
          />
        )

      case 'warning':
        return (
          <WarningStep
            isSubmitting={isSubmitting}
            error={error}
            onSubmit={handleSubmit}
            onBack={handleBack}
          />
        )

      case 'success':
        return <SuccessStep onClose={onClose} />
    }
  }

  return (
    <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <YStack flex={1} justifyContent="flex-end">
          <Pressable onPress={(e) => e.stopPropagation()}>
            <YStack
              backgroundColor={bondfireColors.charcoal}
              borderTopLeftRadius={24}
              borderTopRightRadius={24}
              padding={20}
              paddingBottom={40}
            >
              {/* Close button - hide on success screen */}
              {step !== 'success' && (
                <XStack justifyContent="flex-end" marginBottom={16}>
                  <Pressable onPress={onClose}>
                    <X size={24} color={bondfireColors.ash} />
                  </Pressable>
                </XStack>
              )}
              {renderContent()}
            </YStack>
          </Pressable>
        </YStack>
      </KeyboardAvoidingView>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
})

export type { ReportOverlayProps } from './types'
