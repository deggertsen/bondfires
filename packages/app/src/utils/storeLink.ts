export type StoreLinkResult = { opened: true } | { opened: false; error: unknown }

/** Opens a store URL without allowing a native linking failure to reject an event handler. */
export async function openStoreLink(
  url: string,
  openUrl: (target: string) => Promise<unknown>,
): Promise<StoreLinkResult> {
  try {
    await openUrl(url)
    return { opened: true }
  } catch (error: unknown) {
    return { opened: false, error }
  }
}
