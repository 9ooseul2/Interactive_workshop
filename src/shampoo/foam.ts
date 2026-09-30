import { attach, distance, localPoint, poseOf, resolve, worldPoint } from './geometry.ts'
import type { Anchor, HeadMask, Point, Pose, Triangle } from './geometry.ts'

type Bubble = { anchor: Anchor; radius: number; sprite: number; phase: number }
type BaseBubble = { local: Point; normal: Point; radius: number; phase: number; sprite: number }
const random = (value: number) => { const number = Math.sin(value * 127.1 + 311.7) * 43758.5453; return number - Math.floor(number) }

function sprite(variant: number) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 112
  const context = canvas.getContext('2d')!
  const paintBubble = (x: number, y: number, radius: number, hue: number) => {
    const body = context.createRadialGradient(x - radius * .36, y - radius * .42, radius * .04, x, y, radius)
    body.addColorStop(0, 'rgba(255,255,255,.44)')
    body.addColorStop(.2, 'rgba(255,255,255,.13)')
    body.addColorStop(.62, `hsla(${hue}, 78%, 88%, .10)`)
    body.addColorStop(.82, `hsla(${hue + 22}, 72%, 73%, .24)`)
    body.addColorStop(1, 'rgba(255,255,255,.04)')
    context.fillStyle = body
    context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill()

    const rim = context.createLinearGradient(x - radius, y - radius, x + radius, y + radius)
    rim.addColorStop(0, 'rgba(255,255,255,.7)')
    rim.addColorStop(.34, `hsla(${hue}, 90%, 91%, .38)`)
    rim.addColorStop(.7, `hsla(${hue + 35}, 82%, 77%, .48)`)
    rim.addColorStop(1, 'rgba(255,255,255,.28)')
    context.strokeStyle = rim; context.lineWidth = Math.max(1, radius * .065)
    context.beginPath(); context.arc(x, y, radius * .94, 0, Math.PI * 2); context.stroke()
    context.strokeStyle = 'rgba(255,255,255,.28)'; context.lineWidth = Math.max(.65, radius * .035)
    context.beginPath(); context.arc(x, y, radius * .79, Math.PI * 1.05, Math.PI * 1.7); context.stroke()
    context.fillStyle = 'rgba(255,255,255,.62)'
    context.beginPath(); context.ellipse(x - radius * .34, y - radius * .35, radius * .18, radius * .1, -.55, 0, Math.PI * 2); context.fill()
  }
  for (let index = 0; index < 5; index++) {
    const angle = index * 2.399 + variant
    const radius = index === 0 ? 32 : 11 + random(index + variant * 5) * 9
    const x = 56 + (index ? Math.cos(angle) * 22 : 0), y = 56 + (index ? Math.sin(angle) * 22 : 0)
    paintBubble(x, y, radius, 184 + (variant * 17 + index * 11) % 58)
  }
  return canvas
}

