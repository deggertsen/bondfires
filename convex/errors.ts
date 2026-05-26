import { ConvexError } from 'convex/values'

export function throwUserError(message: string): never {
  throw new ConvexError(message)
}
