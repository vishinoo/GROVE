/**
 * App icons.
 *
 * A connection is an app you already know by sight, so it is drawn the way it
 * looks on your home screen: a rounded tile with a colourful ground and a white
 * glyph on top. Recognising Music by its pink is faster than reading the word
 * "Music", which matters on a screen you are glancing at rather than reading.
 *
 * The glyphs for the real brands (Gmail, Google Calendar, WhatsApp) are the
 * genuine marks, reversed to white. The phone-native ones are drawn to sit with
 * them: same 24-grid, same solid single-path construction, so the set reads as
 * one family rather than as logos plus approximations.
 */

import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { Radius } from '@/constants/theme';

export type AppIconName =
  | 'music'
  | 'messages'
  | 'calendar'
  | 'mail'
  | 'maps'
  | 'reminders'
  | 'photos'
  | 'home'
  | 'notes'
  | 'whatsapp'
  | 'google';

/** Each tile's two-stop ground, taken from the app's own identity colour. */
const GROUND: Record<AppIconName, [string, string]> = {
  music: ['#FC5C7D', '#F62E52'],
  messages: ['#6FE87B', '#1FC24A'],
  calendar: ['#5B9BFF', '#2F6BE0'],
  mail: ['#FF7B6B', '#E8342A'],
  maps: ['#5BC8FA', '#2A8CF0'],
  reminders: ['#FF9E62', '#FB4E3D'],
  photos: ['#FDD35C', '#F76B8A'],
  home: ['#FFC64D', '#FF8A28'],
  notes: ['#FFDE73', '#FFB92E'],
  whatsapp: ['#5DF07D', '#1EBE55'],
  // Google's mark is four colours on white and is not reversible to a single
  // white glyph without ceasing to be recognisable — the whole point of drawing
  // real marks here. So this tile keeps a white ground and paints the G itself.
  google: ['#FFFFFF', '#F1F3F4'],
};

/** Solid single paths on a 24 grid, drawn to be filled white. */
const GLYPH: Record<AppIconName, string> = {
  music:
    'M21 3.5v12.2a3.3 3.3 0 1 1-2-3.03V7.3L10 9.02v9.18a3.3 3.3 0 1 1-2-3.03V6.2L21 3.5Z',
  messages:
    'M12 2C6.2 2 1.6 5.9 1.6 10.7c0 2.7 1.5 5.1 3.8 6.7v4.1l3.7-2.1c.9.2 1.9.3 2.9.3 5.8 0 10.4-3.9 10.4-8.7S17.8 2 12 2Z',
  calendar:
    'M7 2v2H5.5A2.5 2.5 0 0 0 3 6.5V19a2.5 2.5 0 0 0 2.5 2.5h13A2.5 2.5 0 0 0 21 19V6.5A2.5 2.5 0 0 0 18.5 4H17V2h-2v2H9V2H7Zm12 8V19H5v-9h14Z',
  mail:
    'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457Z',
  maps:
    'M12 2a7 7 0 0 0-7 7c0 5.1 6.2 12.3 6.5 12.6a.7.7 0 0 0 1 0C12.8 21.3 19 14.1 19 9a7 7 0 0 0-7-7Zm0 9.6A2.6 2.6 0 1 1 14.6 9 2.6 2.6 0 0 1 12 11.6Z',
  reminders:
    'M12 2a7 7 0 0 0-7 7v4.2l-1.7 3A1 1 0 0 0 4.2 18h15.6a1 1 0 0 0 .9-1.5l-1.7-3.3V9a7 7 0 0 0-7-7Zm0 20a3 3 0 0 0 2.8-2H9.2A3 3 0 0 0 12 22Z',
  photos:
    'M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm3.5 3A2.5 2.5 0 1 0 10 8.5 2.5 2.5 0 0 0 7.5 6ZM4 19h16v-3l-4.6-4.6-4.4 4.4-2.4-2.3L4 17.6V19Z',
  home:
    'M12 2.6 1.8 11.1a1 1 0 0 0 .64 1.77H4.5V21a1 1 0 0 0 1 1h4v-6h5v6h4a1 1 0 0 0 1-1v-8.13h2.06a1 1 0 0 0 .64-1.77L12 2.6Z',
  notes:
    'M5 2h9.2L21 8.6V22a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm8.5 1.9V9H19l-5.5-5.1ZM7.5 12h9v1.8h-9V12Zm0 4h6.5v1.8H7.5V16Z',
  // Unused at render time — google is painted from GOOGLE_G — but the Record
  // is exhaustive by type, and an exhaustive map is what stops a new icon being
  // added without a glyph.
  google:
    'M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z',
  whatsapp:
    'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z',
};

/**
 * The Google G, in its own colours.
 *
 * Every other tile is one white path on a coloured ground. Google's mark is
 * four paths in four colours on white, and flattening it to a white G loses the
 * thing that makes it identifiable at 32 points — which is the only reason to
 * draw real marks rather than generic glyphs.
 */
const GOOGLE_G: [string, string][] = [
  ['#4285F4', 'M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z'],
  ['#34A853', 'M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z'],
  ['#FBBC05', 'M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z'],
  ['#EA4335', 'M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z'],
];

export function AppIcon({ name, size = 30 }: { name: AppIconName; size?: number }) {
  const [from, to] = GROUND[name];
  const id = `ag-${name}`;
  const glyph = Math.round(size * 0.6);

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size <= 24 ? Radius.well - 3 : Radius.tile,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0%" stopColor={from} />
            <Stop offset="100%" stopColor={to} />
          </LinearGradient>
        </Defs>
        <Path d={`M0 0 H${size} V${size} H0 Z`} fill={`url(#${id})`} />
      </Svg>
      <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
        {name === 'google' ? (
          GOOGLE_G.map(([colour, d]) => <Path key={colour} d={d} fill={colour} />)
        ) : (
          <Path d={GLYPH[name]} fill="#FFFFFF" />
        )}
      </Svg>
    </View>
  );
}

/**
 * Which tile stands for a given connection key.
 *
 * Noctus's binding keys and iOS's permission names do not agree with each
 * other, and neither is what a person calls the thing, so the mapping is
 * explicit rather than inferred from the string.
 */
export function iconForKey(key: string): AppIconName | null {
  const k = key.toLowerCase();
  // Ability ids come through here too — "weather.now", "calendar.read".
  if (k.startsWith('weather')) return 'maps';
  if (k.startsWith('brief')) return 'notes';
  if (k.includes('music') || k.includes('spotify')) return 'music';
  if (k.includes('message') || k.includes('sms')) return 'messages';
  if (k.includes('calendar')) return 'calendar';
  if (k === 'google' || k.includes('workspace')) return 'google';
  if (k.includes('mail') || k.includes('gmail')) return 'mail';
  if (k.includes('map') || k.includes('location')) return 'maps';
  if (k.includes('remind') || k.includes('task')) return 'reminders';
  if (k.includes('photo')) return 'photos';
  if (k.includes('home')) return 'home';
  if (k.includes('note')) return 'notes';
  if (k.includes('whatsapp')) return 'whatsapp';
  return null;
}
