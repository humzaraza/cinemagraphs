import Link from 'next/link'
import type { Metadata } from 'next'
import FeedbackCTA from './FeedbackCTA'

export const metadata: Metadata = {
  title: 'About — Cinemagraphs',
  description: 'Movie reviews, visualized. Learn how Cinemagraphs sentiment graphs are built.',
}

/* ── Inline SVG mock graphs ── */

function GoldLineGraph() {
  return (
    <svg viewBox="0 0 280 80" className="w-full h-auto" aria-hidden="true">
      <defs>
        <linearGradient id="aboutGoldFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#C8A951" stopOpacity={0.25} />
          <stop offset="100%" stopColor="#C8A951" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d="M0,60 Q30,55 60,42 T120,30 T180,22 T240,35 T280,28" fill="none" stroke="#C8A951" strokeWidth="2.5" />
      <path d="M0,60 Q30,55 60,42 T120,30 T180,22 T240,35 T280,28 V80 H0 Z" fill="url(#aboutGoldFill)" />
      {/* grid lines */}
      <line x1="0" y1="20" x2="280" y2="20" stroke="#2a2a3e" strokeWidth="0.5" />
      <line x1="0" y1="40" x2="280" y2="40" stroke="#2a2a3e" strokeWidth="0.5" />
      <line x1="0" y1="60" x2="280" y2="60" stroke="#2a2a3e" strokeWidth="0.5" />
    </svg>
  )
}

function TealDashedGraph() {
  return (
    <svg viewBox="0 0 280 80" className="w-full h-auto" aria-hidden="true">
      <line x1="0" y1="20" x2="280" y2="20" stroke="#2a2a3e" strokeWidth="0.5" />
      <line x1="0" y1="40" x2="280" y2="40" stroke="#2a2a3e" strokeWidth="0.5" />
      <line x1="0" y1="60" x2="280" y2="60" stroke="#2a2a3e" strokeWidth="0.5" />
      <path d="M0,50 Q40,45 80,35 T160,28 T240,32 T280,24" fill="none" stroke="#2DD4A8" strokeWidth="2" strokeDasharray="6 4" />
    </svg>
  )
}


/* ── FAQ data ── */

const faqs = [
  {
    q: 'Where does the external data come from?',
    a: 'We aggregate reviews from TMDB, IMDb, The Guardian, and critic blogs. Scores are anchored against IMDb, Rotten Tomatoes, and Metacritic ratings to stay grounded.',
  },
  {
    q: 'When does the teal community line appear?',
    a: 'The teal line shows up once enough Cinemagraphs users have submitted manual reviews for a film. It takes at least 5 user reviews before the community data is blended in.',
  },
  {
    q: 'Why is a scene I loved rated low?',
    a: "Scores reflect how audiences felt during a scene, not whether the scene is well-made. A heartbreaking scene in a great drama often scores low because what you're feeling is grief or dread, even though the scene itself is masterful. This is why great films often have the biggest peaks right after the biggest dips. The emotional contrast is the point. A low score on a powerful scene usually means the scene did its job of making you feel something difficult.",
  },
  {
    q: 'Can I contribute my own review?',
    a: 'Yes! Sign in and visit any film page. You can leave a written review with story beat ratings to contribute to the community sentiment line.',
  },
  {
    q: 'How often is data updated?',
    a: 'External reviews are refreshed automatically as new data is detected. Sentiment graphs for newly released films and films still gathering reviews are refreshed often. Older, well-established films are refreshed at least once a month so the data stays current.',
  },
  {
    q: 'I have feedback or found a bug. How do I get in touch?',
    a: 'USE_EMAIL_AND_TWITTER_LINKS',
  },
]

/* ── Page ── */

