/**
 * Web mirror of the mobile onboarding curation set
 * (`cinemagraphs-mobile/src/data/onboardingCuration.ts`).
 *
 * Mobile is the source of truth for block IDs, labels, and the film picks.
 * This file adds two web-only fields that the mobile build does not need:
 *   - era blocks: `yearRange` for SQL filtering and adjacent-decade fallback.
 *   - genre blocks: `genreTag`, the TMDB-canonical name we actually store
 *     in `Film.genres` (mobile's display label "Sci-fi" maps to "Science
 *     Fiction" here).
 *
 * Mobile's `CuratedFilm` is `{ title, year, posterPath }` with no tmdbId.
 * `posterPath` is the de-facto unique identifier (the mobile test asserts
 * "57 unique posterPaths"). The Screen 3 endpoint excludes these from its
 * candidates by string-matching `posterPath` against `Film.posterUrl`,
 * which stores the same TMDB-style path.
 */
export type CuratedFilm = {
  title: string
  year: number
  posterPath: string
}

export type BlockKind = 'era' | 'genre'

export type EraBlock = {
  id: string
  kind: 'era'
  label: string
  yearRange: [number, number]
  films: readonly CuratedFilm[]
}

export type GenreBlock = {
  id: string
  kind: 'genre'
  label: string
  genreTag: string
  films: readonly CuratedFilm[]
}

export type OnboardingBlock = EraBlock | GenreBlock

