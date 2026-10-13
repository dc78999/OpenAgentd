import { beforeEach, describe, expect, it } from 'bun:test'
import { createSharedGlobalEventStream } from '@/api/shared-global-events'
import type { ChannelLike, LockManagerLike } from '@/api/shared-global-events'
import type { GlobalEventCallbacks } from '@/api/global-events'

/** FIFO exclusive locks by name, released when the callback's promise settles. */
function fakeLocks(): LockManagerLike {
  const tails = new Map<string, Promise<unknown>>()
  return {
    request(name, options, callback) {
      const previous = tails.get(name) ?? Promise.resolve()
      const run = new Promise<unknown>((resolve, reject) => {
        let waiting = true
        options.signal?.addEventListener('abort', () => {
          if (waiting) reject(new DOMException('aborted', 'AbortError'))
        })
        previous.then(() => {
          if (!waiting || options.signal?.aborted) return
          waiting = false
          callback().then(resolve, reject)
        })
      })
      // The next waiter goes when this one settles, aborted or not.
      tails.set(name, run.catch(() => undefined))
      return run
    },
  }
}

/** Same-name channels see each other's messages, never their own. */
function fakeChannels() {
  const byName = new Map<string, Set<FakeChannel>>()
  class FakeChannel implements ChannelLike {
    onmessage: ((event: { data: unknown }) => void) | null = null
    closed = false
    readonly name: string
    constructor(name: string) {
      this.name = name
      if (!byName.has(name)) byName.set(name, new Set())
      byName.get(name)!.add(this)
    }
    postMessage(message: unknown) {
      for (const peer of byName.get(this.name) ?? []) {
        if (peer === this || peer.closed) continue
        queueMicrotask(() => { if (!peer.closed) peer.onmessage?.({ data: structuredClone(message) }) })
      }
    }
    close() {
      this.closed = true
      byName.get(this.name)?.delete(this)
    }
  }
  return (name: string): ChannelLike => new FakeChannel(name)
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

interface Real { callbacks: GlobalEventCallbacks; signal?: AbortSignal }

function setup() {
  const locks = fakeLocks()
  const makeChannel = fakeChannels()
  const real: Real[] = []
  const openStream = (callbacks: GlobalEventCallbacks, signal?: AbortSignal) => { real.push({ callbacks, signal }) }
  const makeWindow = (key = 'http://a/api') => {
    const received: string[] = []
    const log = { opens: 0, errors: 0, received }
    const controller = new AbortController()
    createSharedGlobalEventStream({ locks, makeChannel, openStream, key })(
      {
        onOpen: () => { log.opens++ },
        onEvent: (type) => { received.push(type) },
        onError: () => { log.errors++ },
      },
      controller.signal,
    )
    return { log, controller }
  }
  return { real, makeWindow }
}

let env: ReturnType<typeof setup>
beforeEach(() => { env = setup() })

describe('sharedGlobalEventStream', () => {
  it('opens one real stream for three windows and fans events out in order', async () => {
    const a = env.makeWindow()
    const b = env.makeWindow()
    const c = env.makeWindow()
    await tick()
    expect(env.real).toHaveLength(1)

    env.real[0].callbacks.onOpen?.()
    env.real[0].callbacks.onEvent('title_update', {})
    env.real[0].callbacks.onEvent('session_turn_completed', {})
    await tick()

    for (const w of [a, b, c]) {
      expect(w.log.opens).toBe(1)
      expect(w.log.received).toEqual(['title_update', 'session_turn_completed'])
    }
  })

  it('tells a window that starts after the stream opened', async () => {
    env.makeWindow()
    await tick()
    env.real[0].callbacks.onOpen?.()
    const late = env.makeWindow()
    await tick()
    expect(late.log.opens).toBe(1)
    expect(env.real).toHaveLength(1)
  })

  it('hands the stream to a waiting window when the leader closes', async () => {
    const leader = env.makeWindow()
    const follower = env.makeWindow()
    await tick()
    env.real[0].callbacks.onOpen?.()
    await tick()
    expect(follower.log.opens).toBe(1)

    leader.controller.abort()
    await tick()
    expect(env.real[0].signal?.aborted).toBe(true)
    expect(env.real).toHaveLength(2)

    env.real[1].callbacks.onOpen?.()
    env.real[1].callbacks.onEvent('config_changed', {})
    await tick()
    expect(follower.log.opens).toBe(2)
    expect(follower.log.received).toEqual(['config_changed'])
  })

  it('reports a dropped stream to the leader and lets a waiting window take over', async () => {
    const leader = env.makeWindow()
    const follower = env.makeWindow()
    await tick()
    env.real[0].callbacks.onOpen?.()
    env.real[0].callbacks.onError?.(new Error('boom'))
    await tick()

    expect(leader.log.errors).toBe(1)
    expect(follower.log.errors).toBe(0)
    expect(env.real).toHaveLength(2)
  })

  it('does not share between different backends', async () => {
    env.makeWindow('http://a/api')
    env.makeWindow('http://b/api')
    await tick()
    expect(env.real).toHaveLength(2)
  })

  it('stops a window that aborted while waiting for the lock from ever opening a stream', async () => {
    const leader = env.makeWindow()
    const waiting = env.makeWindow()
    await tick()
    waiting.controller.abort()
    leader.controller.abort()
    await tick()
    expect(env.real).toHaveLength(1)
  })
})
