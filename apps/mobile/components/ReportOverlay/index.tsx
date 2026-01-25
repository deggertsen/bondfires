import { bondfireColors } from '@bondfires/config'
import { X } from '@tamagui/lucide-icons'
import { useMutation } from 'convex/react'
import { useState } from 'react'
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
  const [step, setStep] = useState<ReportStep>('category')
  const [category, setCategory] = useState<Category | null>(null)
  const [subCategory, setSubCategory] = useState<SubCategory | null>(null)
  const [comments, setComments] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submitReport = useMutation(api.reports.submit)

  const handleCategorySelect = (cat: Category) => {
    setCategory(cat)
    const categoryConfig = CATEGORIES.find((c) => c.value === cat)
    if (categoryConfig?.hasSubcategories) {
      setStep('subcategory')
    } else {
      setStep('comments')
    }
  }

  const handleSubCategorySelect = (subCat: SubCategory) => {
    setSubCategory(subCat)
    setStep('comments')
  }

  const handleCommentsNext = () => {
    setStep('warning')
  }

  const handleSubmit = async () => {
    if (!category) return

    setIsSubmitting(true)
    setError(null)

    try {
      await submitReport({
        bondfireId,
        bondfireVideoId,
        videoOwnerId,
        category,
        subCategory: subCategory || undefined,
        comments: comments.trim(),
      })
      setStep('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit report')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleBack = () => {
    if (step === 'subcategory') {
      setStep('category')
      setCategory(null)
    } else if (step === 'comments') {
      if (category === 'community_guidelines') {
        setStep('subcategory')
        setSubCategory(null)
      } else {
        setStep('category')
        setCategory(null)
      }
    } else if (step === 'warning') {
      setStep('comments')
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
            onChange={setComments}
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
