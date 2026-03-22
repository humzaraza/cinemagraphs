import type { Metadata } from "next";
import { Playfair_Display, DM_Sans, Bebas_Neue } from "next/font/google";
import "./globals.css";
import Navigation from "@/components/Navigation";
import SessionProvider from "@/components/SessionProvider";

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
    "See how audience opinion shifts across a film's runtime. Dynamic sentiment graphs for every movie.",
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
        </SessionProvider>
      </body>
    </html>
  );
}
