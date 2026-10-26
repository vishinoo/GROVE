/**
 * A memory to demo with.
 *
 * The map on the Memory screen is the hardest thing in the app to show off on
 * a fresh install, because it is a picture of weeks of use. This fills it for
 * the author's own account, from things actually known — what their Memory
 * screen already showed, and what was built on Grove these past weeks, on the
 * days it happened. Nothing here is invented to look busy. The one inference
 * (the city, from the university) is stored as noticed, not told, so it shows
 * as a guess.
 *
 * It goes in through the same doors a conversation uses — remember() for
 * facts and goals, absorb() for people, projects and dated episodes — so it
 * merges rather than duplicates, and running it twice changes nothing.
 *
 * A demo tool: it sits in Settings until Grove is in anyone else's hands.
 */

import { absorb, updateLife, type Learned } from './life';
import { remember } from './memory';

const FACTS: { key: string; value: string; source?: 'told' | 'noticed' }[] = [
  { key: 'name', value: 'Is called Vishnu' },
  { key: 'study', value: 'Studies finance at the University of Alberta' },
  { key: 'city', value: 'Lives in Edmonton', source: 'noticed' },
  { key: 'building', value: 'Is building Grove, a voice assistant for Bluetooth glasses and a ring' },
  { key: 'hardware', value: 'Uses a J09 ring and Grove Glass with Grove every day' },
  { key: 'lego', value: 'Is a big fan of Lego' },
  { key: 'hours', value: 'Does a lot of coding late at night' },
  { key: 'taste', value: 'Likes clean, glassy designs with very little text on screen' },
];

const GOALS: { key: string; value: string }[] = [
  { key: 'internship', value: 'Land a summer internship at a big tech company like Apple or Meta' },
  { key: 'resumes', value: 'Submit 50 resumes' },
  { key: 'm&a', value: 'Get ready for an M&A interview' },
  { key: 'ship-grove', value: 'Ship Grove with the new field design and onboarding' },
];

const LEARNED: Learned = {
  entities: [
    {
      name: 'Grove',
      kind: 'project',
      relation: 'the app being built',
      summary: 'A voice assistant for Bluetooth glasses and a ring, running on the phone.',
      facts: [
        'Spoken to hands-free through glasses, triggered by a J09 ring',
        'Memory stays on the phone, encrypted',
        'The Talk screen is a moving field in Tide, Ember, Moss or Aurora',
        'The new onboarding pairs the glasses and the ring with a chime',
      ],
    },
    { name: 'Apple', kind: 'org', relation: 'internship target', facts: ['A target company for a summer internship'] },
    { name: 'Meta', kind: 'org', relation: 'internship target', facts: ['A target company for a summer internship'] },
    {
      name: 'M&A interview prep',
      kind: 'project',
      relation: 'preparation',
      facts: ['Agreed to focus on this before internship applications'],
    },
    { name: 'University of Alberta', kind: 'org', relation: 'university', facts: ['Where finance is studied'] },
    { name: 'Edmonton', kind: 'place', relation: 'home city' },
    { name: 'J09', kind: 'topic', relation: 'the ring', facts: ['A Bluetooth ring that starts Grove with one press'] },
    { name: 'Grove Glass', kind: 'topic', relation: 'the glasses', facts: ['The glasses Grove speaks through'] },
    { name: 'Lego', kind: 'topic', relation: 'hobby', facts: ['A long-standing favourite'] },
    {
      name: 'Orb lab',
      kind: 'project',
      relation: 'design prototype',
      facts: ['Where the field’s look and the four colours were chosen'],
    },
  ],
  episodes: [
    { kind: 'commitment', title: 'Set a goal of submitting 50 resumes', at: '2026-09-30T18:00:00', about: [], open: true },
    {
      kind: 'conversation',
      title: 'Big tech internship goals',
      summary: 'Talked through a summer internship at Apple or Meta, and agreed to prepare for the M&A interview first.',
      at: '2026-10-13T21:00:00',
      about: ['Apple', 'Meta', 'M&A interview prep'],
    },
    {
      kind: 'conversation',
      title: 'Late night coding and Lego',
      summary: 'Coding new features into Grove late at night, and a mention of Lego.',
      at: '2026-10-14T23:30:00',
      about: ['Grove', 'Lego'],
    },
    {
      kind: 'event',
      title: 'Gave Grove three tabs and a dark mode',
      at: '2026-10-21T16:45:00',
      about: ['Grove'],
    },
    {
      kind: 'event',
      title: 'Designed the moving field in the orb lab',
      summary: 'Full screen won over the bubble and the orb, and the swirl came out.',
      at: '2026-10-24T18:30:00',
      about: ['Grove', 'Orb lab'],
    },
    {
      kind: 'event',
      title: 'Chose four colours from outdoors',
      summary: 'Tide, Ember, Moss and Aurora, kept separate from the personality.',
      at: '2026-10-24T21:00:00',
      about: ['Grove', 'Orb lab'],
    },
    {
      kind: 'event',
      title: 'Put Memory and Settings on glass',
      at: '2026-10-25T21:30:00',
      about: ['Grove'],
    },
    {
      kind: 'event',
      title: 'Redesigned onboarding around pairing',
      summary: 'Glasses and ring each get a connected moment; less to read.',
      at: '2026-10-26T15:00:00',
      about: ['Grove', 'Grove Glass', 'J09'],
    },
    {
      kind: 'commitment',
      title: 'Demo Grove with the new onboarding',
      at: '2026-10-26T16:00:00',
      about: ['Grove'],
      open: true,
    },
  ],
};

export async function fillDemoMemory(uid: string): Promise<void> {
  for (const fact of FACTS) await remember(uid, { ...fact, subject: 'me' });
  for (const goal of GOALS) await remember(uid, { ...goal, subject: 'me', kind: 'goal' });
  await updateLife(uid, (life) => absorb(life, LEARNED, 'demo'));
}
