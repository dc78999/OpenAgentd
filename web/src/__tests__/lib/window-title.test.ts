import { beforeEach, describe, expect, it, mock } from 'bun:test'

let isTauri = true
const setBadgeCount = mock(async (..._args: unknown[]) => {})
const setTitle = mock(async (..._args: unknown[]) => {})
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => ({ isTauri, os: 'macos' }) }))
mock.module('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setBadgeCount, setTitle }) }))

const { buildDesktopWindowTitle, syncDesktopBadgeCount, syncDesktopWindowTitle } = await import('@/lib/window-title')

beforeEach(() => {
  isTauri = true
  setBadgeCount.mockClear()
  setTitle.mockClear()
})

describe('buildDesktopWindowTitle', () => {
  it('joins the workspace and session title', () => {
    expect(buildDesktopWindowTitle({ workspace: '/Users/name/Workspace A', sessionTitle: 'Fix updater restart' })).toBe('Workspace A - Fix updater restart')
  })

  it('falls back to the workspace basename for coding windows without a session title', () => {
    expect(buildDesktopWindowTitle({ workspace: '/Users/name/Workspace A' })).toBe('Workspace A')
  })

  it('uses only the session title when no workspace is attached', () => {
    expect(buildDesktopWindowTitle({ sessionTitle: 'Refactor auth flow' })).toBe('Refactor auth flow')
  })

  it('falls back to the app name when no title is available', () => {
    expect(buildDesktopWindowTitle({ sessionTitle: '   ' })).toBe('OpenAgentd')
  })

  it('prefers the chat label over the workspace basename', () => {
    expect(
      buildDesktopWindowTitle({ workspace: '/Users/name', workspaceName: 'Chat' }),
    ).toBe('Chat')
  })

  it('lets the session title win over the workspace label', () => {
    expect(
      buildDesktopWindowTitle({
        workspace: '/Users/name',
        workspaceName: 'Chat',
        sessionTitle: 'Trip planning',
      }),
    ).toBe('Chat - Trip planning')
  })

  it('does not repeat the workspace when the session title is the same', () => {
    expect(buildDesktopWindowTitle({ workspaceName: 'Chat', sessionTitle: 'Chat' })).toBe('Chat')
  })

  it('truncates a long session title but keeps the workspace', () => {
    const title = buildDesktopWindowTitle({ workspaceName: 'app', sessionTitle: 'x'.repeat(200) })
    expect(title.startsWith('app - xxx')).toBe(true)
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBe('app - '.length + 60)
  })

  it('counts sessions that need you in front of the title', () => {
    expect(buildDesktopWindowTitle({ workspaceName: 'app', sessionTitle: 'Fix updater restart', needsYou: 2 })).toBe('(2) app - Fix updater restart')
    expect(buildDesktopWindowTitle({ sessionTitle: 'Fix updater restart', needsYou: 0 })).toBe('Fix updater restart')
  })
})

describe('syncDesktopWindowTitle', () => {
  it('sets document.title and the native window title, skipping repeats', async () => {
    syncDesktopWindowTitle({ workspaceName: 'app', sessionTitle: 'First' })
    syncDesktopWindowTitle({ workspaceName: 'app', sessionTitle: 'First' })
    syncDesktopWindowTitle({ workspaceName: 'app', sessionTitle: 'Second' })
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))

    expect(document.title).toBe('app - Second')
    expect(setTitle.mock.calls).toEqual([['app - First'], ['app - Second']])
  })

  it('leaves the native title alone outside the desktop app', async () => {
    isTauri = false

    syncDesktopWindowTitle({ workspaceName: 'app', sessionTitle: 'Web only' })
    await new Promise((r) => setTimeout(r, 0))

    expect(document.title).toBe('app - Web only')
    expect(setTitle).not.toHaveBeenCalled()
  })
})

describe('syncDesktopBadgeCount', () => {
  it('badges the app icon with the count and clears it at zero', async () => {
    await syncDesktopBadgeCount(3)
    await syncDesktopBadgeCount(0)

    expect(setBadgeCount.mock.calls).toEqual([[3], [undefined]])
  })

  it('does nothing outside the desktop app', async () => {
    isTauri = false

    await syncDesktopBadgeCount(3)

    expect(setBadgeCount).not.toHaveBeenCalled()
  })
})
