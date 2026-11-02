import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ar } from '../../i18n/ar'

const contact = vi.hoisted(() => ({ email: 'dev@example.com', whatsapp: '' }))

vi.mock('../../lib/about', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/about')>()),
  CONTACT: contact,
}))

import DeveloperPage from './Developer'

const renderPage = () =>
  render(
    <MemoryRouter>
      <DeveloperPage />
    </MemoryRouter>,
  )

afterEach(() => {
  cleanup()
  contact.whatsapp = ''
})

describe('developer page', () => {
  it('names the developer in Arabic and English and says all rights are reserved', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: 'ضياء عرار' })).toBeTruthy()
    expect(screen.getByText('Diaa Arar')).toBeTruthy()
    expect(screen.getByText(new RegExp(ar.settings.rights))).toBeTruthy()
    expect(screen.getByText(ar.developer.rightsText)).toBeTruthy()
  })

  it('the email is a mailto link', () => {
    renderPage()
    const link = screen.getByRole('link', { name: new RegExp(ar.developer.email) })
    expect(link.getAttribute('href')).toBe('mailto:dev@example.com')
  })

  it('a WhatsApp number that is not set yet is not shown, not invented', () => {
    renderPage()
    expect(screen.queryByRole('link', { name: new RegExp(ar.developer.whatsapp) })).toBeNull()
  })

  it('a WhatsApp number opens the chat, whatever way it was typed', () => {
    contact.whatsapp = '+972 59-123 4567'
    renderPage()
    const link = screen.getByRole('link', { name: new RegExp(ar.developer.whatsapp) })
    expect(link.getAttribute('href')).toBe('https://wa.me/972591234567')
    expect(link.textContent).toContain('+972591234567')
  })

  it('goes back to Settings', () => {
    renderPage()
    expect(
      screen.getByRole('link', { name: new RegExp(ar.developer.back) }).getAttribute('href'),
    ).toBe('/settings')
  })
})
