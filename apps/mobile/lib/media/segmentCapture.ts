// Native capture is a process-wide resource. Serialize teardown and warm-up
// across screen instances so leaving and reopening cannot stop a newer camera.
let captureTail: Promise<void> = Promise.resolve()
export function serializeSegmentCapture(operation: () => Promise<void>): Promise<void> {
  captureTail = captureTail.catch(() => {}).then(operation)
  return captureTail
}
