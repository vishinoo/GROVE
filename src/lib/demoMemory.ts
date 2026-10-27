/**
 * A memory to demo with.
 *
 * The Memory screen is the hardest thing in the app to show off on a fresh
 * install, because it is a picture of weeks of use. This fills it with a
 * full, plausible few months of the author's life: facts filed by subject,
 * goals with a number on them, people with their relationship and their own
 * facts, projects and organisations they connect to, and a run of dated
 * episodes — some still open — so every section of the map has something to
 * light up and every kind of question has an answer.
 *
 * Broadly true rather than exactly true, on purpose: it is a demo, and the
 * point is to show what the memory does with a life, not to be a record of
 * one. It goes in through the same doors a conversation uses — remember()
 * for facts and goals, absorb() for people, projects and episodes — so it
 * merges rather than duplicates, and running it twice changes nothing.
 *
 * Developer mode only (see devMode.ts).
 */

import { absorb, forgetEntity, updateLife, type Learned } from './life';
import { forget, loadFacts, remember } from './memory';

type Line = { key: string; value: string; subject?: string; source?: 'told' | 'noticed'; open?: boolean };

const FACTS: Line[] = [
  { key: 'name', value: 'Is called Vishnu' },
  { key: 'study', value: 'Studies finance at the University of Alberta, in third year' },
  { key: 'interests', value: 'Most interested in where technology and finance meet: fintech, payments, investing products' },
  { key: 'internship-role', value: 'Wants an internship in product or strategy at a fintech, not a pure banking role' },
  { key: 'building', value: 'Is building Grove, a voice assistant for Bluetooth glasses and a ring' },
  { key: 'substack', value: 'Writes a Substack called First Principles, on tech, finance and philosophy' },
  { key: 'reading', value: 'Reads mostly philosophy, technology and finance' },
  { key: 'stoics', value: 'Keeps coming back to the Stoics, Marcus Aurelius especially' },
  { key: 'reading-now', value: 'Currently reading The Psychology of Money' },
  { key: 'fitness', value: 'Is losing weight: down 6 kg since September, aiming for 10' },
  { key: 'gym', value: 'Lifts Monday, Wednesday and Friday mornings, runs on Saturdays' },
  { key: 'diet', value: 'Eats high protein and has cut out late-night snacking' },
  { key: 'sleep', value: 'Tends to stay up late coding and is trying to be in bed by midnight', source: 'noticed' },
  { key: 'coffee', value: 'Takes coffee black, one before ten and none after two' },
  { key: 'investing', value: 'Invests monthly in index funds through Wealthsimple' },
  { key: 'style', value: 'Likes clean, minimal design with very little text on screen' },
  { key: 'mornings', value: 'Thinks best in the morning and saves writing for then' },
  { key: 'mentor', value: 'Asks Professor Chen for advice on internships', subject: 'professor chen' },
  { key: 'training', value: 'Trains with Sam on Monday and Friday mornings', subject: 'sam' },
  { key: 'ask', value: 'Ask Arjun for a referral at Shopify', subject: 'arjun', open: true },
  { key: 'edits', value: 'Maya reads Substack drafts before they go out', subject: 'maya' },
];

const GOALS: Line[] = [
  { key: 'internship', value: 'Land a summer internship in product or strategy at a fintech' },
  { key: 'applications', value: 'Send 50 applications before the end of November' },
  { key: 'weight', value: 'Lose 10 kg by the new year, and keep it off' },
  { key: 'half', value: 'Run a half marathon in spring' },
  { key: 'writing', value: 'Publish on Substack every Sunday, and reach 1,000 subscribers' },
  { key: 'reading', value: 'Read 24 books this year' },
  { key: 'ship-grove', value: 'Ship Grove to a first group of real users' },
];

