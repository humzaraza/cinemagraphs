import Link from 'next/link'

export default function Footer() {
  return (
    <footer
      className="border-t"
      style={{ borderColor: 'rgba(240, 230, 211, 0.08)' }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between md:gap-6">
          <div className="flex items-center gap-4">
            <a
              href="https://x.com/cinemagraphsco"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Twitter"
              className="text-cinema-cream/60 hover:text-cinema-gold transition-colors duration-150"
            >
              <svg
                role="img"
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M14.726 2.5h2.69l-5.875 6.714L18.5 17.5h-5.41l-4.236-5.537L3.9 17.5H1.208l6.285-7.184L1 2.5h5.547l3.828 5.061L14.726 2.5Zm-.944 13.388h1.49L5.29 4.034H3.69l10.092 11.854Z" />
              </svg>
            </a>
            <a
              href="https://www.instagram.com/cinemagraphsco/"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Instagram"
              className="text-cinema-cream/60 hover:text-cinema-gold transition-colors duration-150"
            >
              <svg
                role="img"
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="4" />
                <circle cx="10" cy="10" r="3.5" />
                <circle cx="14.5" cy="5.5" r="0.85" fill="currentColor" stroke="none" />
              </svg>
            </a>
          </div>

          <nav aria-label="Footer">
            <h2 className="font-[family-name:var(--font-dm-sans)] text-xs font-semibold uppercase tracking-widest text-cinema-cream/60 mb-3">
              Resources
            </h2>
            <ul className="space-y-2">
              <li>
                <Link
                  href="/privacy"
                  className="font-[family-name:var(--font-dm-sans)] text-sm text-cinema-cream/70 hover:text-cinema-gold transition-colors"
                >
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link
                  href="/terms"
                  className="font-[family-name:var(--font-dm-sans)] text-sm text-cinema-cream/70 hover:text-cinema-gold transition-colors"
                >
                  Terms of Service
                </Link>
              </li>
              <li>
                <a
                  href="mailto:cinemagraphscorp@gmail.com"
                  className="font-[family-name:var(--font-dm-sans)] text-sm text-cinema-cream/70 hover:text-cinema-gold transition-colors"
                >
                  Contact
                </a>
              </li>
            </ul>
          </nav>

          <div className="flex flex-col items-start md:items-end leading-tight">
            <span className="font-[family-name:var(--font-playfair)] text-base font-semibold text-cinema-cream">
              Cinemagraphs
            </span>
            <span
              className="font-[family-name:var(--font-dm-sans)] text-[11px] font-light mt-0.5"
              style={{ color: 'rgba(240, 230, 211, 0.4)' }}
            >
              movie reviews, visualized
            </span>
          </div>
        </div>

        <div
          className="mt-10 pt-6 border-t"
          style={{ borderColor: 'rgba(240, 230, 211, 0.05)' }}
        >
          <p className="font-[family-name:var(--font-dm-sans)] text-xs text-cinema-cream/40">
            © 2026 Cinemagraphs Corp
          </p>
        </div>
      </div>
    </footer>
  )
}
