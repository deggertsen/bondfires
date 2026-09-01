import { useObservable, useValue } from '@legendapp/state/react'
import { X } from '@tamagui/lucide-icons'
import { useMutation } from 'convex/react'
import { Alert, Modal, Pressable, StyleSheet } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import { CategoryStep } from './CategoryStep'
import { CommentsStep } from './CommentsStep'
import { SubCategoryStep } from './SubCategoryStep'
import { SuccessStep } from './SuccessStep'
import { TargetStep } from './TargetStep'
import {
  CATEGORIES,
  type Category,
  type ReportOverlayProps,
  type ReportStep,
  type ReportTarget,
  type SubCategory,
} from './types'
import { WarningStep } from './WarningStep'

export function ReportOverlay({
  bondfireId,
  bondfireVideoId,
  videoOwnerId,
  onClose,
}: ReportOverlayProps) {
  const state$ = useObservable({
    step: 'target' as ReportStep,
    target: null as ReportTarget | null,
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
  const blockUser = useMutation(api.userSafety.block)

  const handleCategorySelect = (cat: Category) => {
    state$.category.set(cat)
    const categoryConfig = CATEGORIES.find((c) => c.value === cat)
    if (categoryConfig?.hasSubcategories) {
      state$.step.set('subcategory')
    } else {
      state$.step.set('comments')
    }
  }

  const handleTargetSelect = (target: ReportTarget) => {
    state$.target.set(target)
    state$.step.set('category')
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
      const target = state$.target.get()
      await submitReport({
        bondfireId: target === 'content' ? bondfireId : undefined,
        bondfireVideoId: target === 'content' ? bondfireVideoId : undefined,
        reportedUserId: target === 'user' ? videoOwnerId : undefined,
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
    } else if (currentStep === 'category') {
      state$.step.set('target')
      state$.target.set(null)
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
      case 'target':
        return (
          <TargetStep
            onSelect={handleTargetSelect}
            onBlock={() => {
              Alert.alert(
                'Block this user?',
                'You will no longer see or receive interactions from each other. You can unblock them from Profile.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Block',
                    style: 'destructive',
                    onPress: async () => {
                      try {
                        await blockUser({ userId: videoOwnerId })
                        onClose()
                      } catch (err) {
                        Alert.alert(
                          'Unable to block user',
                          err instanceof Error ? err.message : 'Try again',
                        )
                      }
                    },
                  },
                ],
              )
            }}
          />
        )

      case 'category':
        return <CategoryStep onSelect={handleCategorySelect} />

      case 'subcategory':
        return <SubCategoryStep onSelect={handleSubCategorySelect} onBack={handleBack} />

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
        return (
          <SuccessStep
            onClose={onClose}
            isBlocking={isSubmitting}
            onBlock={async () => {
              state$.isSubmitting.set(true)
              try {
                await blockUser({ userId: videoOwnerId })
                onClose()
              } catch (err) {
                Alert.alert(
                  'Unable to block user',
                  err instanceof Error ? err.message : 'Try again',
                )
              } finally {
                state$.isSubmitting.set(false)
              }
            }}
          />
        )
    }
  }

  // Rendered in a Modal so the overlay escapes its mount point's stacking
  // context — it was previously drawn underneath screen-level siblings (the
  // Share Bondfire / Respond bar) when mounted inside a carousel item, and
  // the nested KeyboardAvoidingView mismeasured the keyboard overlap there,
  // leaving the Continue button hidden behind the iOS keyboard.
  return (
    <Modal transparent visible animationType="slide" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        <KeyboardAvoidingView style={styles.container} behavior="padding">
          <YStack flex={1} justifyContent="flex-end">
            <Pressable onPress={(e) => e.stopPropagation()}>
              <YStack
                backgroundColor={'$backgroundPress'}
                borderTopLeftRadius={24}
                borderTopRightRadius={24}
                padding={20}
                paddingBottom={40}
              >
                {/* Close button - hide on success screen */}
                {step !== 'success' && (
                  <XStack justifyContent="flex-end" marginBottom={16}>
                    <Pressable onPress={onClose}>
                      <X size={24} color={'$placeholderColor'} />
                    </Pressable>
                  </XStack>
                )}
                {renderContent()}
              </YStack>
            </Pressable>
          </YStack>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
})

export type { ReportOverlayProps } from './types'
