import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Anthropic SDK before importing the module under test
const mockMessagesCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockMessagesCreate }
    },
  }
})

vi.mock('@/lib/logger', () => ({
  pipelineLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildMessage = (text: string): any => ({
  content: [{ type: 'text', text }],
})

describe('beat-generator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses valid JSON beats response', async () => {
    const { generateBeatsFromPlot } = await import('@/lib/beat-generator')

    mockMessagesCreate.mockResolvedValueOnce(
      buildMessage(
        JSON.stringify({
          beats: [
            { label: 'The opening', timeStart: 0, timeEnd: 10, timeMidpoint: 5 },
            { label: 'The twist', timeStart: 60, timeEnd: 75, timeMidpoint: 67 },
            { label: 'The ending', timeStart: 110, timeEnd: 120, timeMidpoint: 115 },
            { label: 'The showdown', timeStart: 90, timeEnd: 105, timeMidpoint: 98 },
          ],
        })
      )
    )

    const beats = await generateBeatsFromPlot('Test Film', 2024, 120, 'A'.repeat(500))

    expect(beats).toHaveLength(4)
    // Sorted chronologically
    expect(beats[0].label).toBe('The opening')
    expect(beats[1].label).toBe('The twist')
    expect(beats[2].label).toBe('The showdown')
    expect(beats[3].label).toBe('The ending')
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1)
  })

  it('strips markdown code fences from response', async () => {
    const { generateBeatsFromPlot } = await import('@/lib/beat-generator')

    mockMessagesCreate.mockResolvedValueOnce(
      buildMessage(
        '```json\n' +
          JSON.stringify({
            beats: [
              { label: 'Opening', timeStart: 0, timeEnd: 10, timeMidpoint: 5 },
              { label: 'Middle', timeStart: 40, timeEnd: 60, timeMidpoint: 50 },
              { label: 'Climax', timeStart: 80, timeEnd: 100, timeMidpoint: 90 },
              { label: 'Ending', timeStart: 100, timeEnd: 120, timeMidpoint: 110 },
            ],
          }) +
          '\n```'
      )
    )

    const beats = await generateBeatsFromPlot('Test Film', 2024, 120, 'A'.repeat(500))
    expect(beats).toHaveLength(4)
  })

  it('retries once on invalid JSON and succeeds on second attempt', async () => {
    const { generateBeatsFromPlot } = await import('@/lib/beat-generator')

    mockMessagesCreate
      .mockResolvedValueOnce(buildMessage('not valid json at all'))
      .mockResolvedValueOnce(
        buildMessage(
          JSON.stringify({
            beats: [
              { label: 'A', timeStart: 0, timeEnd: 10, timeMidpoint: 5 },
              { label: 'B', timeStart: 20, timeEnd: 30, timeMidpoint: 25 },
              { label: 'C', timeStart: 40, timeEnd: 50, timeMidpoint: 45 },
              { label: 'D', timeStart: 60, timeEnd: 70, timeMidpoint: 65 },
            ],
          })
        )
      )

    const beats = await generateBeatsFromPlot('Test Film', 2024, 100, 'A'.repeat(500))
    expect(beats).toHaveLength(4)
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2)
  })

  it('returns empty array after both attempts fail', async () => {
    const { generateBeatsFromPlot } = await import('@/lib/beat-generator')

    mockMessagesCreate
      .mockResolvedValueOnce(buildMessage('nope'))
      .mockResolvedValueOnce(buildMessage('still nope'))

    const beats = await generateBeatsFromPlot('Test Film', 2024, 120, 'A'.repeat(500))
    expect(beats).toEqual([])
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2)
  })

  it('returns empty array and does not call API when plot is too short', async () => {
    const { generateBeatsFromPlot } = await import('@/lib/beat-generator')

    const beats = await generateBeatsFromPlot('Test Film', 2024, 120, 'short')
    expect(beats).toEqual([])
    expect(mockMessagesCreate).not.toHaveBeenCalled()
  })

  it('rejects response with too few beats', async () => {
    const { generateBeatsFromPlot } = await import('@/lib/beat-generator')

    mockMessagesCreate
      .mockResolvedValueOnce(
        buildMessage(
          JSON.stringify({
            beats: [
              { label: 'A', timeStart: 0, timeEnd: 10, timeMidpoint: 5 },
              { label: 'B', timeStart: 20, timeEnd: 30, timeMidpoint: 25 },
            ],
          })
        )
      )
      .mockResolvedValueOnce(buildMessage('still bad'))

    const beats = await generateBeatsFromPlot('Test Film', 2024, 100, 'A'.repeat(500))
    expect(beats).toEqual([])
  })

  it('rejects beats with out-of-range timestamps', async () => {
    const { generateBeatsFromPlot } = await import('@/lib/beat-generator')

    mockMessagesCreate
      .mockResolvedValueOnce(
        buildMessage(
          JSON.stringify({
            beats: [
              { label: 'A', timeStart: 0, timeEnd: 10, timeMidpoint: 5 },
              { label: 'B', timeStart: 20, timeEnd: 30, timeMidpoint: 25 },
              { label: 'C', timeStart: 40, timeEnd: 50, timeMidpoint: 45 },
              { label: 'D', timeStart: 60, timeEnd: 500, timeMidpoint: 280 }, // out of range
            ],
          })
        )
      )
      .mockResolvedValueOnce(buildMessage('still bad'))

    const beats = await generateBeatsFromPlot('Test Film', 2024, 100, 'A'.repeat(500))
    expect(beats).toEqual([])
  })
})
