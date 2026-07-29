import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import type { RouteObject } from 'react-router-dom'
import { routes } from './router'

const renderAt = (path: string, config: RouteObject[] = routes) =>
  render(<RouterProvider router={createMemoryRouter(config, { initialEntries: [path] })} />)

/**
 * An unmatched path used to reach React Router's built-in default boundary,
 * which is a developer's screen: "Unexpected Application Error", a note about
 * providing an errorElement, and a wave emoji. It is the same in the built
 * bundle as it is in development, so any mistyped address or dead share link
 * landed a coach on it.
 */
describe('an address that matches nothing', () => {
  it('renders the branded 404 rather than throwing', () => {
    renderAt('/anything-not-a-route')

    expect(screen.getByText('404')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('That page is not on the board.')
  })

  it('matches a deep path too, not only a single segment', () => {
    renderAt('/boards/does-not-exist/edit')
    expect(screen.getByText('404')).toBeInTheDocument()
  })

  it('offers a way home and a way to the board', () => {
    renderAt('/nope')

    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/')
    expect(hrefs).toContain('/board')
  })

  it('says none of the router default boundary developer copy', () => {
    const { container } = renderAt('/nope')
    const text = container.textContent ?? ''

    expect(text).not.toMatch(/Unexpected Application Error/i)
    expect(text).not.toMatch(/Hey developer/i)
    expect(text).not.toMatch(/errorElement/i)
  })

  it('carries no emoji and no em dashes', () => {
    const { container } = renderAt('/nope')
    const text = container.textContent ?? ''

    expect(text).not.toMatch(/—/)
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
  })
})

/**
 * The other half. A catch-all answers a path nobody matched; it cannot answer a
 * route that matched and then threw, which is what `errorElement` is for. This
 * hangs an extra child off the real root route, so what it exercises is the
 * boundary the app actually ships rather than a stand-in.
 */
describe('a route that throws', () => {
  afterEach(() => vi.restoreAllMocks())

  it('lands on the branded page rather than the router default boundary', () => {
    // React logs a caught render error; the assertion is what the user sees.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const Boom = () => {
      throw new Error('raw text meant for a developer')
    }
    // Named field by field rather than spread: RouteObject is a union and a
    // spread loses the discriminant, so `index` widens and stops type checking.
    const root = routes[0]
    const withThrower: RouteObject[] = [
      {
        element: root.element,
        errorElement: root.errorElement,
        children: [...(root.children ?? []), { path: '/kaboom', element: <Boom /> }],
      },
    ]

    const { container } = renderAt('/kaboom', withThrower)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('That page did not load.')
    expect(container.textContent).not.toMatch(/raw text meant for a developer/)
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toContain('/')
  })
})
