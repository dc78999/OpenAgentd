import { apiBaseUrl } from './base-url'
import { globalEventStream } from './global-events'
import type { GlobalEventCallbacks } from './global-events'
import { backgroundSuspendsSockets } from '@/hooks/use-platform'

/**
 * One global event stream for every window of the app.
 *
 * A webview opens at most 6 HTTP/1.1 connections per host, shared by all its
 * windows. Each window holds a global stream for its whole life and a session
 * stream while its turn runs or waits on a question, so three busy windows use
 * all six. Every later request (approve a plan, stop, load the session list,
 * git status) then queues behind them with no error and no timeout.
 *
 * The window holding the Web Lock for the backend opens the real stream and
 * relays what it reads over a BroadcastChannel; the others only listen. When
 * the leader closes or its stream drops, the lock passes to the next waiter,
 * whose `onOpen` makes every window resync what the gap missed.
 */

type Message = { kind: 'hello' } | { kind: 'open' } | { kind: 'event'; type: string; data: unknown }

export interface ChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: Message): void
  close(): void
}

export interface LockManagerLike {
  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>): Promise<unknown>
}

export interface SharedStreamDeps {
  locks: LockManagerLike
  makeChannel: (name: string) => ChannelLike
  openStream: (callbacks: GlobalEventCallbacks, signal?: AbortSignal) => void
  /** Identifies the backend; windows pointed at different backends never share. */
  key: string
}

const NAME_PREFIX = 'openagentd-global-events:'

export function createSharedGlobalEventStream(deps: SharedStreamDeps) {
  const name = `${NAME_PREFIX}${deps.key}`

  return function sharedStream(callbacks: GlobalEventCallbacks, signal?: AbortSignal): void {
    if (signal?.aborted) return
    const channel = deps.makeChannel(name)
    const stop = new AbortController()
    let leading = false
    let open = false
    const post = (message: Message) => {
      try {
        channel.postMessage(message)
      } catch {
        // A closed channel has no listeners left to tell.
      }
    }

    channel.onmessage = (event) => {
      const message = event.data as Message | null
      if (!message || typeof message !== 'object') return
      if (leading) {
        // A window that started after the stream opened asks to be told.
        if (message.kind === 'hello' && open) post({ kind: 'open' })
        return
      }
      if (message.kind === 'open') callbacks.onOpen?.()
      else if (message.kind === 'event') callbacks.onEvent(message.type, message.data)
    }

    signal?.addEventListener(
      'abort',
      () => {
        stop.abort()
        channel.close()
      },
      { once: true },
    )

    deps
      .locks.request(name, { signal }, () =>
        new Promise<void>((resolve) => {
          leading = true
          const release = () => {
            leading = false
            open = false
            resolve()
          }
          stop.signal.addEventListener('abort', release, { once: true })
          deps.openStream(
            {
              onOpen: () => {
                open = true
                post({ kind: 'open' })
                callbacks.onOpen?.()
              },
              onEvent: (type, data) => {
                post({ kind: 'event', type, data })
                callbacks.onEvent(type, data)
              },
              onParseError: callbacks.onParseError,
              onError: (error) => {
                release()
                callbacks.onError?.(error)
              },
              onDone: () => {
                release()
                callbacks.onDone?.()
              },
            },
            stop.signal,
          )
        }),
      )
      // Aborted while still waiting for the lock.
      .catch(() => undefined)

    post({ kind: 'hello' })
  }
}

/**
 * The global stream, shared across windows where the platform can. Falls back
 * to one stream per window without Web Locks / BroadcastChannel, and on mobile,
 * where there is a single window and the OS freezes background sockets.
 */
export function sharedGlobalEventStream(callbacks: GlobalEventCallbacks, signal?: AbortSignal): void {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks || typeof BroadcastChannel === 'undefined' || backgroundSuspendsSockets()) {
    globalEventStream(callbacks, signal)
    return
  }
  createSharedGlobalEventStream({
    locks,
    makeChannel: (name) => new BroadcastChannel(name) as unknown as ChannelLike,
    openStream: globalEventStream,
    key: apiBaseUrl(),
  })(callbacks, signal)
}
