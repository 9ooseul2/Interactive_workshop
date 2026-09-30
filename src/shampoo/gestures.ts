import { classifyHand, distance, GRACE_MS, mix, pathBetween } from './geometry.ts'
import type { Gesture, Point } from './geometry.ts'

export type HandObservation = { label: string; points: Point[] }
type State = { label: string; wrist: Point; gesture: Gesture; active: boolean; seenAt: number; point: Point }
export type Stamp = (point: Point) => void

export class ShampooGestures {
  private states: State[] = []
  reset() { this.states = [] }
  active(now: number) { return this.states.some(state => state.active && now - state.seenAt <= GRACE_MS) }
  update(observations: HandObservation[], now: number, faceScale: number, isOnFaceOrScalp: (point: Point) => boolean, stamp: Stamp) {
    this.states = this.states.filter(state => now - state.seenAt <= GRACE_MS)
    const available = new Set(this.states)
    observations.slice(0, 2).forEach(hand => {
      if (hand.points.length < 21) return
      const wrist = hand.points[0]
      let state: State | undefined = [...available].sort((a, b) => (distance(a.wrist, wrist) + (a.label === hand.label ? 0 : .05)) - (distance(b.wrist, wrist) + (b.label === hand.label ? 0 : .05)))[0]
      if (state && distance(state.wrist, wrist) > .55) state = undefined
      const gesture = classifyHand(hand.points, state?.gesture ?? 'open')
      const point = mix(hand.points[4], hand.points[8], .5)
      if (!state) {
        state = { label: hand.label, wrist, gesture: 'open', active: false, seenAt: now, point }
        this.states.push(state)
      }
      available.delete(state)
      if (state.gesture !== gesture) {
        state.active = false; state.point = point
      }
      state.gesture = gesture; state.wrist = wrist; state.label = hand.label; state.seenAt = now
      // The complete hand is still tracked for stable matching, but only a
      // thumb/index pinch can begin or continue a bubble stroke.
      if (gesture === 'open') return
      if (!state.active) {
        if (!isOnFaceOrScalp(point)) return
        state.active = true; state.point = point
        stamp(point)
        return
      }
      const spacing = faceScale * .027
      if (distance(state.point, point) >= spacing) {
        const points = pathBetween(state.point, point, spacing)
        points.forEach(stamp)
        state.point = point
      }
    })
  }
}
