interface ValidationResult {
  valid: boolean
  error?: string
}

/**
 * Validate that the user can create a spark in the given camp.
 * Call this before starting an upload — returns { valid: true } on success
 * or { valid: false, error: '...' } with a user-facing error message.
 *
 * @param queryFn - Convex query function (e.g., api.videos.validateCreateCamp)
 * @param args - The camp context to validate
 */
export async function validateCreateCampBeforeUpload(
  queryFn: (args: {
    campId: string
    durationMs?: number
    tags?: string[]
  }) => Promise<ValidationResult>,
  args: { campId: string; durationMs?: number; tags?: string[] },
): Promise<ValidationResult> {
  try {
    return await queryFn(args)
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unable to validate camp access',
    }
  }
}

/**
 * Validate that the user can respond to the given bondfire.
 * Call this before starting an upload — returns { valid: true } on success
 * or { valid: false, error: '...' } with a user-facing error message.
 *
 * @param queryFn - Convex query function (e.g., api.videos.validateRespondCamp)
 * @param args - The bondfire context to validate
 */
export async function validateRespondBeforeUpload(
  queryFn: (args: { bondfireId: string; durationMs?: number }) => Promise<ValidationResult>,
  args: { bondfireId: string; durationMs?: number },
): Promise<ValidationResult> {
  try {
    return await queryFn(args)
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unable to validate response access',
    }
  }
}
