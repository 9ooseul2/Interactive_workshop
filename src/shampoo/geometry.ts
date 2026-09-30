export type Point = { x: number; y: number }
export type Landmark = Point & { z: number }
export type Triangle = [number, number, number]
export type Pose = { origin: Point; right: Point; down: Point; scale: number }
export type Anchor = { triangle: Triangle; weights: [number, number, number]; offset: Point }
export type HeadMask = { width: number; height: number; pixels: Uint8Array; boundary: { point: Point; normal: Point }[] }

export const GRACE_MS = 230
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
export const mix = (a: Point, b: Point, amount: number): Point => ({ x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount })

export function poseOf(face: Point[]): Pose {
  const left = face[234], right = face[454], forehead = face[10]
  const scale = Math.max(.04, distance(left, right))
  const axis = { x: (right.x - left.x) / scale, y: (right.y - left.y) / scale }
  return { origin: forehead, right: axis, down: { x: -axis.y, y: axis.x }, scale }
}

export function localPoint(point: Point, pose: Pose): Point {
  const x = point.x - pose.origin.x, y = point.y - pose.origin.y
  return { x: (x * pose.right.x + y * pose.right.y) / pose.scale, y: (x * pose.down.x + y * pose.down.y) / pose.scale }
}

export function worldPoint(point: Point, pose: Pose): Point {
  return { x: pose.origin.x + (point.x * pose.right.x + point.y * pose.down.x) * pose.scale, y: pose.origin.y + (point.x * pose.right.y + point.y * pose.down.y) * pose.scale }
}

export function barycentric(point: Point, a: Point, b: Point, c: Point): [number, number, number] | null {
  const determinant = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
  if (Math.abs(determinant) < 1e-8) return null
  const u = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / determinant
  const v = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / determinant
  return [u, v, 1 - u - v]
}

export function attach(point: Point, face: Point[], triangles: Triangle[], pose: Pose): Anchor {
  let nearest: Triangle = [10, 127, 356]
  let nearestDistance = Infinity
  for (const triangle of triangles) {
    const a = face[triangle[0]], b = face[triangle[1]], c = face[triangle[2]]
    const weights = barycentric(point, a, b, c)
    if (!weights) continue
    if (Math.min(...weights) >= -.001) return { triangle, weights, offset: { x: 0, y: 0 } }
    const center = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 }
    const nextDistance = distance(point, center)
    if (nextDistance < nearestDistance) { nearestDistance = nextDistance; nearest = triangle }
  }
  const center = nearest.reduce((sum, index) => ({ x: sum.x + face[index].x / 3, y: sum.y + face[index].y / 3 }), { x: 0, y: 0 })
  const local = localPoint(point, pose), localCenter = localPoint(center, pose)
  return { triangle: nearest, weights: [1 / 3, 1 / 3, 1 / 3], offset: { x: local.x - localCenter.x, y: local.y - localCenter.y } }
}

export function resolve(anchor: Anchor, face: Point[], pose: Pose): Point {
  const center = anchor.triangle.reduce((sum, index, offset) => ({ x: sum.x + face[index].x * anchor.weights[offset], y: sum.y + face[index].y * anchor.weights[offset] }), { x: 0, y: 0 })
  return { x: center.x + (anchor.offset.x * pose.right.x + anchor.offset.y * pose.down.x) * pose.scale, y: center.y + (anchor.offset.x * pose.right.y + anchor.offset.y * pose.down.y) * pose.scale }
}

export function pathBetween(start: Point, end: Point, spacing: number): Point[] {
  const count = Math.max(1, Math.ceil(distance(start, end) / Math.max(.001, spacing)))
  return Array.from({ length: count }, (_, index) => mix(start, end, (index + 1) / count))
}

// The actual selfie confidence image is the sole silhouette source. Face
// landmarks only select the forehead cut and the relevant connected region.
export function extractHead(confidence: Float32Array, width: number, height: number, face: Point[], aspect: number): HeadMask | null {
  if (confidence.length !== width * height || face.length < 455) return null
  const pose = poseOf(face)
  const eligible = new Uint8Array(width * height)
  let seed = -1, seedDistance = Infinity
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * width + x
    if (!Number.isFinite(confidence[offset]) || confidence[offset] < .68) continue
    const point = { x: (x + .5) / width * aspect, y: (y + .5) / height }
    const local = localPoint(point, pose)
    if (local.y > .045) continue
    eligible[offset] = 1
    const d = Math.hypot(local.x, local.y + .075)
    if (d < seedDistance) { seed = offset; seedDistance = d }
  }
  if (seed < 0 || seedDistance > .3) return null
  const pixels = new Uint8Array(width * height), queue = new Int32Array(width * height)
  let end = 1
  queue[0] = seed; pixels[seed] = 1
  for (let start = 0; start < end; start++) {
    const offset = queue[start], x = offset % width, y = Math.floor(offset / width)
    const neighbors = [x > 0 ? offset - 1 : -1, x + 1 < width ? offset + 1 : -1, y > 0 ? offset - width : -1, y + 1 < height ? offset + width : -1]
    neighbors.forEach(next => { if (next >= 0 && eligible[next] && !pixels[next]) { pixels[next] = 1; queue[end++] = next } })
  }
  if (end < 20) return null
  const sample = (x: number, y: number) => x < 0 || x >= width || y < 0 || y >= height ? 0 : pixels[y * width + x]
  const boundary: HeadMask['boundary'] = []
  for (let index = 0; index < end; index++) {
    const offset = queue[index], x = offset % width, y = Math.floor(offset / width)
    if (sample(x - 1, y) && sample(x + 1, y) && sample(x, y - 1) && sample(x, y + 1)) continue
    const point = { x: (x + .5) / width * aspect, y: (y + .5) / height }
    if (localPoint(point, pose).y > -.005) continue
    const dx = (sample(x - 2, y) - sample(x + 2, y)) * width / aspect
    const dy = (sample(x, y - 2) - sample(x, y + 2)) * height
    const length = Math.hypot(dx, dy)
    if (length) boundary.push({ point, normal: { x: dx / length, y: dy / length } })
  }
  return boundary.length ? { width, height, pixels, boundary } : null
}

export type Gesture = 'open' | 'pinch'
export function classifyHand(hand: Point[], prior: Gesture): Gesture {
  const palm = Math.max(.015, distance(hand[0], hand[9]))
  if (distance(hand[4], hand[8]) / palm < (prior === 'pinch' ? .43 : .3)) return 'pinch'
  return 'open'
}
