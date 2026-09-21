/** R2 may throw on a failed conditional put. A completed retry is still success. */
export async function putImmutable(
  checksum: string,
  readChecksum: () => Promise<string | null>,
  write: () => Promise<unknown>,
): Promise<boolean> {
  const existing = await readChecksum()
  if (existing !== null) return existing === checksum
  try {
    await write()
  } catch (error) {
    const raced = await readChecksum()
    if (raced !== null) return raced === checksum
    throw error
  }
  return (await readChecksum()) === checksum
}