const LEARNED: Learned = {
  entities: [
    {
      name: 'Sam',
      kind: 'person',
      relation: 'gym partner',
      summary: 'Trains with Vishnu twice a week and keeps the weight-loss plan honest.',
      facts: ['Trains together Monday and Friday mornings', 'Ran the Edmonton half marathon last year'],
    },
    {
      name: 'Professor Chen',
      kind: 'person',
      relation: 'finance professor and mentor',
      summary: 'Teaches corporate finance and gives advice on internships.',
      facts: ['Teaches FIN 301, corporate finance', 'Suggested aiming for fintech product roles', 'Office hours on Thursday afternoons'],
    },
    {
      name: 'Arjun',
      kind: 'person',
      relation: 'older brother',
      summary: 'A software engineer in Toronto who can refer Vishnu at Shopify.',
      facts: ['Works as a software engineer at Shopify', 'Lives in Toronto', 'Offered to pass a resume along'],
    },
    {
      name: 'Maya',
      kind: 'person',
      relation: 'friend and first reader',
      summary: 'Reads Substack drafts and co-runs the investment club.',
      facts: ['Reads every draft before it goes out', 'Co-runs the student investment club'],
    },
    {
      name: 'Coach Mike',
      kind: 'person',
      relation: 'running coach',
      facts: ['Wrote the 12-week plan for the spring half marathon'],
    },
    {
      name: 'Grove',
      kind: 'project',
      relation: 'the app being built',
      summary: 'A voice assistant for Bluetooth glasses and a ring, with a memory that stays on the phone.',
      facts: [
        'Spoken to hands-free through glasses, started with one press of a ring',
        'Memory stays on the phone, encrypted',
        'The Talk screen is a moving field in Tide, Ember, Moss or Aurora',
        'Onboarding pairs the glasses and the ring with a chime',
      ],
    },
    {
      name: 'First Principles',
      kind: 'project',
      relation: 'Substack newsletter',
      summary: 'A weekly essay on technology, finance and philosophy.',
      facts: ['Publishes on Sundays', 'About 340 subscribers', 'Most-read post: why index funds are a Stoic idea'],
    },
    {
      name: 'Internship search',
      kind: 'project',
      relation: 'summer internship hunt',
      summary: 'Product and strategy roles at fintechs, 50 applications before December.',
      facts: ['23 of 50 applications sent', 'First-round interview with Wealthsimple booked', 'Stripe and Shopify applications in'],
    },
    {
      name: 'Fitness plan',
      kind: 'project',
      relation: 'weight loss and training',
      facts: ['Down 6 kg of a 10 kg goal', 'Three lifting days and a Saturday run', 'Spring half marathon on a 12-week plan'],
    },
    { name: 'Wealthsimple', kind: 'org', relation: 'internship target', facts: ['First-round interview booked for product'] },
    { name: 'Stripe', kind: 'org', relation: 'internship target', facts: ['Applied for a strategy internship'] },
    { name: 'Shopify', kind: 'org', relation: 'internship target', facts: ['Arjun can refer for a product role'] },
    { name: 'University of Alberta', kind: 'org', relation: 'university', facts: ['Third year of a finance degree'] },
    { name: 'Investment club', kind: 'org', relation: 'student club', facts: ['Meets on Tuesday evenings', 'Co-run with Maya'] },
    { name: 'Marcus Aurelius', kind: 'idea', relation: 'favourite philosopher', facts: ['Meditations is the book reread most'] },
  ],
  episodes: [
    {
      kind: 'commitment',
      title: 'Committed to 50 applications by December',
      summary: 'Set the target after talking it through with Professor Chen.',
      at: '2026-09-21T10:00:00',
      about: ['Internship search', 'Professor Chen'],
      open: true,
    },
    {
      kind: 'meeting',
      title: 'Office hours with Professor Chen',
      summary: 'Talked about fintech product roles over banking; Chen suggested Wealthsimple and Stripe.',
      at: '2026-09-24T15:00:00',
      about: ['Professor Chen', 'Wealthsimple', 'Stripe', 'Internship search'],
    },
    {
      kind: 'event',
      title: 'Started the weight-loss plan',
      summary: 'Three lifting days with Sam, a Saturday run, high protein and no late snacks.',
      at: '2026-09-01T07:30:00',
      about: ['Fitness plan', 'Sam'],
    },
    {
      kind: 'event',
      title: 'Down 6 kg',
      summary: 'Six kilos since September, more than halfway to the goal.',
      at: '2026-10-20T07:15:00',
      about: ['Fitness plan'],
    },
    {
      kind: 'event',
      title: 'Published “Why index funds are a Stoic idea”',
      summary: 'Most-read First Principles post so far; Maya edited it.',
      at: '2026-10-04T09:00:00',
      about: ['First Principles', 'Maya', 'Marcus Aurelius'],
    },
    {
      kind: 'event',
      title: 'Published “What a payment actually is”',
      at: '2026-10-18T09:00:00',
      about: ['First Principles', 'Stripe'],
    },
    {
      kind: 'conversation',
      title: 'Arjun offered a Shopify referral',
      summary: 'Arjun will pass a resume to a product manager on his team.',
      at: '2026-10-11T20:00:00',
      about: ['Arjun', 'Shopify', 'Internship search'],
    },
    {
      kind: 'commitment',
      title: 'Send Arjun the updated resume',
      at: '2026-10-12T09:00:00',
      about: ['Arjun', 'Shopify'],
      open: true,
    },
    {
      kind: 'event',
      title: 'Applied to Stripe for a strategy internship',
      at: '2026-10-14T13:00:00',
      about: ['Stripe', 'Internship search'],
    },
    {
      kind: 'event',
      title: 'First-round interview booked with Wealthsimple',
      summary: 'A product internship, first round on 3 November.',
      at: '2026-10-22T11:30:00',
      about: ['Wealthsimple', 'Internship search'],
    },
    {
      kind: 'commitment',
      title: 'Prepare a product case for the Wealthsimple interview',
      at: '2026-10-23T09:00:00',
      about: ['Wealthsimple'],
      open: true,
    },
    {
      kind: 'meeting',
      title: 'Investment club: pitched a payments stock',
      summary: 'Pitched a payments company; the club voted to watch it rather than buy.',
      at: '2026-10-13T18:30:00',
      about: ['Investment club', 'Maya'],
    },
    {
      kind: 'event',
      title: 'Signed up for the spring half marathon',
      summary: 'Coach Mike wrote a 12-week plan starting in January.',
      at: '2026-10-08T19:00:00',
      about: ['Fitness plan', 'Coach Mike'],
    },
    {
      kind: 'idea',
      title: 'Essay idea: Grove and the extended mind',
      summary: 'A memory you can wear, and what the Stoics would make of it.',
      at: '2026-10-19T23:40:00',
      about: ['First Principles', 'Grove'],
    },
    {
      kind: 'event',
      title: 'Gave Grove its moving field and four colours',
      at: '2026-10-24T18:30:00',
      about: ['Grove'],
    },
    {
      kind: 'event',
      title: 'Rebuilt the Grove onboarding around pairing',
      at: '2026-10-26T15:00:00',
      about: ['Grove'],
    },
    {
      kind: 'commitment',
      title: 'Demo Grove to the investment club',
      at: '2026-10-27T12:00:00',
      about: ['Grove', 'Investment club'],
      open: true,
    },
  ],
};

/** What the first version of this put in, so a second fill does not leave it lying around. */
const OLD_FACT_KEYS = ['lego', 'city', 'hours', 'taste', 'hardware', 'resumes', 'm&a'];
const OLD_ENTITIES = ['Lego', 'Edmonton', 'Orb lab', 'J09', 'Grove Glass', 'M&A interview prep', 'Apple', 'Meta'];

export async function fillDemoMemory(uid: string): Promise<void> {
  for (const old of await loadFacts(uid)) {
    if (old.subject === 'me' && OLD_FACT_KEYS.includes(old.key)) await forget(uid, old.id);
  }
  for (const { subject = 'me', ...fact } of FACTS) await remember(uid, { ...fact, subject });
  for (const { subject = 'me', ...goal } of GOALS) await remember(uid, { ...goal, subject, kind: 'goal' });
  await updateLife(uid, (life) => {
    const cleared = life.entities
      .filter((entity) => OLD_ENTITIES.includes(entity.name))
      .reduce((next, entity) => forgetEntity(next, entity.id), life);
    return absorb(cleared, LEARNED, 'demo');
  });
}