export default function AboutPage() {
  return (
    <div className="min-h-screen">
      {/* ── 1. Hero ── */}
      <section className="max-w-3xl mx-auto px-4 pt-16 pb-12 md:pt-24 md:pb-16 text-center">
        <h1 className="font-[family-name:var(--font-playfair)] text-4xl md:text-5xl lg:text-6xl font-bold text-cinema-cream mb-6">
          What is Cinemagraphs?
        </h1>
        <p className="text-base md:text-lg text-cinema-muted leading-relaxed max-w-2xl mx-auto mb-8">
          A traditional single score tells you very little about a film. Cinemagraphs shows you how audience sentiment moves through a film from start to finish, so you understand not just what people thought, but when and why.
        </p>
        <div className="w-16 h-px bg-cinema-gold/40 mx-auto mb-4" />
        <p className="text-sm text-cinema-gold italic">Every film has an emotional arc. We visualize it.</p>
      </section>

      {/* ── 2. Founder story ── */}
      <section className="max-w-3xl mx-auto px-4 pb-16 md:pb-20">
        <div className="rounded-xl border border-cinema-gold/20 bg-cinema-gold/[0.03] p-6 md:p-10">
          <h2 className="font-[family-name:var(--font-playfair)] text-2xl md:text-3xl font-bold text-cinema-gold mb-6">
            Why I built this
          </h2>
          <div className="space-y-4 text-sm md:text-base text-cinema-muted leading-relaxed">
            <p>
              This website has been a passion project of mine for a long time. I am someone who is a visual learner, and whenever I would try to figure out what movie I wanted to watch, what was available was never quite enough. Traditional single score reviews never did a movie justice for me, and do not even get me started on the site named after a fruit (to some, a vegetable) that gives you a percentage that somehow makes even less sense. You could read full reviews, but I never had the time for that either, and my ADHD removed any drive I had to sit through long write-ups.
            </p>
            <p>
              So I wanted to create something that would let you see the rating of a movie, understand how that rating was reached, and get a sense of how the film plays from start to finish, all from a quick glance.
            </p>
            <p>
              I know it is a bit of an unconventional idea, and not everyone will get it right away. But I am sure there are at least a few people out there like me who never felt satisfied by a single number, who are visual learners, and who want more context before committing two hours to a film. If even one person enjoys this site as much as I enjoyed building it, I would consider this a success.
            </p>
            <p>
              I am the solo creator of Cinemagraphs, and I have always been a little shy about sharing my ideas. So there will be rough edges, the occasional bug, and features that could be better. I want this to be a community, and I genuinely welcome any feedback.
            </p>
          </div>
          <div className="mt-8 pt-6 border-t border-cinema-gold/10">
            <p className="text-xs text-cinema-muted">
              Built with care by <span className="text-cinema-cream">Humza</span>{' '}
              <span className="text-cinema-muted/40 mx-1">/</span>{' '}
              <a href="mailto:cinemagraphs.corp@gmail.com" className="text-cinema-gold hover:underline">
                cinemagraphs.corp@gmail.com
              </a>
            </p>
          </div>
        </div>
      </section>

      {/* ── 3. How graphs are built ── */}
      <section className="max-w-5xl mx-auto px-4 pb-16 md:pb-24">
        <div className="text-center mb-12 md:mb-16">
          <h2 className="font-[family-name:var(--font-playfair)] text-2xl md:text-3xl font-bold text-cinema-cream mb-4">
            How the graphs are built
          </h2>
          <p className="text-sm md:text-base text-cinema-muted max-w-xl mx-auto">
            Every Cinemagraphs sentiment graph is built from up to two sources of data.
          </p>
        </div>

        {/* Source 1 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 items-center mb-16 md:mb-20">
          <div>
            <span className="text-xs text-cinema-gold uppercase tracking-wider font-semibold">01</span>
            <h3 className="font-[family-name:var(--font-playfair)] text-xl md:text-2xl font-bold text-cinema-cream mt-2 mb-4">
              External critic and audience reviews
            </h3>
            <p className="text-sm text-cinema-muted leading-relaxed">
              The gold line on every graph represents sentiment derived from professional critics and audience reviews across multiple platforms. We analyze what reviewers praised or criticized at different points in the film and map that onto the timeline. This is the primary data source and appears on every film.
            </p>
          </div>
          <div className="bg-cinema-darker rounded-xl border border-cinema-border p-5">
            <div className="space-y-3 mb-4">
              <div className="rounded-lg bg-cinema-dark/60 border border-cinema-border/50 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-2 h-2 rounded-full bg-cinema-gold/60" />
                  <span className="text-[10px] text-cinema-muted uppercase tracking-wider">Review Source 1</span>
                </div>
                <p className="text-xs text-cinema-muted/70 line-clamp-2">&ldquo;The opening act is masterfully paced, building tension through character work before the stunning midpoint twist...&rdquo;</p>
              </div>
              <div className="rounded-lg bg-cinema-dark/60 border border-cinema-border/50 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-2 h-2 rounded-full bg-cinema-gold/60" />
                  <span className="text-[10px] text-cinema-muted uppercase tracking-wider">Review Source 2</span>
                </div>
                <p className="text-xs text-cinema-muted/70 line-clamp-2">&ldquo;While the third act loses some momentum, the emotional payoff in the final minutes makes it all worthwhile...&rdquo;</p>
              </div>
            </div>
            <GoldLineGraph />
          </div>
        </div>

        {/* Source 2 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 items-center mb-16 md:mb-20">
          <div className="md:order-2">
            <span className="text-xs text-cinema-gold uppercase tracking-wider font-semibold">02</span>
            <h3 className="font-[family-name:var(--font-playfair)] text-xl md:text-2xl font-bold text-cinema-cream mt-2 mb-4">
              Manual reviews from Cinemagraphs users
            </h3>
            <p className="text-sm text-cinema-muted leading-relaxed">
              The teal dashed line represents ratings submitted by Cinemagraphs users. When you leave a review, you rate specific story beats across the film. These are aggregated and blended with external data to create a more complete picture of audience sentiment.
            </p>
          </div>
          <div className="bg-cinema-darker rounded-xl border border-cinema-border p-5 md:order-1">
            <div className="space-y-3 mb-4">
              {['Opening & Setup', 'Midpoint Tension', 'Final Act'].map((beat, i) => (
                <div key={beat} className="flex items-center gap-3">
                  <span className="text-[10px] text-cinema-muted w-24 shrink-0">{beat}</span>
                  <div className="flex-1 h-2 rounded-full bg-cinema-dark relative overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${[65, 80, 72][i]}%`,
                        backgroundColor: '#2DD4A8',
                        opacity: 0.6,
                      }}
                    />
                  </div>
                  <span className="text-xs text-cinema-muted w-6 text-right">{[6.5, 8.0, 7.2][i]}</span>
                </div>
              ))}
            </div>
            <TealDashedGraph />
          </div>
        </div>

      </section>

      {/* ── 3b. The Movie Market ── */}
      <section className="max-w-5xl mx-auto px-4 pb-16 md:pb-24">
        <div className="text-center mb-12 md:mb-16">
          <h2 className="font-[family-name:var(--font-playfair)] text-2xl md:text-3xl font-bold text-cinema-cream mb-4">
            The Movie Market
          </h2>
        </div>

        <div className="max-w-3xl mx-auto space-y-4 text-sm md:text-base text-cinema-muted leading-relaxed mb-12">
          <p>
            At the top of the homepage you will find the Movie Market, a live ticker showing films currently playing in theaters. Each film displays its Cinemagraphs Score, a mini sentiment sparkline, and a daily score change indicator so you can see which films are gaining momentum and which are losing it.
          </p>
          <p>
            Think of it as a stock market ticker, but for audience sentiment. Check back daily to see how scores shift as more people watch and react.
          </p>
        </div>

        {/* Ticker mockup */}
        <div className="rounded-xl border border-cinema-border bg-cinema-darker p-4 md:p-6 mb-12 overflow-x-auto">
          <div className="flex gap-4 md:gap-6 min-w-[640px]">
            {/* Film 1: Project Hail Mary — upward, green */}
            <div className="flex-1 rounded-lg bg-cinema-dark/60 border border-cinema-border/50 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs md:text-sm font-semibold text-cinema-cream truncate mr-2">Project Hail Mary</span>
                <span className="font-[family-name:var(--font-bebas)] text-lg" style={{ color: '#4ade80' }}>8.4</span>
              </div>
              <svg viewBox="0 0 120 32" className="w-full h-8 mb-2" aria-hidden="true">
                <path d="M0,28 L15,26 L30,24 L45,22 L60,18 L75,14 L90,10 L105,8 L120,4" fill="none" stroke="#4ade80" strokeWidth="1.5" />
                <path d="M0,28 L15,26 L30,24 L45,22 L60,18 L75,14 L90,10 L105,8 L120,4 V32 H0 Z" fill="#4ade80" fillOpacity="0.08" />
              </svg>
              <span className="text-xs font-semibold" style={{ color: '#4ade80' }}>&#9650; +0.2</span>
            </div>

            {/* Film 2: Scream 7 — downward, red */}
            <div className="flex-1 rounded-lg bg-cinema-dark/60 border border-cinema-border/50 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs md:text-sm font-semibold text-cinema-cream truncate mr-2">Scream 7</span>
                <span className="font-[family-name:var(--font-bebas)] text-lg" style={{ color: '#ef4444' }}>5.1</span>
              </div>
              <svg viewBox="0 0 120 32" className="w-full h-8 mb-2" aria-hidden="true">
                <path d="M0,6 L15,8 L30,10 L45,14 L60,16 L75,20 L90,22 L105,26 L120,28" fill="none" stroke="#ef4444" strokeWidth="1.5" />
                <path d="M0,6 L15,8 L30,10 L45,14 L60,16 L75,20 L90,22 L105,26 L120,28 V32 H0 Z" fill="#ef4444" fillOpacity="0.08" />
              </svg>
              <span className="text-xs font-semibold" style={{ color: '#ef4444' }}>&#9660; -0.1</span>
            </div>

            {/* Film 3: Reminders of Him — flat, gold */}
            <div className="flex-1 rounded-lg bg-cinema-dark/60 border border-cinema-border/50 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs md:text-sm font-semibold text-cinema-cream truncate mr-2">Reminders of Him</span>
                <span className="font-[family-name:var(--font-bebas)] text-lg" style={{ color: '#C8A951' }}>7.3</span>
              </div>
              <svg viewBox="0 0 120 32" className="w-full h-8 mb-2" aria-hidden="true">
                <path d="M0,16 L15,17 L30,15 L45,16 L60,16 L75,15 L90,16 L105,15 L120,16" fill="none" stroke="#C8A951" strokeWidth="1.5" />
                <path d="M0,16 L15,17 L30,15 L45,16 L60,16 L75,15 L90,16 L105,15 L120,16 V32 H0 Z" fill="#C8A951" fillOpacity="0.08" />
              </svg>
              <span className="text-xs font-semibold" style={{ color: '#C8A951' }}>&mdash;</span>
            </div>
          </div>
        </div>

        {/* Feature cards — 2-column grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[
            {
              title: 'Only films in theaters',
              desc: 'The ticker shows only Canadian theater releases, updated weekly.',
            },
            {
              title: 'Daily score updates',
              desc: 'Green means the score went up, red means down, gold means no change.',
            },
            {
              title: 'Mini sentiment sparkline',
              desc: 'A small version of the sentiment curve visible at a glance.',
            },
            {
              title: 'Click to explore',
              desc: 'Click any film to go to its full graph and story beat breakdown.',
            },
          ].map((card) => (
            <div
              key={card.title}
              className="rounded-lg border border-cinema-border bg-cinema-darker px-5 py-4"
            >
              <h4 className="text-sm font-semibold text-cinema-cream mb-1">{card.title}</h4>
              <p className="text-xs text-cinema-muted leading-relaxed">{card.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── 4. How the Cinemagraphs Score works ── */}
      <section className="max-w-3xl mx-auto px-4 pb-16 md:pb-24">
        <h2 className="font-[family-name:var(--font-playfair)] text-2xl md:text-3xl font-bold text-cinema-cream mb-4 text-center">
          How the Cinemagraphs Score works
        </h2>
        <p className="text-sm md:text-base text-cinema-muted text-center max-w-xl mx-auto mb-10">
          The score you see on every film is a weighted blend of all available data, not a simple average of star ratings. It reflects how audiences felt across the full runtime.
        </p>
        <div className="space-y-3">
          {[
            { range: '9 - 10', color: '#2DD4A8', label: 'Exceptional', desc: 'Near-universal acclaim across the full runtime.' },
            { range: '7 - 8.9', color: '#C8A951', label: 'Great', desc: 'Strong positive sentiment with minor dips.' },
            { range: '5 - 6.9', color: 'rgba(255,255,255,0.5)', label: 'Mixed', desc: 'Significant highs and lows, or consistently average.' },
            { range: 'Below 5', color: '#ef4444', label: 'Poor', desc: 'Predominantly negative sentiment throughout.' },
          ].map((tier) => (
            <div
              key={tier.range}
              className="flex items-center gap-4 rounded-lg bg-cinema-darker border border-cinema-border px-4 py-3 md:px-6 md:py-4"
            >
              <span
                className="font-[family-name:var(--font-bebas)] text-2xl md:text-3xl w-20 md:w-24 shrink-0"
                style={{ color: tier.color }}
              >
                {tier.range}
              </span>
              <div>
                <span className="text-sm font-semibold text-cinema-cream">{tier.label}</span>
                <p className="text-xs text-cinema-muted mt-0.5">{tier.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── 5. FAQ ── */}
      <section className="max-w-3xl mx-auto px-4 pb-16 md:pb-24">
        <h2 className="font-[family-name:var(--font-playfair)] text-2xl md:text-3xl font-bold text-cinema-cream mb-10 text-center">
          Frequently asked questions
        </h2>
        <div className="space-y-6">
          {faqs.map((faq) => (
            <div key={faq.q} className="border-b border-cinema-border pb-6 last:border-0">
              <h3 className="text-sm md:text-base font-semibold text-cinema-cream mb-2">{faq.q}</h3>
              {faq.a === 'USE_EMAIL_AND_TWITTER_LINKS' ? (
                <p className="text-sm text-cinema-muted leading-relaxed">
                  We would love to hear from you! Use the feedback widget on any page, email us at{' '}
                  <a href="mailto:cinemagraphs.corp@gmail.com" className="text-cinema-gold hover:underline">
                    cinemagraphs.corp@gmail.com
                  </a>
                  , or reach out on X at{' '}
                  <a
                    href="https://x.com/cinemagraphsco"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-cinema-gold hover:underline"
                  >
                    @cinemagraphsco
                  </a>
                  .
                </p>
              ) : (
                <p className="text-sm text-cinema-muted leading-relaxed">{faq.a}</p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── 6. Data & Credits ── */}
      <section className="max-w-3xl mx-auto px-4 pb-16 md:pb-24">
        <h2 className="font-[family-name:var(--font-playfair)] text-2xl md:text-3xl font-bold text-cinema-cream mb-6">
          Data &amp; Credits
        </h2>
        <div className="bg-cinema-darker border border-cinema-border rounded-lg p-6 flex flex-col gap-6 md:flex-row md:items-center md:gap-8">
          <div className="flex-shrink-0 flex items-center justify-center md:justify-start">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/tmdb-logo.svg"
              alt="TMDB"
              className="h-10 w-auto opacity-90"
            />
          </div>
          <div className="flex-1">
            <p className="text-cinema-cream leading-relaxed">
              This website uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.
            </p>
            <p className="text-cinema-muted text-sm mt-3 leading-relaxed">
              Film metadata, posters, and backdrops are provided by The Movie Database. Anchor scores (IMDb, Rotten Tomatoes, Metacritic) are provided by{' '}
              <a
                href="https://www.omdbapi.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cinema-gold hover:underline"
              >
                OMDb API
              </a>
              . Sentiment graphs are generated by Cinemagraphs through independent NLP analysis of publicly available reviews.
            </p>
          </div>
        </div>
      </section>

      {/* ── 7. CTA ── */}
      <section className="max-w-3xl mx-auto px-4 pb-20 md:pb-28 text-center">
        <h2 className="font-[family-name:var(--font-playfair)] text-2xl md:text-3xl font-bold text-cinema-cream mb-6">
          Ready to see cinema differently?
        </h2>
        <div className="flex flex-wrap justify-center gap-4">
          <Link
            href="/films/browse"
            className="bg-cinema-gold text-cinema-dark font-semibold px-7 py-3 rounded-lg hover:bg-cinema-gold/90 transition-colors text-sm"
          >
            Browse Films
          </Link>
          <FeedbackCTA />
        </div>
      </section>
    </div>
  )
}
