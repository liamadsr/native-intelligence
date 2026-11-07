/**
 * Enrollment story — "The Snack Committee".
 *
 * Three ~55-word passages the user reads aloud during voice enrollment. Chosen
 * for natural prosody and wide phoneme coverage; each passage is recorded as
 * one session_id so the pipeline builds three corroborating prototypes.
 *
 * Wave-0 contract: static data, no dependencies.
 */

export interface EnrollmentPassage {
  id: string
  title: string
  text: string
}

export const ENROLLMENT_STORY: EnrollmentPassage[] = [
  {
    id: 'passage-1',
    title: 'The Snack Committee — Part 1',
    text: 'On a bright Tuesday morning, a very small octopus named Pixel decided to run her first meeting. She invited a jazzy flamingo, two shy jellyfish, and a whale who was always five minutes late. "Welcome, everyone," she said, tapping her tiny gavel. "Today we have exactly one item on the agenda: snacks."',
  },
  {
    id: 'passage-2',
    title: 'Part 2',
    text: 'The flamingo proposed mango smoothies. The jellyfish, after a long pause, voted for seaweed crackers — extra crunchy. The whale arrived just in time to suggest a chocolate fountain, which everyone agreed was ambitious but bold. Pixel took quick notes with three of her eight arms, which is, frankly, showing off.',
  },
  {
    id: 'passage-3',
    title: 'Part 3',
    text: 'By noon the vote was unanimous: all of the above. Pixel closed her notebook and smiled. "Excellent work, team. Same time next week?" The whale cheered, the jellyfish wobbled with joy, and the flamingo did a little dance. And that is how the ocean\'s snack committee was born.',
  },
]
