import { Libre_Baskerville } from 'next/font/google'

const libreBaskerville = Libre_Baskerville({
  variable: '--font-libre',
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
})

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <div className={libreBaskerville.variable}>{children}</div>
}
