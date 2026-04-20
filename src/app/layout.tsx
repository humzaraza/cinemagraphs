import type { Metadata } from "next";
import { Playfair_Display, DM_Sans, Bebas_Neue } from "next/font/google";
import "./globals.css";
import Navigation from "@/components/Navigation";
import SessionProvider from "@/components/SessionProvider";
import FeedbackWidget from "@/components/FeedbackWidget";
import Footer from "@/components/Footer";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  display: "swap",
});

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  display: "swap",
});

const bebas = Bebas_Neue({
  variable: "--font-bebas",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cinemagraphs — Visualize Movie Sentiment",
  description:
    "See how audience opinion moves through a film — not just the final verdict. Sentiment graphs for 371 films.",
  openGraph: {
    title: "Cinemagraphs — Visualize Movie Sentiment",
    description:
      "Movie reviews, visualized.",
    url: "https://cinemagraphs.ca",
    siteName: "Cinemagraphs",
    images: [
      {
        url: "https://cinemagraphs.ca/og-image.png",
        width: 1200,
        height: 630,
      },
    ],
    locale: "en_CA",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Cinemagraphs — Visualize Movie Sentiment",
    description:
      "Movie reviews, visualized.",
    images: ["https://cinemagraphs.ca/og-image.png"],
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${playfair.variable} ${dmSans.variable} ${bebas.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-cinema-dark text-cinema-cream">
        <SessionProvider>
          <Navigation />
          <main className="flex-1">{children}</main>
          <FeedbackWidget />
          <Footer />
          <Analytics />
          <SpeedInsights />
        </SessionProvider>
      </body>
    </html>
  );
}
