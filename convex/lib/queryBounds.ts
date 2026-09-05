export type NumericBound = {
  defaultValue: number
  min: number
  max: number
  name: string
}

/** Validate a caller-controlled count before it reaches take/paginate. */
export function boundedInteger(value: number | undefined, bound: NumericBound): number {
  const resolved = value ?? bound.defaultValue
  if (!Number.isSafeInteger(resolved) || resolved < bound.min) {
    throw new Error(`${bound.name} must be an integer of at least ${bound.min}`)
  }
  return Math.min(resolved, bound.max)
}

/** Increase a requested result page into a bounded visibility scan page. */
export function boundedScanSize(requested: number, multiplier: number, max: number): number {
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error('requested page size must be a positive integer')
  }
  if (!Number.isSafeInteger(multiplier) || multiplier < 1) {
    throw new Error('scan multiplier must be a positive integer')
  }
  return Math.min(requested * multiplier, max)
}
