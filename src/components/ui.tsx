/**
 * The pieces every screen is built from.
 *
 * Grove has four surfaces and they are all lists of state: what's connected,
 * what's installed, what happened. Rather than four screens each inventing a
 * card, everything structural lives here, which is also what keeps the
 * hairline-and-paper look consistent when a screen is added later.
 */

import { Children, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { Elevation, Radius, Space, Type, monoLabel } from '@/constants/theme';
import { usePalette } from '@/hooks/use-palette';

/** A scrolling screen with a title, correctly inset for the dock. */
/**
 * A list as one box with hairlines between the rows, rather than a card per
 * item.
 *
 * A card each gives every row its own border, its own corners and its own
 * shadow, and a list of six of them reads as a pile rather than a list. One
 * panel says these things are the same kind of thing, which is the only
 * reason they are next to each other.
 */
export function Panel({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const palette = usePalette();
  const rows = Children.toArray(children).filter(Boolean);
  if (rows.length === 0) return null;

  return (
    <View
      style={[
        {
          backgroundColor: palette.raised,
          borderWidth: 1,
          borderColor: palette.line,
          borderRadius: Radius.card + 2,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {rows.map((row, index) => (
        <View
          key={index}
          style={{ borderTopWidth: index === 0 ? 0 : 1, borderTopColor: palette.line }}
        >
          {row}
        </View>
      ))}
    </View>
  );
}

export function Screen({
  title,
  subtitle,
  children,
  action,
  sticky,
  onScroll,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
  /**
   * Pinned under the title while the rest scrolls. One screen uses it — the
   * memory map — and it is a prop rather than a wrapper because a map that
   * scrolls away is a picture, not a control.
   */
  sticky?: ReactNode;
  /** Content offset, for a screen whose header has to follow the list. */
  onScroll?: (y: number) => void;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, backgroundColor: palette.paper }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: insets.top + 14,
          paddingHorizontal: Space.screenX,
          // Clears the floating dock, which is not part of the scroll view.
          paddingBottom: insets.bottom + 108,
        }}
        keyboardShouldPersistTaps="handled"
        // Index 1 is the sticky slot below. Passed only when something is in
        // it, so every other screen keeps exactly the behaviour it had.
        stickyHeaderIndices={sticky ? [1] : undefined}
        onScroll={onScroll ? (event) => onScroll(event.nativeEvent.contentOffset.y) : undefined}
        scrollEventThrottle={32}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: subtitle ? 6 : 18,
          }}
        >
          <Text style={[Type.screenTitle, { color: palette.ink, flex: 1 }]}>{title}</Text>
          {action}
        </View>

        {/*
          Always rendered when `sticky` is set, and never otherwise, so the
          index handed to stickyHeaderIndices is the one that is actually
          there. A conditional that collapses to null shifts every index after
          it and pins the wrong thing.
        */}
        {sticky ? (
          <View style={{ backgroundColor: palette.paper, paddingBottom: 12 }}>{sticky}</View>
        ) : null}

        {subtitle ? (
          <Text style={[Type.bodySm, { color: palette.muted, marginBottom: 20 }]}>{subtitle}</Text>
        ) : null}

        {children}
      </ScrollView>
    </View>
  );
}

