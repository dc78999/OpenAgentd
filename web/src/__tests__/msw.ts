/**
 * `setupServer` for Bun tests, with the same `listen` / `use` /
 * `resetHandlers` / `close` surface as `msw/node`.
 *
 * msw 3's `msw/node` intercepts `fetch` at the socket layer, which Bun's
 * `node:net` does not expose, so its mocks never answer and requests hit the
 * real network (oven-sh/bun#44916). This builds the same network from msw's
 * own parts with the fetch-level interceptor instead. Go back to
 * `msw/node` once that issue is fixed.
 */
import { FetchInterceptor } from '@mswjs/interceptors/fetch/web'
import type { RequestHandler } from 'msw'
import { defineNetwork, InterceptorSource } from 'msw/experimental'

type SourceInterceptor = ConstructorParameters<typeof InterceptorSource>[0]['interceptors'][number]

export function setupServer(...handlers: RequestHandler[]) {
  // `fetch/web` is typed from the package's browser build and msw's
  // `Interceptor` from its Node build, so TypeScript sees two classes. At
  // runtime they are the same one.
  const fetchInterceptor = new FetchInterceptor() as unknown as SourceInterceptor
  const network = defineNetwork({
    sources: [new InterceptorSource({ interceptors: [fetchInterceptor] })],
    handlers,
    context: { quiet: true },
  })
  return {
    listen(options: { onUnhandledFrame?: 'bypass' | 'warn' | 'error' } = {}) {
      network.configure({ onUnhandledFrame: options.onUnhandledFrame ?? 'warn' })
      void network.enable()
    },
    use: network.use.bind(network),
    resetHandlers: network.resetHandlers.bind(network),
    close() {
      void network.disable()
    },
  }
}
