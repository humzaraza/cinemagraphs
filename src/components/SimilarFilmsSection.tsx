import SimilarFilmCard, { type SimilarFilmCardProps } from './SimilarFilmCard'

interface SimilarFilmsSectionProps {
  films: SimilarFilmCardProps[]
}

export default function SimilarFilmsSection({ films }: SimilarFilmsSectionProps) {
  if (films.length === 0) return null

  return (
    <section id="similar-films" className="mt-10">
      <h2 className="font-[family-name:var(--font-playfair)] text-xl font-bold mb-4">
        Similar films
      </h2>
      <div
        // Mobile: horizontal scroll with snap, edge-to-edge bleed.
        // sm+: switch to a responsive grid (3 cols, 4 at md). No horizontal scroll.
        className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-3 -mx-4 px-4 sm:grid sm:grid-cols-3 sm:gap-4 sm:overflow-visible sm:mx-0 sm:px-0 md:grid-cols-4"
      >
        {films.map((film) => (
          <SimilarFilmCard key={film.id} {...film} />
        ))}
      </div>
    </section>
  )
}