/** A titled block of rows. */
export function Section({
  label,
  children,
  style,
}: {
  label?: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = usePalette();
  return (
    <View style={[{ marginBottom: Space.section }, style]}>
      {label ? (
        <Text style={[monoLabel, { color: palette.muted, marginBottom: 10 }]}>{label}</Text>
      ) : null}
      {children}
    </View>
  );
}

/**
 * A section that shows a couple and offers the rest.
 *
 * This replaced a fold that was closed by default, which solved the wrong
 * problem. The archive sections are long and were burying the live parts of
 * the screen, so they were shut — and a screen of shut drawers is worse than a
 * long one: there is nothing to read, nothing to recognise, and no reason to
 * believe any of it has anything in it.
 *
 * Two is enough to prove the thing is alive and show the most recent, which is
 * what a glance wants. The count on the button is the rest, so opening it is a
 * decision rather than a surprise.
 */
export function Peek({
  label,
  children,
  show = 2,
  style,
}: {
  label: string;
  children: ReactNode;
  /** How many to show before the button. */
  show?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = usePalette();
  const [all, setAll] = useState(false);

  const items = Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  const hidden = items.length - show;

  return (
    <View style={[{ marginBottom: Space.section }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Text style={[monoLabel, { color: palette.muted }]}>{label}</Text>
        <Text style={[monoLabel, { color: palette.lineStrong }]}>{items.length}</Text>
      </View>

      {(all ? items : items.slice(0, show)).map((item, i) => (
        <View key={i}>{item}</View>
      ))}

      {hidden > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: all }}
          onPress={() => setAll((was) => !was)}
          hitSlop={6}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            paddingVertical: 11,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={[Type.bodySm, { color: palette.inkSoft }]}>
            {all ? 'Show less' : `Show ${hidden} more`}
          </Text>
          <Icon name={all ? 'chevron' : 'down'} size={12} color={palette.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** The standard raised surface. Everything sits on one of these. */
export function Card({
  children,
  style,
  onPress,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
}) {
  const palette = usePalette();
  const body = (
    <View
      style={[
        {
          backgroundColor: palette.raised,
          borderRadius: Radius.card,
          borderWidth: 1,
          borderColor: palette.line,
          padding: 14,
        },
        style,
      ]}
    >
      {children}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {body}
    </Pressable>
  );
}

/**
 * A status dot.
 *
 * The only place colour is allowed to appear in the interface, and the reason
 * the rest of it is monochrome — a green dot means something is genuinely
 * live, so it has to be the only green thing on the screen to mean anything.
 */
export function Dot({ tone, size = 7 }: { tone: 'live' | 'alert' | 'off'; size?: number }) {
  const palette = usePalette();
  const color =
    tone === 'live' ? palette.signal : tone === 'alert' ? palette.alert : palette.muted;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        opacity: tone === 'off' ? 0.45 : 1,
      }}
    />
  );
}

/** Uppercase machine label — device names, ids, counts. */
export function Mono({
  children,
  color,
  style,
}: {
  children: ReactNode;
  color?: string;
  style?: StyleProp<TextStyle>;
}) {
  const palette = usePalette();
  return <Text style={[monoLabel, { color: color ?? palette.muted }, style]}>{children}</Text>;
}

export function Button({
  label,
  onPress,
  tone = 'primary',
  icon,
  busy,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  tone?: 'primary' | 'quiet' | 'danger';
  icon?: IconName;
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = usePalette();
  const inactive = disabled || busy;

  const background =
    tone === 'primary' ? palette.mark : tone === 'danger' ? 'transparent' : palette.raised;
  const foreground =
    tone === 'primary' ? palette.paper : tone === 'danger' ? palette.alert : palette.ink;
  const border = tone === 'primary' ? palette.mark : tone === 'danger' ? palette.alert : palette.line;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(inactive) }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          minHeight: 46,
          paddingHorizontal: 18,
          borderRadius: Radius.control,
          backgroundColor: background,
          borderWidth: 1,
          borderColor: border,
          opacity: inactive ? 0.45 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={16} color={foreground} /> : null}
          <Text style={{ fontFamily: Type.cardTitle.fontFamily, fontSize: 14.5, color: foreground }}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** A row of label and value, as used all over Settings. */
export function Row({
  label,
  value,
  hint,
  right,
  onPress,
  tone,
}: {
  label: string;
  value?: string;
  hint?: string;
  right?: ReactNode;
  onPress?: () => void;
  tone?: 'live' | 'alert' | 'off';
}) {
  const palette = usePalette();

  const body = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 13,
        borderBottomWidth: 1,
        borderBottomColor: palette.line,
      }}
    >
      {tone ? <Dot tone={tone} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[Type.body, { color: palette.ink }]}>{label}</Text>
        {hint ? <Text style={[Type.bodySm, { color: palette.muted }]}>{hint}</Text> : null}
      </View>
      {value ? <Mono>{value}</Mono> : null}
      {right}
      {onPress && !right ? <Icon name="chevron" size={15} color={palette.muted} /> : null}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      {body}
    </Pressable>
  );
}

/**
 * A non-fatal problem, stated once at the top of a screen.
 *
 * Deliberately not a toast: most of these are conditions rather than events —
 * Noctus unreachable, an integration missing — and a message that disappears
 * after three seconds is no use for something that is still true.
 */
export function Notice({
  text,
  tone = 'alert',
  onDismiss,
  action,
}: {
  text: string;
  tone?: 'alert' | 'info';
  onDismiss?: () => void;
  action?: ReactNode;
}) {
  const palette = usePalette();
  const accent = tone === 'alert' ? palette.alert : palette.inkSoft;

  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 10,
          padding: 13,
          marginBottom: 16,
          borderRadius: Radius.control,
          backgroundColor: palette.raised,
          borderWidth: 1,
          borderColor: tone === 'alert' ? palette.alert : palette.line,
        },
        Elevation.liftSm,
      ]}
    >
      <View style={{ paddingTop: 1 }}>
        <Icon name="alert" size={16} color={accent} />
      </View>
      <View style={{ flex: 1, gap: 8 }}>
        <Text style={[Type.bodySm, { color: palette.ink }]}>{text}</Text>
        {action}
      </View>
      {onDismiss ? (
        <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel="Dismiss">
          <Mono>Close</Mono>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Nothing here yet, said without apology. */
export function Empty({ text }: { text: string }) {
  const palette = usePalette();
  return (
    <View style={{ paddingVertical: 30, alignItems: 'center' }}>
      <Text style={[Type.bodySm, { color: palette.muted, textAlign: 'center' }]}>{text}</Text>
    </View>
  );
}
