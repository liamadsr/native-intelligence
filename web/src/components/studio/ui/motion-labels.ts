import type { MotionProperty } from '@/lib/studio/engine/contracts';

export const motionPropertyLabels: Record<MotionProperty, string> = {
  x: 'Position X',
  y: 'Position Y',
  width: 'Width',
  height: 'Height',
  scale: 'Scale',
  tiltX: 'Tilt up/down',
  tiltY: 'Tilt left/right',
  rotateZ: 'Rotation',
  opacity: 'Opacity',
};
