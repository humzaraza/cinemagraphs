/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import SimilarFilmsSection from '@/components/SimilarFilmsSection'
import type { SimilarFilmCardProps } from '@/components/SimilarFilmCard'

function makeFilm(over: Partial<SimilarFilmCardProps> & { id: string }): SimilarFilmCardProps {
  // Use undefined-checks (not ??) so explicit `null` overrides survive — they
  // are meaningful to the card component (hide year/score) and the tests rely
  // on that distinction.
  return {
    id: over.id,
    title: over.title ?? `Title ${over.id}`,
    year: over.year !== undefined ? over.year : 2010,
    posterUrl: over.posterUrl !== undefined ? over.posterUrl : '/p.jpg',
    score: over.score !== undefined ? over.score : 8.1,
    userHasReviewed: over.userHasReviewed ?? false,
  }
}

describe('<SimilarFilmsSection>', () => {
  it('renders 8 cards when given an 8-item array', () => {
    const films = Array.from({ length: 8 }, (_, i) => makeFilm({ id: `f${i + 1}` }))
    render(<SimilarFilmsSection films={films} />)
    expect(
      screen.getByRole('heading', { level: 2, name: /similar films/i }),
    ).toBeInTheDocument()
    // Each card is an outer <a> link to /films/<id>; one link per card.
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(8)
  })

  it('renders nothing when the films array is empty', () => {
    const { container } = render(<SimilarFilmsSection films={[]} />)
    expect(container.firstChild).toBeNull()
    expect(
      screen.queryByRole('heading', { level: 2, name: /similar films/i }),
    ).not.toBeInTheDocument()
  })

  it('shows the Reviewed badge only on cards where userHasReviewed is true', () => {
    const films: SimilarFilmCardProps[] = [
      makeFilm({ id: 'reviewed-1', title: 'Reviewed One', userHasReviewed: true }),
      makeFilm({ id: 'unreviewed-1', title: 'Unreviewed One', userHasReviewed: false }),
      makeFilm({ id: 'reviewed-2', title: 'Reviewed Two', userHasReviewed: true }),
    ]
    render(<SimilarFilmsSection films={films} />)
    const badges = screen.getAllByTestId('reviewed-badge')
    expect(badges).toHaveLength(2)

    // Walk up from each badge to its enclosing link and confirm the badged
    // links are the two reviewed ones.
    const badgedHrefs = badges.map((badge) => badge.closest('a')?.getAttribute('href')).sort()
    expect(badgedHrefs).toEqual(['/films/reviewed-1', '/films/reviewed-2'])
  })

  it('links each card to /films/${id}', () => {
    const films = [
      makeFilm({ id: 'abc123' }),
      makeFilm({ id: 'xyz789' }),
    ]
    render(<SimilarFilmsSection films={films} />)
    const links = screen.getAllByRole('link')
    expect(links.map((l) => l.getAttribute('href')).sort()).toEqual([
      '/films/abc123',
      '/films/xyz789',
    ])
  })

  it('renders year and score in the metadata row when present', () => {
    render(<SimilarFilmsSection films={[makeFilm({ id: 'f1', year: 1994, score: 9.2 })]} />)
    const card = screen.getByRole('link')
    expect(within(card).getByText('1994')).toBeInTheDocument()
    expect(within(card).getByText('9.2')).toBeInTheDocument()
  })

  it('hides year when null and score when null', () => {
    render(
      <SimilarFilmsSection films={[makeFilm({ id: 'f1', year: null, score: null })]} />,
    )
    const card = screen.getByRole('link')
    // No year text, no score text. Title still present.
    expect(within(card).queryByText(/^\d{4}$/)).not.toBeInTheDocument()
    expect(within(card).queryByText(/^\d+\.\d$/)).not.toBeInTheDocument()
    expect(within(card).getByRole('heading', { level: 3 })).toBeInTheDocument()
  })
})
