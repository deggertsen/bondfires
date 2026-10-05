import {
  EmptySubscriptionCatalogError,
  type IapCatalogFailure,
  type IapCatalogFailureKind,
} from './subscriptionIapPolicy'

class IapCatalogLoadError extends Error {
  constructor(
    message: string,
    readonly underlyingError: unknown,
    readonly failureKind: IapCatalogFailureKind,
    readonly returnedProductIds: string[],
    readonly missingSubscriptionProductIds: string[],
    readonly optionalProductError: unknown,
  ) {
    super(message)
    this.name = 'IapCatalogLoadError'
  }
}

interface CatalogInput<T extends { id: string }> {
  fetchProducts: (request: { skus: string[]; type: 'subs' | 'in-app' }) => Promise<T[] | T | null>
  subscriptionProductIds: string[]
  inAppProductIds: string[]
}

export async function loadSubscriptionCatalog<T extends { id: string }>({
  fetchProducts,
  subscriptionProductIds,
  inAppProductIds,
}: CatalogInput<T>) {
  // Fetch subscriptions and in-app products separately.
  // Billing 8.x + openiap-google 2.2.1 throws on ProductQueryType.All if
  // either product type query fails (e.g., no INAPP products configured in
  // Play Console), so we avoid 'all' and query each type independently.
  const [subsProducts, inappProducts] = await Promise.allSettled([
    fetchProducts({ skus: subscriptionProductIds, type: 'subs' }),
    fetchProducts({
      skus: inAppProductIds,
      type: 'in-app',
    }),
  ])

  const returnedInAppProducts =
    inappProducts.status === 'fulfilled'
      ? Array.isArray(inappProducts.value)
        ? inappProducts.value
        : [inappProducts.value]
      : []
  const returnedInAppProductIds = returnedInAppProducts
    .filter((product): product is T => !!product?.id)
    .map((product) => product.id)

  // Subscription pricing is required for the paywall. Kindling packs are an
  // optional add-on, so their failure is logged without blocking subscriptions.
  if (subsProducts.status === 'rejected') {
    throw new IapCatalogLoadError(
      'Failed to fetch subscription products.',
      subsProducts.reason,
      'fetch_rejected',
      returnedInAppProductIds,
      [...subscriptionProductIds],
      inappProducts.status === 'rejected' ? inappProducts.reason : undefined,
    )
  }

  const subsList = Array.isArray(subsProducts.value) ? subsProducts.value : [subsProducts.value]
  const availableSubscriptionProducts = subsList.filter((product): product is T => !!product?.id)
  if (availableSubscriptionProducts.length === 0) {
    throw new IapCatalogLoadError(
      'The store returned no subscription products.',
      new EmptySubscriptionCatalogError(),
      'empty_subscription_catalog',
      returnedInAppProductIds,
      [...subscriptionProductIds],
      inappProducts.status === 'rejected' ? inappProducts.reason : undefined,
    )
  }

  const allProducts = [...availableSubscriptionProducts, ...returnedInAppProducts]
  const availableProducts = allProducts.filter((product): product is T => !!product?.id)
  const returnedSubscriptionProductIds = new Set(
    availableSubscriptionProducts.map((product) => product.id),
  )
  const missingSubscriptionProductIds = subscriptionProductIds.filter(
    (productId) => !returnedSubscriptionProductIds.has(productId),
  )

  return {
    products: availableProducts,
    returnedProductIds: availableProducts.map((product) => product.id),
    missingSubscriptionProductIds,
    optionalProductError: inappProducts.status === 'rejected' ? inappProducts.reason : undefined,
  }
}

export function getCatalogFailure(
  error: unknown,
  fallbackKind: IapCatalogFailureKind = 'connection_failed',
): IapCatalogFailure {
  if (error instanceof IapCatalogLoadError) {
    return {
      error: error.underlyingError,
      optionalProductError: error.optionalProductError,
      failureKind: error.failureKind,
      returnedProductIds: error.returnedProductIds,
      missingSubscriptionProductIds: error.missingSubscriptionProductIds,
    }
  }
  return {
    error,
    failureKind: fallbackKind,
    returnedProductIds: [] as string[],
    missingSubscriptionProductIds: [] as string[],
  }
}
