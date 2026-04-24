import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  StillsPickerView,
  type StillsPickerViewProps,
  type Backdrop,
} from '@/components/admin/carousel/StillsPicker'

function makeBackdrops(n: number): Backdrop[] {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://image.tmdb.org/t/p/original/b${i}.jpg`,
    thumbUrl: `https://image.tmdb.org/t/p/w300/b${i}.jpg`,
    width: 1920,
    height: 1080,
    voteAverage: 5.5 + i,
    voteCount: 100 - i,
    aspectRatio: 1920 / 1080,
  }))
}

function makeProps(
  overrides: Partial<StillsPickerViewProps> = {},
): StillsPickerViewProps {
  return {
    filmTitle: 'Test Film',
    slideNumber: 3,
    slideLabel: 'Test Label',
    currentStillUrl: null,
    fetchState: { status: 'loading' },
    selectedUrl: null,
    isApplying: false,
    onClose: () => {},
    onSelect: () => {},
    onReset: () => {},
    onApplyClick: () => {},
    ...overrides,
  }
}

type AnyEl = { type?: unknown; props?: Record<string, unknown> } | null | undefined | string | number | boolean | AnyEl[]

function walkTree(
  el: AnyEl,
  pred: (e: { type?: unknown; props?: Record<string, unknown> }) => boolean,
  acc: Array<{ type?: unknown; props?: Record<string, unknown> }> = [],
): Array<{ type?: unknown; props?: Record<string, unknown> }> {
  if (
    el == null ||
    typeof el === 'string' ||
    typeof el === 'number' ||
    typeof el === 'boolean'
  ) {
    return acc
  }
  if (Array.isArray(el)) {
    for (const c of el) walkTree(c, pred, acc)
    return acc
  }
  if (typeof el === 'object' && 'props' in el) {
    if (pred(el)) acc.push(el)
    const children = el.props?.children as AnyEl
    if (children !== undefined) walkTree(children, pred, acc)
  }
  return acc
}

function findButtonByText(
  root: ReturnType<typeof StillsPickerView>,
  label: string,
) {
  const buttons = walkTree(root as AnyEl, (e) => e.type === 'button')
  return buttons.find((b) => {
    const kids = b.props?.children
    const txt =
      typeof kids === 'string'
        ? kids
        : Array.isArray(kids)
          ? kids.map((k) => (typeof k === 'string' ? k : '')).join('')
          : String(kids ?? '')
    return txt.includes(label)
  })
}

describe('StillsPickerView', () => {
  it('renders loading state on mount', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        StillsPickerView,
        makeProps({ fetchState: { status: 'loading' } }),
      ),
    )
    expect(html).toContain('stills-loading')
    expect(html).toContain('Loading stills')
  })

  it('renders thumbnail grid after GET resolves', () => {
    const backdrops = makeBackdrops(3)
    const html = renderToStaticMarkup(
      React.createElement(
        StillsPickerView,
        makeProps({ fetchState: { status: 'ready', backdrops } }),
      ),
    )
    expect(html).toContain('stills-grid')
    for (const b of backdrops) {
      expect(html).toContain(b.thumbUrl)
    }
  })

  it('shows CURRENT badge on applied still', () => {
    const backdrops = makeBackdrops(2)
    const html = renderToStaticMarkup(
      React.createElement(
        StillsPickerView,
        makeProps({
          fetchState: { status: 'ready', backdrops },
          currentStillUrl: backdrops[0].url,
        }),
      ),
    )
    expect(html).toContain('CURRENT')
  })

  it('Apply button disabled until thumb selected', () => {
    const backdrops = makeBackdrops(1)
    const rootUnselected = StillsPickerView(
      makeProps({
        fetchState: { status: 'ready', backdrops },
        selectedUrl: null,
      }),
    )
    const applyBtnUnselected = findButtonByText(rootUnselected, 'Apply still')
    expect(applyBtnUnselected).toBeDefined()
    expect(applyBtnUnselected!.props?.disabled).toBe(true)

    const rootSelected = StillsPickerView(
      makeProps({
        fetchState: { status: 'ready', backdrops },
        selectedUrl: backdrops[0].url,
      }),
    )
    const applyBtnSelected = findButtonByText(rootSelected, 'Apply still')
    expect(applyBtnSelected).toBeDefined()
    expect(applyBtnSelected!.props?.disabled).toBe(false)
  })

  it('clicking Reset invokes the onReset prop (container wires this to onApply(null))', () => {
    const onReset = vi.fn()
    const root = StillsPickerView(makeProps({ onReset }))
    const resetBtn = findButtonByText(root, 'Reset')
    expect(resetBtn).toBeDefined()
    ;(resetBtn!.props?.onClick as () => void)()
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('clicking Apply invokes onApplyClick (container wires this to onApply(selectedUrl))', () => {
    const onApplyClick = vi.fn()
    const backdrops = makeBackdrops(1)
    const root = StillsPickerView(
      makeProps({
        fetchState: { status: 'ready', backdrops },
        selectedUrl: backdrops[0].url,
        onApplyClick,
      }),
    )
    const applyBtn = findButtonByText(root, 'Apply still')
    expect(applyBtn).toBeDefined()
    ;(applyBtn!.props?.onClick as () => void)()
    expect(onApplyClick).toHaveBeenCalledTimes(1)
  })

  it('renders empty state', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        StillsPickerView,
        makeProps({ fetchState: { status: 'ready', backdrops: [] } }),
      ),
    )
    expect(html).toContain('stills-empty')
    expect(html).toContain('No TMDB stills')
  })

  it('renders error state', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        StillsPickerView,
        makeProps({ fetchState: { status: 'error', message: 'boom' } }),
      ),
    )
    expect(html).toContain('stills-error')
    expect(html).toContain('boom')
  })
})
