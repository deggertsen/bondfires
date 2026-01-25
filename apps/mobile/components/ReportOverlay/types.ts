import type { Id } from '../../../../convex/_generated/dataModel'

// Report flow step types
export type ReportStep =
  | 'category'
  | 'subcategory'
  | 'comments'
  | 'warning'
  | 'success'

// Main report categories
export type Category =
  | 'camp_guidelines'
  | 'community_guidelines'
  | 'terms_of_service'
  | 'privacy_policy'

// Sub-categories for Community Guidelines
export type SubCategory =
  | 'harassment_or_abuse'
  | 'discrimination'
  | 'harmful_content'
  | 'spam_or_solicitation'
  | 'misinformation'
  | 'impersonation'
  | 'pornographic_content'
  | 'child_safety_concern'
  | 'other'

// Category configuration
export interface CategoryConfig {
  value: Category
  label: string
  hasSubcategories: boolean
}

// Sub-category configuration
export interface SubCategoryConfig {
  value: SubCategory
  label: string
}

// Props for the main ReportOverlay - uses typed Convex IDs
export interface ReportOverlayProps {
  // Exactly one of these must be provided
  bondfireId?: Id<'bondfires'>
  bondfireVideoId?: Id<'bondfireVideos'>
  videoOwnerId: Id<'users'>
  onClose: () => void
}

// Shared step props
export interface StepProps {
  onBack?: () => void
}

// Category step props
export interface CategoryStepProps extends StepProps {
  onSelect: (category: Category) => void
}

// Sub-category step props
export interface SubCategoryStepProps extends StepProps {
  onSelect: (subCategory: SubCategory) => void
}

// Comments step props
export interface CommentsStepProps extends StepProps {
  value: string
  onChange: (value: string) => void
  onNext: () => void
}

// Warning step props
export interface WarningStepProps extends StepProps {
  isSubmitting: boolean
  error: string | null
  onSubmit: () => void
}

// Success step props
export interface SuccessStepProps {
  onClose: () => void
}

// Category definitions
export const CATEGORIES: CategoryConfig[] = [
  {
    value: 'camp_guidelines',
    label: 'Camp Guidelines Violation',
    hasSubcategories: false,
  },
  {
    value: 'community_guidelines',
    label: 'Community Guidelines Violation',
    hasSubcategories: true,
  },
  {
    value: 'terms_of_service',
    label: 'Terms of Service Violation',
    hasSubcategories: false,
  },
  {
    value: 'privacy_policy',
    label: 'Privacy Policy Violation',
    hasSubcategories: false,
  },
]

// Sub-category definitions
export const SUBCATEGORIES: SubCategoryConfig[] = [
  { value: 'harassment_or_abuse', label: 'Harassment or Abuse' },
  { value: 'discrimination', label: 'Discrimination' },
  { value: 'harmful_content', label: 'Harmful Content' },
  { value: 'spam_or_solicitation', label: 'Spam or Solicitation' },
  { value: 'misinformation', label: 'Misinformation' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'pornographic_content', label: 'Pornographic Content' },
  { value: 'child_safety_concern', label: 'Child Safety Concern' },
  { value: 'other', label: 'Other' },
]

// Minimum required characters for comments
export const MIN_COMMENT_LENGTH = 30
