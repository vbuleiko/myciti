/**
 * Smooth, physically plausible motion for a marker that chases an estimated position.
 *
 * The engine's estimate ("target") is honest but jerky: it has one constant speed per
 * segment (minute-precision times), and it jumps whenever a fresh poll moves the bus. A marker
 * that simply eases to the target over a fixed time sprints across any jump and crawls after
 * a backward one. Instead the marker is driven like a vehicle: it never reverses, its speed
 * and acceleration are bounded, and it closes the gap to the target gradually (`gap / tau` on
 * top of the target's own speed). Only a gap too large to be a prediction error is a jump.
 */

export interface FollowerOptions {
  /** catch-up time constant, s: the gap to the target closes at gap/tau m/s */
  tauSec: number;
  /** display speed ceiling, m/s */
  maxSpeedMps: number;
  /** max acceleration, m/s² */
  maxAccelMps2: number;
  /** max deceleration, m/s² */
  maxDecelMps2: number;
  /** a small gap ahead is closed at least this fast (walking pace), so stops are reached, m/s */
  creepMps: number;
  /** a target this far ahead is a different place: jump there */
  snapForwardM: number;
  /** a target this far behind: jump back */
  snapBackM: number;
  /** steps longer than this (tab was hidden) resync instantly, s */
  maxStepSec: number;
}

export const DEFAULT_FOLLOWER_OPTIONS: FollowerOptions = {
  tauSec: 12,
  maxSpeedMps: 30, // 108 km/h: trunk buses on the freeway, nothing faster
  maxAccelMps2: 2,
  maxDecelMps2: 4,
  creepMps: 1.5,
  snapForwardM: 1500,
  snapBackM: 400,
  maxStepSec: 3,
};

export interface FollowerState {
  /** displayed position, metres along the shape */
  pos: number;
  /** displayed speed, m/s */
  speed: number;
  /** time of this state, epoch ms */
  t: number;
}

export function followerStart(
  target: number,
  targetSpeed: number,
  t: number,
  o: FollowerOptions = DEFAULT_FOLLOWER_OPTIONS,
): FollowerState {
  return { pos: target, speed: Math.min(Math.max(0, targetSpeed), o.maxSpeedMps), t };
}

/** Advance the marker to time `t` given the engine's target position and speed at `t`. */
export function followerStep(
  s: FollowerState,
  target: number,
  targetSpeed: number,
  t: number,
  o: FollowerOptions = DEFAULT_FOLLOWER_OPTIONS,
): FollowerState {
  const dt = (t - s.t) / 1000;
  if (!(dt > 0)) return s;
  const gap = target - s.pos;
  if (dt > o.maxStepSec || gap > o.snapForwardM || gap < -o.snapBackM) return followerStart(target, targetSpeed, t, o);

  const vt = Math.max(0, targetSpeed);
  if (vt === 0 && gap >= 0 && gap < 0.05) return { pos: target, speed: 0, t };
  // close the gap exponentially (gap/tau), but never slower than a walking pace for the
  // last metres, and never faster than "the whole gap within a second" (no overshoot)
  const mag = Math.max(Math.abs(gap) / o.tauSec, Math.min(Math.abs(gap), o.creepMps));
  let desired = vt + Math.sign(gap) * mag;
  desired = Math.min(Math.max(desired, 0), o.maxSpeedMps);
  const speed =
    desired > s.speed ? Math.min(s.speed + o.maxAccelMps2 * dt, desired) : Math.max(s.speed - o.maxDecelMps2 * dt, desired);
  let pos = s.pos + speed * dt;
  // a bus that is waiting at a stop is never overtaken by its own marker
  if (vt === 0 && gap >= 0 && pos > target) pos = target;
  return { pos, speed: vt === 0 && pos === target ? 0 : speed, t };
}
