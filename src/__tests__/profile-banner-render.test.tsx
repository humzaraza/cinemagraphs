import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  loggerChild: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}))

vi.mock('@/lib/logger', () => ({
  apiLogger: mocks.apiLogger,
  logger: { child: mocks.loggerChild },
}))

import ProfileBanner from '@/components/ProfileBanner'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('ProfileBanner', () => {
  it('loading: renders an animated skeleton with no image', () => {
    const html = renderToStaticMarkup(
      <ProfileBanner loading={true} bannerType={null} bannerValue={null} bannerFilm={null} />
    )
    expect(html).toContain('animate-pulse')
    expect(html).not.toContain('<img')
  })

  it('GRADIENT with known preset: renders div with linear-gradient', () => {
    const html = renderToStaticMarkup(
      <ProfileBanner
        loading={false}
        bannerType="GRADIENT"
        bannerValue="ember"
        bannerFilm={null}
      />
    )
    expect(html).toContain('linear-gradient')
    expect(html).not.toContain('<img')
  })

  it('GRADIENT with unknown preset key: falls back to default gradient', () => {
    const html = renderToStaticMarkup(
      <ProfileBanner
        loading={false}
        bannerType="GRADIENT"
        bannerValue="aurora-borealis"
        bannerFilm={null}
      />
    )
    expect(html).toContain('linear-gradient')
    expect(html).not.toContain('<img')
  })

  it('BACKDROP with non-null backdropPath: renders <img> with the picked TMDB URL', () => {
    const html = renderToStaticMarkup(
      <ProfileBanner
        loading={false}
        bannerType="BACKDROP"
        bannerValue={JSON.stringify({ filmId: 'film_x', backdropPath: '/specific.jpg' })}
        bannerFilm={null}
      />
    )
    expect(html).toContain('https://image.tmdb.org/t/p/w1280/specific.jpg')
    expect(html).toContain('<img')
  })

  it('BACKDROP with null backdropPath and bannerFilm hydrated: renders <img> with film backdrop', () => {
    const html = renderToStaticMarkup(
      <ProfileBanner
        loading={false}
        bannerType="BACKDROP"
        bannerValue={JSON.stringify({ filmId: 'film_x', backdropPath: null })}
        bannerFilm={{ backdropUrl: '/film-default.jpg' }}
      />
    )
    expect(html).toContain('https://image.tmdb.org/t/p/w1280/film-default.jpg')
    expect(html).toContain('<img')
  })

  it('BACKDROP with null backdropPath and missing bannerFilm: falls back to gradient', () => {
    const html = renderToStaticMarkup(
      <ProfileBanner
        loading={false}
        bannerType="BACKDROP"
        bannerValue={JSON.stringify({ filmId: 'film_x', backdropPath: null })}
        bannerFilm={null}
      />
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('linear-gradient')
  })

  it('BACKDROP with malformed JSON: falls back to gradient', () => {
    const html = renderToStaticMarkup(
      <ProfileBanner
        loading={false}
        bannerType="BACKDROP"
        bannerValue="{not json}"
        bannerFilm={null}
      />
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('linear-gradient')
  })

  it('PHOTO with BLOB_PUBLIC_HOST set: renders <img> with the constructed CDN URL', () => {
    vi.stubEnv('BLOB_PUBLIC_HOST', 'cdn.example.com')
    const html = renderToStaticMarkup(
      <ProfileBanner
        loading={false}
        bannerType="PHOTO"
        bannerValue="banners/user_1/abc.jpg"
        bannerFilm={null}
      />
    )
    expect(html).toContain('https://cdn.example.com/banners/user_1/abc.jpg')
    expect(html).toContain('<img')
  })

  it('PHOTO with BLOB_PUBLIC_HOST unset: falls back to gradient', () => {
    vi.stubEnv('BLOB_PUBLIC_HOST', '')
    const html = renderToStaticMarkup(
      <ProfileBanner
        loading={false}
        bannerType="PHOTO"
        bannerValue="banners/user_1/abc.jpg"
        bannerFilm={null}
      />
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('linear-gradient')
  })

  it('unknown bannerType: falls back to gradient', () => {
    const html = renderToStaticMarkup(
      <ProfileBanner
        loading={false}
        bannerType="MOSAIC"
        bannerValue="anything"
        bannerFilm={null}
      />
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('linear-gradient')
  })

  it('null bannerType: falls back to gradient', () => {
    const html = renderToStaticMarkup(
      <ProfileBanner
        loading={false}
        bannerType={null}
        bannerValue={null}
        bannerFilm={null}
      />
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('linear-gradient')
  })
})
