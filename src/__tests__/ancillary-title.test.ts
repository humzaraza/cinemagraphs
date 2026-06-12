import { describe, it, expect } from 'vitest'
import { isAncillaryTitle } from '@/lib/ancillary-title'

describe('isAncillaryTitle', () => {
  it('catches making-of and behind-the-scenes content', () => {
    const ancillary = [
      'Marvel Studios Assembled: The Making of Hawkeye',
      'The Making of Jurassic Park',
      'Pixar: Behind the Scenes',
      'The Invention of Imaginary Machines of Destruction - First Storyboards, in Motion',
      'Frozen Gag Reel',
      'Toy Story Bloopers',
      'Moana Deleted Scenes',
      'Encanto Featurette',
      'Shrek DVD Extras',
      'Up: Bonus Features',
    ]
    for (const title of ancillary) {
      expect(isAncillaryTitle(title), title).toBe(true)
    }
  })

  // Guard rail: REAL documentaries must never match. If one of these starts
  // matching, a pattern is too broad; tighten the pattern, do not remove the
  // title from this list.
  it('never catches real documentaries', () => {
    const realDocs = [
      'March of the Penguins',
      'Free Solo',
      "Won't You Be My Neighbor?",
      'The Act of Killing',
      'Grizzly Man',
      '13th',
      'Jiro Dreams of Sushi',
      'The Last Dance',
      'Making a Murderer',
      'Man on Wire',
      'Blackfish',
      'Citizenfour',
      'Honeyland',
      'My Octopus Teacher',
      'The Rescue',
    ]
    for (const title of realDocs) {
      expect(isAncillaryTitle(title), title).toBe(false)
    }
  })

  it('does not catch ordinary features with overlapping words', () => {
    const features = [
      'The Scenes We Left Behind', // "behind the scenes" requires the phrase order
      'Boy Makes Good',
      'Reel Steel',
      'Extra Ordinary',
    ]
    for (const title of features) {
      expect(isAncillaryTitle(title), title).toBe(false)
    }
  })
})
