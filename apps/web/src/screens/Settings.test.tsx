import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import pkg from '../../package.json'
import { ar } from '../i18n/ar'
import { COPYRIGHT_YEAR, DEVELOPER } from '../lib/about'
import { useImages } from '../lib/sync/images'
import { PENDING_COMMANDS, resetAuthStore, useAuth } from '../store'
import { Login } from './Login'
import Settings from './Settings'

const renderSettings = () =>
  render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  )

const group = (title: string) => screen.getByRole('region', { name: title })

beforeEach(() => {
  resetAuthStore()
  useAuth.setState({
    status: 'unlocked',
    identity: { user: { id: 'u', name: 'أبو محمود' }, device: { id: 'd', name: 'آيباد المندوب' } },
  })
  useImages.setState({ cached: 0, total: 0, running: false })
  Object.defineProperty(navigator, 'storage', {
    value: { persisted: async () => true },
    configurable: true,
  })
})

afterEach(() => {
  cleanup()
})

describe('settings page', () => {
  it('has its groups, and each link goes where its name says', () => {
    renderSettings()
    const links: [string, string, string][] = [
      [ar.settings.groupShop, ar.settings.business, '/settings/business'],
      [ar.settings.groupShop, ar.settings.categories, '/settings/categories'],
      [ar.settings.groupShop, ar.settings.synonyms, '/settings/synonyms'],
      [ar.settings.groupShop, ar.settings.importProducts, '/settings/import'],
      [ar.settings.groupData, ar.settings.exportData, '/settings/export'],
      [ar.settings.groupData, ar.settings.sync, '/sync'],
    ]
    for (const [groupName, name, href] of links) {
      const link = within(group(groupName)).getByRole('link', { name: new RegExp(name) })
      expect(link.getAttribute('href'), name).toBe(href)
    }
    for (const title of [
      ar.settings.groupShop,
      ar.settings.groupData,
      ar.settings.groupSecurity,
      ar.settings.groupDevice,
      ar.settings.groupSignOut,
      ar.settings.about,
    ]) {
      expect(group(title)).toBeTruthy()
    }
  })

  it('every row is a thumb-size target and says in words what it is for', () => {
    renderSettings()
    const rows = [...screen.getAllByRole('link'), ...screen.getAllByRole('button')]
    expect(rows.length).toBeGreaterThanOrEqual(10)
    for (const row of rows) expect(row.className, row.textContent ?? '').toContain('min-h-16')
    expect(screen.getByText(ar.settings.synonymsHint)).toBeTruthy()
  })

  it('shows who is signed in, the device, and whether the storage is permanent', async () => {
    renderSettings()
    expect(screen.getByText('أبو محمود')).toBeTruthy()
    expect(within(group(ar.settings.groupDevice)).getByText('آيباد المندوب')).toBeTruthy()
    expect(await screen.findByText(new RegExp(ar.settings.storageOn))).toBeTruthy()
  })

  it('says it when the storage is not permanent, with a symbol and the words', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: async () => false },
      configurable: true,
    })
    renderSettings()
    const fact = await screen.findByText(
      (_, el) => el?.textContent === `✗ ${ar.settings.storageOff}`,
    )
    expect(fact).toBeTruthy()
  })

  it('shows how many product pictures are on the device as a progress bar', () => {
    useImages.setState({ cached: 30, total: 120, running: true })
    renderSettings()
    const bar = screen.getByRole('progressbar', { name: ar.settings.images })
    expect(bar.getAttribute('aria-valuenow')).toBe('25')
    expect(screen.getByText(/30 من 120/)).toBeTruthy()
    expect(screen.getByText(new RegExp(ar.settings.imagesRunning))).toBeTruthy()
    // while it downloads, starting it again is off
    expect(
      (screen.getByRole('button', { name: ar.settings.redownload }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('no pictures at all is 0%, not a division by zero', () => {
    renderSettings()
    expect(
      screen.getByRole('progressbar', { name: ar.settings.images }).getAttribute('aria-valuenow'),
    ).toBe('0')
  })

  it('"lock now" locks, and "change PIN" opens the PIN screen', () => {
    const lock = vi.fn()
    useAuth.setState({ lock })
    renderSettings()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ar.settings.lockNow) }))
    expect(lock).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ar.settings.changePin) }))
    expect(screen.getByText(ar.setPin.title)).toBeTruthy()
  })
})

describe('signing out', () => {
  it('sits in its own group, and the dangerous rows say so with a symbol and words', () => {
    renderSettings()
    const rows = within(group(ar.settings.groupSignOut)).getAllByRole('button')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining(ar.settings.logout),
      expect.stringContaining(ar.settings.logoutAll),
    ])
    for (const row of rows) expect(row.textContent).toContain('⚠')
  })

  it('with work still waiting to be sent, it refuses and says why', async () => {
    useAuth.setState({
      logout: async () => {
        throw new Error(PENDING_COMMANDS)
      },
    })
    renderSettings()
    fireEvent.click(within(group(ar.settings.groupSignOut)).getAllByRole('button')[0]!)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(ar.settings.logoutPending)
  })

  it('offline, it says that signing out needs the internet', async () => {
    useAuth.setState({
      logoutAll: async () => {
        throw new Error('network')
      },
    })
    renderSettings()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ar.settings.logoutAll) }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(ar.settings.logoutFailed),
    )
  })
})

describe('about and the developer', () => {
  it('names the developer, the version and the rights', () => {
    renderSettings()
    const about = group(ar.settings.about)
    expect(within(about).getByText(ar.settings.appName)).toBeTruthy()
    expect(about.textContent).toContain(DEVELOPER.ar)
    expect(about.textContent).toContain(DEVELOPER.en)
    expect(about.textContent).toContain(`© ${COPYRIGHT_YEAR} ${DEVELOPER.ar}`)
    expect(about.textContent).toContain(ar.settings.rights)
    expect(about.textContent).toContain(`${ar.settings.version} ${pkg.version}`)
  })

  it('the developer is Diaa Arar, and the year is the year of the first version', () => {
    expect(DEVELOPER).toEqual({ ar: 'ضياء عرار', en: 'Diaa Arar' })
    expect(COPYRIGHT_YEAR).toBe(2026)
  })

  it('is also on the sign-in page', () => {
    resetAuthStore()
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    )
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && el.textContent === `© ${COPYRIGHT_YEAR} ${DEVELOPER.ar}`,
      ),
    ).toBeTruthy()
  })
})
