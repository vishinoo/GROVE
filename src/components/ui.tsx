/**
 * The pieces every screen is built from.
 *
 * Grove has four surfaces and they are all lists of state: what's connected,
 * what's installed, what happened. Rather than four screens each inventing a
 * card, everything structural lives here, which is also what keeps the
 * hairline-and-paper look consistent when a screen is added later.
 */

import type { ReactNode } from 'react';
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
export function Screen({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
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
