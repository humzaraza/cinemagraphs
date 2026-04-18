import { formatDate } from '@/lib/utils'

export default function ComingSoonState({ releaseDate }: { releaseDate: Date }) {
  return (
    <div className="rounded-lg border border-cinema-border bg-cinema-darker/40 px-6 py-16 md:py-20 text-center">
      <h2 className="font-[family-name:var(--font-playfair)] text-2xl md:text-3xl font-bold text-cinema-gold mb-3">
        Coming {formatDate(releaseDate)}
      </h2>
      <p className="text-cinema-cream/80 max-w-lg mx-auto leading-relaxed">
        Sentiment analysis will appear once the film releases and early reviews come in.
      </p>
    </div>
  )
}
