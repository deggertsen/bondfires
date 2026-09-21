import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { makeFunctionReference } from 'convex/server'
import { createElement } from 'react'
// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useOptionalQuery } from '../lib/media/useOptionalQuery'

it('keeps optional queries stable across renders and contains errors while targets change', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const client = new ConvexReactClient('https://example.convex.cloud')
  const listeners = new Set<() => void>()
  const results = new Map<string, string[] | Error | undefined>([['first', ['reaction']]])
  vi.spyOn(client, 'watchQuery').mockImplementation(
    (...input: Parameters<typeof client.watchQuery>) => {
      const args = input[1] ?? {}
      return {
        localQueryResult: () => {
          const value = results.get(args.id as string)
          if (value instanceof Error) throw value
          return value
        },
        onUpdate: (cb: () => void) => {
          listeners.add(cb)
          return () => {
            listeners.delete(cb)
          }
        },
        journal: () => undefined,
        localQueryLogs: () => undefined,
      }
    },
  )
  const query = () => makeFunctionReference<'query', { id: string }, string[]>('test:optional')
  let latest: ReturnType<typeof useOptionalQuery<ReturnType<typeof query>>> | undefined
  function Harness({ id }: { id?: string }) {
    // Fresh references/objects model normal component renders, including timers.
    latest = useOptionalQuery(query(), id ? { id } : 'skip')
    return null
  }
  const tree = (id?: string) =>
    // biome-ignore lint/correctness/noChildrenProp: ConvexProvider requires children in its props type for createElement.
    createElement(ConvexProvider, { client, children: createElement(Harness, { id }) })
  let renderer: ReturnType<typeof create>
  try {
    await act(async () => {
      renderer = create(tree('first'))
    })
    expect(latest?.data).toEqual(['reaction'])
    for (let i = 0; i < 3; i++)
      await act(async () => {
        renderer.update(tree('first'))
      })
    expect(listeners.size).toBe(1)
    const error = new Error('Reaction query failed')
    await act(async () => {
      results.set('first', error)
      for (const notify of listeners) notify()
    })
    expect(latest?.error).toBe(error)
    expect(latest?.data).toBeUndefined()
    await act(async () => {
      renderer.update(tree('second'))
    })
    expect(latest?.data).toBeUndefined()
    expect(latest?.error).toBeUndefined()
    await act(async () => {
      results.set('second', ['new reaction'])
      for (const notify of listeners) notify()
    })
    expect(latest?.data).toEqual(['new reaction'])
    await act(async () => {
      renderer.update(tree())
    })
    expect(latest?.data).toBeUndefined()
    expect(listeners.size).toBe(0)
  } finally {
    await act(async () => renderer?.unmount())
    await client.close()
  }
})