export const ERA_BLOCKS: readonly EraBlock[] = [
  {
    id: 'era_1920s_30s',
    kind: 'era',
    label: '1920s-30s',
    yearRange: [1920, 1939],
    films: [
      { title: 'The Wizard of Oz', year: 1939, posterPath: '/uCC3j4pV9eOZwzDUWp2ilbcTf1f.jpg' },
      { title: 'Modern Times', year: 1936, posterPath: '/7uoiKOEjxBBW0AgDGQWrlfGQ90w.jpg' },
      { title: 'Metropolis', year: 1927, posterPath: '/kr9wXRN23zLuWJIelahas1mtnYj.jpg' },
      { title: 'Nosferatu', year: 1922, posterPath: '/zv7J85D8CC9qYagAEhPM63CIG6j.jpg' },
    ],
  },
  {
    id: 'era_1940s_50s',
    kind: 'era',
    label: '1940s-50s',
    yearRange: [1940, 1959],
    films: [
      { title: '12 Angry Men', year: 1957, posterPath: '/2QXLVh32JKaWTjFJU3n8aIxRK9P.jpg' },
      { title: 'Rear Window', year: 1954, posterPath: '/ILVF0eJxHMddjxeQhswFtpMtqx.jpg' },
      { title: 'Vertigo', year: 1958, posterPath: '/15uOEfqBNTVtDUT7hGBVCka0rZz.jpg' },
      { title: 'Citizen Kane', year: 1941, posterPath: '/sav0jxhqiH0bPr2vZFU0Kjt2nZL.jpg' },
    ],
  },
  {
    id: 'era_1960s_70s',
    kind: 'era',
    label: '1960s-70s',
    yearRange: [1960, 1979],
    films: [
      { title: 'The Godfather', year: 1972, posterPath: '/3bhkrj58Vtu7enYsRolD1fZdja1.jpg' },
      { title: 'Star Wars', year: 1977, posterPath: '/6FfCtAuVAW8XJjZ7eWeLibRLWTw.jpg' },
      { title: 'Alien', year: 1979, posterPath: '/vfrQk5IPloGg1v9Rzbh2Eg3VGyM.jpg' },
      { title: 'The Godfather Part II', year: 1974, posterPath: '/hek3koDUyRQk7FIhPXsa6mT2Zc3.jpg' },
    ],
  },
  {
    id: 'era_1980s',
    kind: 'era',
    label: '1980s',
    yearRange: [1980, 1989],
    films: [
      { title: 'Back to the Future', year: 1985, posterPath: '/vN5B5WgYscRGcQpVhHl6p9DDTP0.jpg' },
      { title: 'The Shining', year: 1980, posterPath: '/uAR0AWqhQL1hQa69UDEbb2rE5Wx.jpg' },
      { title: 'The Empire Strikes Back', year: 1980, posterPath: '/nNAeTmF4CtdSgMDplXTDPOpYzsX.jpg' },
      { title: 'Return of the Jedi', year: 1983, posterPath: '/jQYlydvHm3kUix1f8prMucrplhm.jpg' },
    ],
  },
  {
    id: 'era_1990s',
    kind: 'era',
    label: '1990s',
    yearRange: [1990, 1999],
    films: [
      { title: 'Fight Club', year: 1999, posterPath: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg' },
      { title: 'The Shawshank Redemption', year: 1994, posterPath: '/9cqNxx0GxF0bflZmeSMuL5tnGzr.jpg' },
      { title: 'Pulp Fiction', year: 1994, posterPath: '/vQWk5YBFWF4bZaofAbv0tShwBvQ.jpg' },
      { title: 'Forrest Gump', year: 1994, posterPath: '/saHP97rTPS5eLmrLQEcANmKrsFl.jpg' },
    ],
  },
  {
    id: 'era_2000s',
    kind: 'era',
    label: '2000s',
    yearRange: [2000, 2009],
    films: [
      { title: 'The Dark Knight', year: 2008, posterPath: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg' },
      { title: 'Avatar', year: 2009, posterPath: '/gKY6q7SjCkAU6FqvqWybDYgUKIF.jpg' },
      { title: "Harry Potter and the Philosopher's Stone", year: 2001, posterPath: '/wuMc08IPKEatf9rnMNXvIDxqP4W.jpg' },
      { title: 'Iron Man', year: 2008, posterPath: '/78lPtwv72eTNqFW9COBYI0dWDJa.jpg' },
    ],
  },
  {
    id: 'era_2010s',
    kind: 'era',
    label: '2010s',
    yearRange: [2010, 2019],
    films: [
      { title: 'Interstellar', year: 2014, posterPath: '/yQvGrMoipbRoddT0ZR8tPoR7NfX.jpg' },
      { title: 'Inception', year: 2010, posterPath: '/xlaY2zyzMfkhk0HSC5VUwzoZPU1.jpg' },
      { title: 'The Avengers', year: 2012, posterPath: '/RYMX2wcKCBAr24UyPD7xwmjaTn.jpg' },
      { title: 'Deadpool', year: 2016, posterPath: '/3E53WEZJqP6aM84D8CckXx4pIHw.jpg' },
    ],
  },
  {
    id: 'era_2020s',
    kind: 'era',
    label: '2020s',
    yearRange: [2020, 2029],
    films: [
      { title: 'Spider-Man: No Way Home', year: 2021, posterPath: '/1g0dhYtq4irTY1GPXvft6k4YLjm.jpg' },
      { title: 'Dune', year: 2021, posterPath: '/gDzOcq0pfeCeqMBwKIJlSmQpjkZ.jpg' },
      { title: 'Avatar: The Way of Water', year: 2022, posterPath: '/t6HIqrRAclMCA60NsSmeqe9RmNV.jpg' },
      { title: 'The Batman', year: 2022, posterPath: '/74xTEgt7R36Fpooo50r9T25onhq.jpg' },
    ],
  },
]

export const GENRE_BLOCKS: readonly GenreBlock[] = [
  {
    id: 'genre_drama',
    kind: 'genre',
    label: 'Drama',
    genreTag: 'Drama',
    films: [
      { title: 'Fight Club', year: 1999, posterPath: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg' },
      { title: 'The Shawshank Redemption', year: 1994, posterPath: '/9cqNxx0GxF0bflZmeSMuL5tnGzr.jpg' },
      { title: 'Django Unchained', year: 2012, posterPath: '/7oWY8VDWW7thTzWh3OKYRkWUlD5.jpg' },
      { title: 'Titanic', year: 1997, posterPath: '/9xjZS2rlVxm8SFx8kPC3aIGCOYQ.jpg' },
    ],
  },
  {
    id: 'genre_horror',
    kind: 'genre',
    label: 'Horror',
    genreTag: 'Horror',
    films: [
      { title: 'It', year: 2017, posterPath: '/9E2y5Q7WlCVNEhP5GiVTjhEhx1o.jpg' },
      { title: 'The Shining', year: 1980, posterPath: '/uAR0AWqhQL1hQa69UDEbb2rE5Wx.jpg' },
      { title: 'Split', year: 2017, posterPath: '/lli31lYTFpvxVBeFHWoe5PMfW5s.jpg' },
      { title: 'Alien', year: 1979, posterPath: '/vfrQk5IPloGg1v9Rzbh2Eg3VGyM.jpg' },
    ],
  },
  {
    id: 'genre_comedy',
    kind: 'genre',
    label: 'Comedy',
    genreTag: 'Comedy',
    films: [
      { title: 'Forrest Gump', year: 1994, posterPath: '/saHP97rTPS5eLmrLQEcANmKrsFl.jpg' },
      { title: 'The Truman Show', year: 1998, posterPath: '/vuza0WqY239yBXOadKlGwJsZJFE.jpg' },
      { title: 'The Hangover', year: 2009, posterPath: '/A0uS9rHR56FeBtpjVki16M5xxSW.jpg' },
      { title: 'La La Land', year: 2016, posterPath: '/uDO8zWDhfWwoFdKS4fzkUJt0Rf0.jpg' },
    ],
  },
  {
    id: 'genre_scifi',
    kind: 'genre',
    label: 'Sci-fi',
    genreTag: 'Science Fiction',
    films: [
      { title: 'Inception', year: 2010, posterPath: '/xlaY2zyzMfkhk0HSC5VUwzoZPU1.jpg' },
      { title: 'The Avengers', year: 2012, posterPath: '/RYMX2wcKCBAr24UyPD7xwmjaTn.jpg' },
      { title: 'The Matrix', year: 1999, posterPath: '/p96dm7sCMn4VYAStA6siNz30G1r.jpg' },
      { title: 'The Martian', year: 2015, posterPath: '/fASz8A0yFE3QB6LgGoOfwvFSseV.jpg' },
    ],
  },
  {
    id: 'genre_thriller',
    kind: 'genre',
    label: 'Thriller',
    genreTag: 'Thriller',
    films: [
      { title: 'Pulp Fiction', year: 1994, posterPath: '/vQWk5YBFWF4bZaofAbv0tShwBvQ.jpg' },
      { title: 'Parasite', year: 2019, posterPath: '/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg' },
      { title: 'Rise of the Planet of the Apes', year: 2011, posterPath: '/oqA45qMyyo1TtrnVEBKxqmTPhbN.jpg' },
      { title: "Ocean's Eleven", year: 2001, posterPath: '/hQQCdZrsHtZyR6NbKH2YyCqd2fR.jpg' },
    ],
  },
  {
    id: 'genre_romance',
    kind: 'genre',
    label: 'Romance',
    genreTag: 'Romance',
    films: [
      { title: 'Call Me by Your Name', year: 2017, posterPath: '/mZ4gBdfkhP9tvLH1DO4m4HYtiyi.jpg' },
      { title: 'The Notebook', year: 2004, posterPath: '/rNzQyW4f8B8cQeg7Dgj3n6eT5k9.jpg' },
      { title: 'Beauty and the Beast', year: 1991, posterPath: '/hUJ0UvQ5tgE2Z9WpfuduVSdiCiU.jpg' },
      { title: 'Grease', year: 1978, posterPath: '/2rM7fQKpb7cs1Iq7IBqub9LFDzJ.jpg' },
    ],
  },
  {
    id: 'genre_action',
    kind: 'genre',
    label: 'Action',
    genreTag: 'Action',
    films: [
      { title: 'The Dark Knight', year: 2008, posterPath: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg' },
      { title: 'Avatar', year: 2009, posterPath: '/gKY6q7SjCkAU6FqvqWybDYgUKIF.jpg' },
      { title: 'Deadpool', year: 2016, posterPath: '/3E53WEZJqP6aM84D8CckXx4pIHw.jpg' },
      { title: 'Avengers: Infinity War', year: 2018, posterPath: '/7WsyChQLEftFiDOVTGkv3hFpyyt.jpg' },
    ],
  },
  {
    id: 'genre_animation',
    kind: 'genre',
    label: 'Animation',
    genreTag: 'Animation',
    films: [
      { title: 'Inside Out', year: 2015, posterPath: '/2H1TmgdfNtsKlU9jKdeNyYL5y8T.jpg' },
      { title: 'Up', year: 2009, posterPath: '/mFvoEwSfLqbcWwFsDjQebn9bzFe.jpg' },
      { title: 'Finding Nemo', year: 2003, posterPath: '/eHuGQ10FUzK1mdOY69wF5pGgEf5.jpg' },
      { title: 'WALL-E', year: 2008, posterPath: '/hbhFnRzzg6ZDmm8YAmxBnQpQIPh.jpg' },
    ],
  },
  {
    id: 'genre_crime',
    kind: 'genre',
    label: 'Crime',
    genreTag: 'Crime',
    films: [
      { title: 'Joker', year: 2019, posterPath: '/udDclJoHjfjb8Ekgsd4FDteOkCU.jpg' },
      { title: 'Se7en', year: 1995, posterPath: '/191nKfP0ehp3uIvWqgPbFmI4lv9.jpg' },
      { title: 'The Silence of the Lambs', year: 1991, posterPath: '/uS9m8OBk1A8eM9I042bx8XXpqAq.jpg' },
      { title: 'Kingsman: The Secret Service', year: 2015, posterPath: '/r6q9wZK5a2K51KFj4LWVID6Ja1r.jpg' },
    ],
  },
]

export const ALL_BLOCKS: readonly OnboardingBlock[] = [...ERA_BLOCKS, ...GENRE_BLOCKS]

/**
 * Deduped list of all 57 curation poster paths. Endpoints that query
 * the broader catalog (Screen 3 candidates, banner cascade intersection
 * step) exclude these so the user gets actual catalog discovery rather
 * than the same curated films they already saw on the mosaic screens.
 */
export const EXCLUSION_POSTER_PATHS: readonly string[] = Array.from(
  new Set(ALL_BLOCKS.flatMap((b) => b.films.map((f) => f.posterPath)))
)
