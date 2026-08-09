import { motionDuration } from '@/lib/motion';

describe('motionDuration', () => {
  it('preserves intentional motion when reduced motion is disabled', () => {
    expect(motionDuration(false, 380)).toBe(380);
  });

  it('makes camera changes immediate when reduced motion is enabled', () => {
    expect(motionDuration(true, 380)).toBe(0);
  });
});
