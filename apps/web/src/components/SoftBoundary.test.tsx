import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SoftBoundary } from './SoftBoundary'

afterEach(cleanup)

const Broken = (): never => {
  throw new Error('the chunk did not load')
}

describe('SoftBoundary', () => {
  it('shows its content when nothing is wrong', () => {
    render(
      <SoftBoundary onError={() => undefined}>
        <p>الصورة</p>
      </SoftBoundary>,
    )
    expect(screen.getByText('الصورة')).toBeTruthy()
  })

  it('hides what fails and says so, and leaves what is around it alone', () => {
    const fail = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onError = vi.fn()
    render(
      <div>
        <p>الصفحة</p>
        <SoftBoundary onError={onError}>
          <Broken />
        </SoftBoundary>
      </div>,
    )
    expect(onError).toHaveBeenCalledTimes(1)
    expect(screen.getByText('الصفحة')).toBeTruthy()
    fail.mockRestore()
  })
})
