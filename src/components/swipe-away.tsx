/**
 * Swipe a remembered thing away.
 *
 * Everything Grove keeps is on the Sparks screen so it can be corrected, and
 * until now correcting it meant finding a small red word at the end of a row.
 * That is fine for the one fact you went looking for and wrong for the common
 * case, which is a list that has accumulated five near-identical rows and
 * wants thinning. A swipe is the gesture people already have for that.
 *
 * THREE DECISIONS WORTH WRITING DOWN
 *
 * **It pulls right, not left.** iOS convention is leftward for destructive, and
 * this is deliberately the other way: leftward swipes on a scrolling list are
 * already spoken for by the system back gesture at the screen edge, and a
 * memory row is not a mail row — getting rid of one is ordinary rather than
 * dangerous, because anything deleted here Grove simply learns again if it
 * matters.
 *
 * **It commits on release past a threshold, not on a second tap.** A
 * confirmation dialog for deleting "wake up around 07:30" is more ceremony than
 * the thing is worth. The row has to travel most of its own width, which is far
 * enough that a thumb brushing the list while scrolling cannot do it.
 *
 * **It animates out rather than vanishing.** The row collapsing is what tells
 * you which one went, in a list where several rows look alike — which is
 * exactly the list this exists for.
 */

import { useCallback } from 'react';
import { AccessibilityInfo, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Icon } from '@/components/icon';
import { Radius, Type } from '@/constants/theme';
import { usePalette } from '@/hooks/use-palette';

/** How far across the screen before letting go means delete. */
const COMMIT_FRACTION = 0.4;

/** Below this a drag is a scroll that wobbled, not a swipe. */
const START_AT = 12;

export function SwipeAway({
  onDelete,
  children,
  /** Said by the screen reader, which cannot swipe. */
  label,
}: {
  onDelete: () => void;
  children: React.ReactNode;
  label: string;
}) {
  const palette = usePalette();
  const { width } = useWindowDimensions();
  const commitAt = width * COMMIT_FRACTION;

  const x = useSharedValue(0);
  const height = useSharedValue<number | undefined>(undefined);
  const gone = useSharedValue(0);

  const finish = useCallback(() => {
    AccessibilityInfo.announceForAccessibility?.(`${label} deleted`);
    onDelete();
  }, [label, onDelete]);

  const pan = Gesture.Pan()
    .activeOffsetX([-9999, START_AT])
    .failOffsetY([-10, 10])
    .onChange((event) => {
      // Rightward only. A leftward drag belongs to the list and to the system
      // back gesture, and fighting either one makes the screen feel broken.
      x.value = Math.max(0, x.value + event.changeX);
    })
    .onEnd(() => {
      if (x.value < commitAt) {
        x.value = withTiming(0, { duration: 180, easing: Easing.out(Easing.cubic) });
        return;
      }
      x.value = withTiming(width, { duration: 160, easing: Easing.in(Easing.cubic) });
      gone.value = withTiming(1, { duration: 200 }, (done) => {
        if (done) runOnJS(finish)();
      });
    });

  const row = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }],
  }));

  /**
   * A height only while it is leaving, and never otherwise.
   *
   * Collapsing the row is what identifies which one left, in a list where
   * several of them look alike — but an earlier version measured once and then
   * applied that height for ever. Any card that grew afterwards overflowed a
   * box frozen at its old size: a memory card opened to show its editor and the
   * Forget button underneath it spilled straight over the next section, and a
   * goal long enough to wrap did the same. Natural height the rest of the time,
   * which is what a list of things that change size needs.
   */
  const shell = useAnimatedStyle(() => ({
    opacity: 1 - gone.value,
    height: gone.value > 0 && height.value !== undefined ? height.value * (1 - gone.value) : undefined,
  }));

  const behind = useAnimatedStyle(() => ({
    opacity: Math.min(1, x.value / Math.max(commitAt, 1)),
  }));

  return (
    <Animated.View
      style={shell}
      onLayout={(event) => {
        // Tracked rather than captured once, so the collapse starts from
        // whatever the row actually is at the moment it is swiped away.
        if (gone.value === 0) height.value = event.nativeEvent.layout.height;
      }}
    >
      <View>
        <Animated.View
          pointerEvents="none"
          style={[
            behind,
            {
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              bottom: 6,
              borderRadius: Radius.card,
              backgroundColor: palette.sunken,
              borderWidth: 1,
              borderColor: palette.line,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingLeft: 16,
            },
          ]}
        >
          <Icon name="trash" size={15} color={palette.alert} />
          <Text style={[Type.bodySm, { color: palette.alert }]}>Forget</Text>
        </Animated.View>

        <GestureDetector gesture={pan}>
          <Animated.View
            style={row}
            accessible
            accessibilityLabel={label}
            accessibilityHint="Swipe right to forget this"
            accessibilityActions={[{ name: 'magicTap', label: 'Forget' }]}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === 'magicTap') finish();
            }}
          >
            {children}
          </Animated.View>
        </GestureDetector>
      </View>
    </Animated.View>
  );
}