export class ShampooFoam {
  private sprites: HTMLCanvasElement[] = []
  private base: BaseBubble[] = []
  private bubbles: Bubble[] = []
  private occupied = new Map<string, Bubble>()
  private mask: { head: HeadMask; pose: Pose; aspect: number } | null = null
  private serial = 0
  clear() { this.sprites = []; this.base = []; this.bubbles = []; this.occupied.clear(); this.mask = null; this.serial = 0 }
  resetStrokes() { this.bubbles = []; this.occupied.clear() }
  setHead(head: HeadMask, face: Point[], aspect: number) {
    const pose = poseOf(face)
    this.mask = { head, pose, aspect }
    const boundary = head.boundary.map(edge => ({ point: localPoint(edge.point, pose), normal: { x: edge.normal.x * pose.right.x + edge.normal.y * pose.right.y, y: edge.normal.x * pose.down.x + edge.normal.y * pose.down.y } }))
    const points = boundary.map(edge => edge.point)
    const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x)), minY = Math.min(...points.map(point => point.y))
    // A wider lattice keeps the silhouette readable once the individual
    // bubbles become visibly different in size.
    const bubbles: BaseBubble[] = [], step = .068
    for (let row = Math.floor(minY / step); row <= 1; row++) for (let column = Math.floor(minX / step) - 1; column <= Math.ceil(maxX / step) + 1; column++) {
      const seed = row * 1031 + column
      const local = { x: (column + (row % 2) * .5 + random(seed) * .22) * step, y: (row + random(seed + 1) * .22) * step }
      if (!this.contains(worldPoint(local, pose))) continue
      let closest = boundary[0], closestDistance = Infinity
      boundary.forEach(edge => { const nextDistance = distance(local, edge.point); if (nextDistance < closestDistance) { closestDistance = nextDistance; closest = edge } })
      // Bias toward medium bubbles, with occasional large ones to avoid a
      // uniform dotted cap over the hair.
      const sizeVariation = Math.pow(random(seed + 2), 1.75)
      bubbles.push({ local, normal: closest.normal, radius: .064 + sizeVariation * .064, phase: random(seed + 3) * Math.PI * 2, sprite: Math.floor(random(seed + 4) * 6) })
    }
    boundary.forEach((edge, index) => {
      if (index % 2) return
      const sizeVariation = Math.pow(random(index + 7), 1.45)
      bubbles.push({ local: { x: edge.point.x + edge.normal.x * .012, y: edge.point.y + edge.normal.y * .012 }, normal: edge.normal, radius: .043 + sizeVariation * .061, phase: random(index + 11) * Math.PI * 2, sprite: index % 6 })
    })
    this.base = bubbles
  }
  contains(point: Point) {
    if (!this.mask) return false
    const { head, aspect } = this.mask
    const x = Math.floor(point.x / aspect * head.width), y = Math.floor(point.y * head.height)
    return x >= 0 && y >= 0 && x < head.width && y < head.height && head.pixels[y * head.width + x] === 1
  }
  stamp(point: Point, face: Point[], triangles: Triangle[]) {
    if (!triangles.length) return
    const pose = poseOf(face), count = 3
    for (let index = 0; index < count; index++) {
      const seed = this.serial++, angle = index * 2.399 + random(seed) * .5
      const spread = .032 * Math.sqrt(index / count) * pose.scale
      const next = { x: point.x + Math.cos(angle) * spread, y: point.y + Math.sin(angle) * spread }
      const local = localPoint(next, pose), key = `${Math.round(local.x / .025)},${Math.round(local.y / .025)}`
      const radius = .022 + random(seed) * .012
      const existing = this.occupied.get(key)
      if (existing) { existing.radius = Math.max(existing.radius, radius); continue }
      if (this.bubbles.length >= 6000) continue
      const bubble = { anchor: attach(next, face, triangles, pose), radius, sprite: seed % 6, phase: random(seed + 31) * Math.PI * 2 }
      this.bubbles.push(bubble); this.occupied.set(key, bubble)
    }
  }
  draw(context: CanvasRenderingContext2D, face: Point[], now: number, project: (point: Point) => Point, pixelScale: number, drawBase: boolean) {
    if (!this.sprites.length) this.sprites = Array.from({ length: 6 }, (_, index) => sprite(index))
    const pose = poseOf(face)
    const draw = (point: Point, radius: number, variant: number, alpha: number) => {
      const projected = project(point), size = radius * pose.scale * pixelScale * 2.6
      context.save(); context.globalAlpha = alpha
      context.drawImage(this.sprites[variant], projected.x - size / 2, projected.y - size / 2, size, size)
      context.restore()
    }
    if (drawBase) this.base.forEach(bubble => {
      const tangent = Math.sin(now * .0013 + bubble.phase) * .008, normal = Math.sin(now * .0019 + bubble.phase * 1.7) * .004
      draw(worldPoint({ x: bubble.local.x - bubble.normal.y * tangent + bubble.normal.x * normal, y: bubble.local.y + bubble.normal.x * tangent + bubble.normal.y * normal }, pose), bubble.radius, bubble.sprite, .72)
    })
    this.bubbles.forEach(bubble => draw(resolve(bubble.anchor, face, pose), bubble.radius, bubble.sprite, .82))
  }
}
