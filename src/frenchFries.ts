import type { FaceLandmarker, HandLandmarker } from '@mediapipe/tasks-vision'
import './frenchFries.css'

type Point = { x: number; y: number }
type Landmark = Point & { z: number }
type FryState = 'grabbed' | 'eating' | 'whiskerAttached' | 'removed'
type Side = 'left' | 'right' | 'none'
type FryOrientation = 'vertical' | 'horizontal'

type Fry = {
  id: string
  state: FryState
  position: Point
  rotation: number
  length: number
  biteCount: number
  attachedSide: Side
  slotIndex: number
  visible: boolean
  orientation: FryOrientation
  grabbedBy: string | null
  biteStartedAt: number | null
}

type Hand = {
  handedness: string
  palm: Point
  palmSize: number
  pinch: Point | null
  openPalm: boolean
  extendedFingers: number
  orientation: number
}

type Face = {
  mouth: Point
  mouthOpen: boolean
  nose: Point
  leftEdge: Point
  rightEdge: Point
  forehead: Point
  width: number
  angle: number
}

type ResetGesture = {
  joinedStartedAt: number | null
  cooldownUntil: number
}

type VideoViewport = { x: number; y: number; width: number; height: number }

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const HAND_MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const FACE_MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const CAMERA_VIEW_SCALE = .88
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)) }
function distance(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y) }
function lerp(a: number, b: number, amount: number) { return a + (b - a) * amount }
function lerpPoint(a: Point, b: Point, amount: number): Point { return { x: lerp(a.x, b.x, amount), y: lerp(a.y, b.y, amount) } }
function normalizeAngle(value: number) {
  let angle = value
  while (angle > Math.PI) angle -= Math.PI * 2
  while (angle < -Math.PI) angle += Math.PI * 2
  return angle
}
function lerpAngle(from: number, to: number, amount: number) { return from + normalizeAngle(to - from) * amount }
function midpoint(a: Point, b: Point): Point { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
function average(points: Point[]): Point {
  const total = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 })
  return { x: total.x / points.length, y: total.y / points.length }
}

export function setupFrenchFries(host: HTMLElement, isActive: () => boolean) {
  host.innerHTML = `
    <div class="french-fries-stage">
      <div class="french-fries-camera-frame">
        <video class="french-fries-camera" autoplay muted playsinline></video>
        <canvas class="french-fries-canvas" aria-label="FrenchFries 웹캠 증강현실"></canvas>
        <div class="french-fries-vignette"></div>
      </div>
      <div class="french-fries-sr-status" role="status" aria-live="polite"><span class="french-fries-status">카메라를 시작해 보세요</span><span class="french-fries-slots"><strong>0</strong></span></div>
      <div class="french-fries-gate"><button type="button" aria-label="카메라 시작"></button></div>
    </div>`

  const cameraFrame = host.querySelector<HTMLElement>('.french-fries-camera-frame')!
  const video = host.querySelector<HTMLVideoElement>('.french-fries-camera')!
  const canvas = host.querySelector<HTMLCanvasElement>('.french-fries-canvas')!
  const context = canvas.getContext('2d')!
  const gate = host.querySelector<HTMLElement>('.french-fries-gate')!
  const startButton = gate.querySelector<HTMLButtonElement>('button')!
  const status = host.querySelector<HTMLElement>('.french-fries-status')!
  const whiskerCount = host.querySelector<HTMLElement>('.french-fries-slots strong')!
  const paperBagImage = new Image()
  const fryImage = new Image()
  const cartonImage = new Image()
  paperBagImage.src = '/french-fries/paper-bag-cat-hat.png'
  fryImage.src = '/french-fries/thick-fry.png'
  cartonImage.src = '/french-fries/wide-fry-carton.png'

  let handTracker: HandLandmarker | null = null
  let handLoading: Promise<HandLandmarker> | null = null
  let faceTracker: FaceLandmarker | null = null
  let faceLoading: Promise<FaceLandmarker> | null = null
  let stream: MediaStream | null = null
  let running = false
  let frame = 0
  let stageRect = cameraFrame.getBoundingClientRect()
  let pixelRatio = 1
  let lastHandVideoTime = -1
  let lastFaceVideoTime = -1
  let lastFaceAt = 0
  let face: Face | null = null
  let rightHand: Hand | null = null
  let leftHand: Hand | null = null
  let previousRightPinching = false
  let grabbedFryId: string | null = null
  let previousMouthOpen = false
  let biteReady = true
  let biteLockedUntil = 0
  let previousLeftOrientation: number | null = null
  let previousLeftCenter: Point | null = null
  let leftTurnLockedUntil = 0
  let statusText = ''
  const smoothPoints = new Map<string, Point>()
  const fries: Fry[] = []
  const resetGesture: ResetGesture = { joinedStartedAt: null, cooldownUntil: 0 }
  const resizeObserver = new ResizeObserver(() => {
    stageRect = cameraFrame.getBoundingClientRect()
    resizeCanvas()
  })
  resizeObserver.observe(cameraFrame)

  function setStatus(text: string, state: 'ready' | 'active' | 'error' = 'ready') {
    if (statusText === text && host.dataset.frenchFriesState === state) return
    statusText = text
    status.textContent = text
    host.dataset.frenchFriesState = state
  }

  function clearResetGesture() {
    resetGesture.joinedStartedAt = null
    resetGesture.cooldownUntil = 0
  }

  function videoViewport(): VideoViewport {
    const videoAspect = video.videoWidth / Math.max(video.videoHeight, 1)
    const frameAspect = stageRect.width / Math.max(stageRect.height, 1)
    const containedWidth = frameAspect > videoAspect ? stageRect.height * videoAspect : stageRect.width
    const containedHeight = frameAspect > videoAspect ? stageRect.height : stageRect.width / videoAspect
    const width = containedWidth * CAMERA_VIEW_SCALE
    const height = containedHeight * CAMERA_VIEW_SCALE
    return {
      x: (stageRect.width - width) / 2,
      y: (stageRect.height - height) / 2,
      width,
      height,
    }
  }

  function screenPoint(landmark: Landmark): Point {
    // This mirrors the zoomed-out contained-video calculation so landmarks and
    // overlays stay precisely aligned with the un-cropped camera image.
    const viewport = videoViewport()
    return {
      x: viewport.x + (1 - landmark.x) * viewport.width,
      y: viewport.y + landmark.y * viewport.height,
    }
  }

  function smoothPoint(key: string, point: Point, amount = .35): Point {
    const previous = smoothPoints.get(key)
    const next = previous ? lerpPoint(previous, point, amount) : point
    smoothPoints.set(key, next)
    return next
  }

  function cupCenter() { return { x: stageRect.width * .5, y: stageRect.height } }
  function cupScale() { return clamp(Math.min(stageRect.width, stageRect.height) / 700, .72, 1.22) }
  function cartonBounds() {
    // The carton is twice as wide, while the baked-in fries stay compact and
    // increase in count rather than being stretched with the package.
    const width = 480 * cupScale() * 1.6 * .8
    const height = width * (cartonImage.naturalHeight / Math.max(cartonImage.naturalWidth, 1))
    const center = cupCenter()
    return { x: center.x - width / 2, y: stageRect.height - height * .85, width, height }
  }

  function inCartonPickupArea(point: Point) {
    const bounds = cartonBounds()
    return point.x > bounds.x - bounds.width * .04 && point.x < bounds.x + bounds.width * 1.04
      && point.y > bounds.y && point.y < bounds.y + bounds.height * .64
  }

  function makeFries() {
    fries.splice(0, fries.length)
    grabbedFryId = null
    previousRightPinching = false
    previousMouthOpen = false
    biteReady = true
    biteLockedUntil = 0
    whiskerCount.textContent = '0'
  }

  function resizeCanvas() {
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.round(stageRect.width * pixelRatio))
    canvas.height = Math.max(1, Math.round(stageRect.height * pixelRatio))
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  }

  function updateFaceTracking(now: number) {
    if (!faceTracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastFaceVideoTime || now - lastFaceAt < 55) return
    lastFaceVideoTime = video.currentTime
    lastFaceAt = now
    const result = faceTracker.detectForVideo(video, now)
    const landmarks = result.faceLandmarks[0] as Landmark[] | undefined
    if (!landmarks) {
      face = null
      smoothPoints.clear()
      return
    }

    const rawLeft = screenPoint(landmarks[234])
    const rawRight = screenPoint(landmarks[454])
    const [leftEdge, rightEdge] = rawLeft.x <= rawRight.x ? [rawLeft, rawRight] : [rawRight, rawLeft]
    const mouthTop = screenPoint(landmarks[13])
    const mouthBottom = screenPoint(landmarks[14])
    const mouthLeft = screenPoint(landmarks[61])
    const mouthRight = screenPoint(landmarks[291])
    const faceWidth = Math.max(1, distance(leftEdge, rightEdge))
    const mouthWidth = Math.max(1, distance(mouthLeft, mouthRight))
    const mouthOpening = distance(mouthTop, mouthBottom)
    const jawOpen = Math.max(...(result.faceBlendshapes[0]?.categories ?? [])
      .filter((shape) => shape.categoryName === 'jawOpen')
      .map((shape) => shape.score), 0)
    const stableLeft = smoothPoint('face-left', leftEdge)
    const stableRight = smoothPoint('face-right', rightEdge)
    face = {
      mouth: smoothPoint('mouth', midpoint(mouthTop, mouthBottom)),
      mouthOpen: mouthOpening / mouthWidth > .26 || jawOpen > .22,
      nose: smoothPoint('nose', screenPoint(landmarks[1])),
      leftEdge: stableLeft,
      rightEdge: stableRight,
      forehead: smoothPoint('forehead', screenPoint(landmarks[10])),
      width: distance(stableLeft, stableRight) || faceWidth,
      angle: Math.atan2(stableRight.y - stableLeft.y, stableRight.x - stableLeft.x),
    }
  }

  function handOpenness(landmarks: Landmark[], palm: Point) {
    const tips = [4, 8, 12, 16, 20].map((index) => screenPoint(landmarks[index]))
    const joints = [3, 6, 10, 14, 18].map((index) => screenPoint(landmarks[index]))
    const extended = tips.filter((tip, index) => distance(tip, palm) > distance(joints[index], palm) * 1.22).length
    const fingerSpread = distance(tips[1], tips[3])
    return {
      extended,
      openPalm: extended >= 4 && fingerSpread > Math.min(stageRect.width, stageRect.height) * .09,
    }
  }

  function updateHandTracking(now: number) {
    if (!handTracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastHandVideoTime) return
    lastHandVideoTime = video.currentTime
    const result = handTracker.detectForVideo(video, now)
    const hands: Hand[] = result.landmarks.slice(0, 2).map((raw, index) => {
      const landmarks = raw as Landmark[]
      const palmLandmarks = [0, 5, 9, 13, 17].map((landmarkIndex) => screenPoint(landmarks[landmarkIndex]))
      const palm = average(palmLandmarks)
      const thumb = screenPoint(landmarks[4])
      const indexTip = screenPoint(landmarks[8])
      const middleKnuckle = screenPoint(landmarks[9])
      const wrist = screenPoint(landmarks[0])
      const pinchDistance = distance(thumb, indexTip)
      const scale = Math.max(distance(wrist, middleKnuckle), 1)
      const openness = handOpenness(landmarks, palm)
      return {
        handedness: result.handedness[index]?.[0]?.categoryName ?? `hand-${index}`,
        palm,
        palmSize: scale,
        pinch: pinchDistance < scale * .58 ? midpoint(thumb, indexTip) : null,
        openPalm: openness.openPalm,
        extendedFingers: openness.extended,
        orientation: Math.atan2(middleKnuckle.y - wrist.y, middleKnuckle.x - wrist.x),
      }
    })

    rightHand = hands.find((hand) => hand.handedness === 'Right') ?? null
    leftHand = hands.find((hand) => hand.handedness === 'Left') ?? null
    updateLeftRotation(now)
    updateResetGesture(now)
  }

  function updateLeftRotation(now: number) {
    if (!leftHand?.openPalm) {
      previousLeftOrientation = null
      previousLeftCenter = null
      return
    }
    const previousAngle = previousLeftOrientation
    const previousCenter = previousLeftCenter
    previousLeftOrientation = leftHand.orientation
    previousLeftCenter = leftHand.palm
    if (previousAngle === null || now < leftTurnLockedUntil || !grabbedFryId) return
    const angleDelta = normalizeAngle(leftHand.orientation - previousAngle)
    const movedLeft = Boolean(previousCenter && leftHand.palm.x < previousCenter.x - 7)
    // Camera mirroring reverses the mathematical sign of a clockwise turn, so either
    // clear counter-clockwise angular movement or a leftward open-palm twist is accepted.
    if (Math.abs(angleDelta) > .19 && (angleDelta > 0 || movedLeft)) {
      const fry = fries.find((item) => item.id === grabbedFryId)
      if (fry && fry.state === 'grabbed' && fry.orientation === 'vertical') {
        fry.orientation = 'horizontal'
        leftTurnLockedUntil = now + 700
        setStatus('왼손 회전을 감지했어요. 볼 옆에 감튀 수염을 붙여 보세요!', 'active')
      }
    }
  }

  function updateResetGesture(now: number) {
    // In a real prayer pose the palms face each other, so the camera may see
    // a narrower finger spread than an open palm facing the lens. Accept three
    // clearly extended fingers per hand here while keeping the rotation gesture
    // on the stricter open-palm rule.
    const bothHandsOpen = (rightHand?.extendedFingers ?? 0) >= 3 && (leftHand?.extendedFingers ?? 0) >= 3
    if (!rightHand || !leftHand || !bothHandsOpen || now < resetGesture.cooldownUntil) {
      resetGesture.joinedStartedAt = null
      return
    }
    const joinedThreshold = Math.max(
      Math.min(stageRect.width, stageRect.height) * .18,
      (rightHand.palmSize + leftHand.palmSize) * .8,
    )
    const joined = distance(rightHand.palm, leftHand.palm) < joinedThreshold
    if (!joined) {
      resetGesture.joinedStartedAt = null
      return
    }
    resetGesture.joinedStartedAt ??= now
    if (now - resetGesture.joinedStartedAt >= 200) {
      resetAll('합장 제스처를 감지했어요. 감튀 수염을 모두 정리했어요!')
      resetGesture.cooldownUntil = now + 900
    }
  }

  function grabFry(fry: Fry, pinch: Point) {
    fry.state = 'grabbed'
    fry.position = { ...pinch }
    fry.rotation = 0
    fry.orientation = 'vertical'
    fry.grabbedBy = 'Right'
    fry.attachedSide = 'none'
    fry.slotIndex = -1
    grabbedFryId = fry.id
    setStatus('감튀를 집었어요. 입으로 가져가거나 왼손을 돌려 보세요.', 'active')
  }

  function spawnFry(pinch: Point) {
    const index = fries.length + 1
    const fry: Fry = {
      id: `fry-${index}`,
      state: 'grabbed',
      position: { ...pinch },
      rotation: 0,
      length: (100 + (index % 3) * 7) * cupScale() * .8,
      biteCount: 0,
      attachedSide: 'none',
      slotIndex: -1,
      visible: true,
      orientation: 'vertical',
      grabbedBy: 'Right',
      biteStartedAt: null,
    }
    fries.push(fry)
    grabFry(fry, pinch)
  }

  function updateGrab(now: number) {
    const rightPinch = rightHand?.pinch ?? null
    const fry = fries.find((item) => item.id === grabbedFryId)
    if (fry && (fry.state === 'grabbed' || fry.state === 'eating')) {
      if (rightPinch && fry.state === 'grabbed') {
        fry.position = lerpPoint(fry.position, rightPinch, .62)
        const targetRotation = fry.orientation === 'horizontal' ? Math.PI / 2 : 0
        fry.rotation = lerpAngle(fry.rotation, targetRotation, .22)
        if (fry.orientation === 'horizontal') tryAttachWhisker(fry)
      }
    }

    if (!grabbedFryId && rightPinch && !previousRightPinching && inCartonPickupArea(rightPinch)) spawnFry(rightPinch)
    previousRightPinching = Boolean(rightPinch)
    updateBiting(now)
  }

  function cheekAnchor(side: 'left' | 'right', slotIndex: number): Point | null {
    if (!face) return null
    const center = face.nose
    const edge = side === 'left' ? face.leftEdge : face.rightEdge
    const position = lerpPoint(center, edge, .53)
    const normal = { x: Math.cos(face.angle + Math.PI / 2), y: Math.sin(face.angle + Math.PI / 2) }
    const verticalOffset = (slotIndex === 0 ? -.095 : .095) * face.width
    return { x: position.x + normal.x * verticalOffset, y: position.y + normal.y * verticalOffset + face.width * .07 }
  }

  function availableSlot(side: 'left' | 'right') {
    const used = new Set(fries.filter((fry) => fry.state === 'whiskerAttached' && fry.attachedSide === side).map((fry) => fry.slotIndex))
    return [0, 1].find((slot) => !used.has(slot)) ?? -1
  }

  function tryAttachWhisker(fry: Fry) {
    if (!face || fry.state !== 'grabbed') return
    const targets = (['left', 'right'] as const).map((side) => ({
      side,
      distance: Math.min(...[0, 1].map((slot) => distance(fry.position, cheekAnchor(side, slot)!))),
    })).sort((first, second) => first.distance - second.distance)
    const nearest = targets[0]
    if (!nearest || nearest.distance > Math.max(72, face.width * .34)) return
    const slot = availableSlot(nearest.side)
    if (slot < 0) {
      setStatus('이쪽 수염은 이미 두 개예요. 감튀는 계속 손에 들고 있어요.', 'active')
      return
    }
    const anchor = cheekAnchor(nearest.side, slot)
    if (!anchor) return
    fry.state = 'whiskerAttached'
    fry.position = anchor
    fry.attachedSide = nearest.side
    fry.slotIndex = slot
    fry.grabbedBy = null
    const slotTilt = slot === 0 ? .25 : -.25
    fry.rotation = face.angle + (nearest.side === 'left' ? -Math.PI / 2 + slotTilt : Math.PI / 2 - slotTilt)
    grabbedFryId = null
    whiskerCount.textContent = String(fries.filter((item) => item.state === 'whiskerAttached').length)
    setStatus(`${nearest.side === 'left' ? '왼쪽' : '오른쪽'} 볼에 감튀 수염을 붙였어요!`, 'active')
  }

  function bitePoint(fry: Fry): Point {
    const missing = fry.length * (fry.biteCount / 3)
    const top = -fry.length / 2 + missing
    return {
      x: fry.position.x + Math.sin(fry.rotation) * -top,
      y: fry.position.y + Math.cos(fry.rotation) * top,
    }
  }

  function updateBiting(now: number) {
    const fry = fries.find((item) => item.id === grabbedFryId)
    if (!fry || !face) {
      previousMouthOpen = Boolean(face?.mouthOpen)
      return
    }
    if (!face.mouthOpen && now >= biteLockedUntil) biteReady = true
    const closeEnough = Math.min(distance(fry.position, face.mouth), distance(bitePoint(fry), face.mouth)) < Math.max(64, face.width * .3)
    const mouthOpenedNow = face.mouthOpen && !previousMouthOpen
    if (fry.state === 'grabbed' && mouthOpenedNow && biteReady && closeEnough && now >= biteLockedUntil) {
      fry.state = 'eating'
      fry.biteCount += 1
      fry.biteStartedAt = now
      biteReady = false
      biteLockedUntil = now + 460
      setStatus(`${fry.biteCount}번째 한 입! 입을 닫았다가 다시 벌리면 다음 한 입이에요.`, 'active')
    }
    previousMouthOpen = face.mouthOpen
  }

  function updateFries(now: number) {
    fries.forEach((fry) => {
      if (fry.state === 'eating' && fry.biteStartedAt !== null && now - fry.biteStartedAt > 250) {
        if (fry.biteCount >= 3) {
          fry.state = 'removed'
          fry.visible = false
          fry.grabbedBy = null
          grabbedFryId = null
          setStatus('마지막 한 입까지 냠! 감튀가 사라졌어요.', 'active')
        } else {
          fry.state = 'grabbed'
          fry.biteStartedAt = null
        }
      }
      if (fry.state === 'whiskerAttached' && (fry.attachedSide === 'left' || fry.attachedSide === 'right')) {
        const anchor = cheekAnchor(fry.attachedSide, fry.slotIndex)
        if (anchor && face) {
          fry.position = lerpPoint(fry.position, anchor, .48)
          const slotTilt = fry.slotIndex === 0 ? .25 : -.25
          const direction = fry.attachedSide === 'left' ? -Math.PI / 2 + slotTilt : Math.PI / 2 - slotTilt
          fry.rotation = lerpAngle(fry.rotation, face.angle + direction, .32)
        }
      }
    })
  }

  function drawVideoContain() {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return
    const viewport = videoViewport()
    context.save()
    context.fillStyle = '#160c05'
    context.fillRect(0, 0, stageRect.width, stageRect.height)
    context.translate(stageRect.width, 0)
    context.scale(-1, 1)
    context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, viewport.x, viewport.y, viewport.width, viewport.height)
    context.restore()
  }

  function drawSkinSoftening() {
    if (!face || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return
    const viewport = videoViewport()
    const faceCenter = midpoint(face.leftEdge, face.rightEdge)

    // A very light, face-only second pass softens skin texture without
    // affecting hands, the background, or the tracked fry illustrations.
    context.save()
    context.beginPath()
    context.ellipse(
      faceCenter.x,
      faceCenter.y + face.width * .1,
      face.width * .5,
      face.width * .59,
      face.angle,
      0,
      Math.PI * 2,
    )
    context.clip()
    context.globalAlpha = .25
    context.filter = 'blur(.8px) brightness(1.025) saturate(.96)'
    context.translate(stageRect.width, 0)
    context.scale(-1, 1)
    context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, viewport.x, viewport.y, viewport.width, viewport.height)
    context.restore()
  }

  function drawPaperBag() {
    if (!face || !paperBagImage.complete || !paperBagImage.naturalWidth) return
    const width = face.width * 1.63 * .9
    const height = width * (paperBagImage.naturalHeight / paperBagImage.naturalWidth)
    context.save()
    context.translate(face.forehead.x, face.forehead.y - face.width * .05)
    context.rotate(face.angle)
    context.shadowColor = 'rgba(22, 9, 2, .38)'
    context.shadowBlur = 13
    context.shadowOffsetY = 6
    context.beginPath()
    context.moveTo(-width * .5, -height * .72)
    context.lineTo(width * .5, -height * .72)
    context.lineTo(width * .5, height * .11)
    context.quadraticCurveTo(0, -height * .09, -width * .5, height * .11)
    context.closePath()
    context.clip()
    context.drawImage(paperBagImage, -width / 2, -height * .72, width, height)
    context.restore()
  }

  function drawCarton() {
    if (!cartonImage.complete || !cartonImage.naturalWidth) return
    const bounds = cartonBounds()
    context.save()
    context.shadowColor = 'rgba(24, 5, 1, .43)'
    context.shadowBlur = 18
    context.shadowOffsetY = 8
    context.drawImage(cartonImage, bounds.x, bounds.y, bounds.width, bounds.height)
    context.restore()
  }

  function drawFry(fry: Fry, now: number) {
    if (!fry.visible || fry.state === 'removed' || !fryImage.complete || !fryImage.naturalWidth) return
    const missing = fry.length * (fry.biteCount / 3)
    const visibleLength = Math.max(7, fry.length - missing)
    const width = clamp(fry.length * .378, 27.4, 38.9)
    const top = -fry.length / 2 + missing
    const biting = fry.state === 'eating' && fry.biteStartedAt !== null
    const chew = biting ? Math.sin((now - fry.biteStartedAt!) / 250 * Math.PI) * 4 : 0
    context.save()
    context.translate(fry.position.x, fry.position.y)
    context.rotate(fry.rotation)
    context.translate(chew, 0)
    context.shadowColor = fry.state === 'whiskerAttached' ? 'rgba(20, 8, 2, .42)' : 'rgba(27, 12, 2, .34)'
    context.shadowBlur = fry.state === 'whiskerAttached' ? 8 : 6
    context.shadowOffsetY = 3
    const sourceTop = fryImage.naturalHeight * (fry.biteCount / 3)
    const sourceHeight = fryImage.naturalHeight - sourceTop
    context.drawImage(fryImage, 0, sourceTop, fryImage.naturalWidth, sourceHeight, -width / 2, top, width, visibleLength)
    context.restore()
    if (biting && face) drawBiteCrumbs(face.mouth, now - fry.biteStartedAt!)
  }

  function drawBiteCrumbs(mouth: Point, elapsed: number) {
    const progress = clamp(elapsed / 250, 0, 1)
    context.save()
    context.fillStyle = `rgba(255, 204, 89, ${1 - progress})`
    for (let index = 0; index < 5; index += 1) {
      const angle = index * 1.35 + .4
      const travel = 10 + progress * 25
      context.beginPath()
      context.arc(mouth.x + Math.cos(angle) * travel, mouth.y + Math.sin(angle) * travel, 2.7 - progress, 0, Math.PI * 2)
      context.fill()
    }
    context.restore()
  }

  function render(now: number) {
    if (!running || !isActive()) return
    updateFaceTracking(now)
    updateHandTracking(now)
    updateGrab(now)
    updateFries(now)
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    context.clearRect(0, 0, stageRect.width, stageRect.height)
    drawVideoContain()
    drawSkinSoftening()
    drawPaperBag()
    drawCarton()
    fries.forEach((fry) => drawFry(fry, now))
    frame = requestAnimationFrame(render)
  }

  async function ensureHandTracker() {
    if (handTracker) return handTracker
    handLoading ??= (async () => {
      const { FilesetResolver, HandLandmarker: Class } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
      handTracker = await Class.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_PATH },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: .58,
        minHandPresenceConfidence: .55,
        minTrackingConfidence: .55,
      })
      return handTracker
    })()
    try { return await handLoading } catch (error) { handLoading = null; throw error }
  }

  async function ensureFaceTracker() {
    if (faceTracker) return faceTracker
    faceLoading ??= (async () => {
      const { FilesetResolver, FaceLandmarker: Class } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
      faceTracker = await Class.createFromOptions(vision, {
        baseOptions: { modelAssetPath: FACE_MODEL_PATH },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        minFaceDetectionConfidence: .55,
        minFacePresenceConfidence: .55,
        minTrackingConfidence: .55,
      })
      return faceTracker
    })()
    try { return await faceLoading } catch (error) { faceLoading = null; throw error }
  }

  async function activate() {
    if (running) return
    try {
      setStatus('카메라를 준비하고 있어요')
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      video.srcObject = stream
      await video.play()
      if (!isActive()) { deactivate(); return }
      stageRect = cameraFrame.getBoundingClientRect()
      resizeCanvas()
      makeFries()
      running = true
      host.classList.add('camera-ready')
      gate.classList.add('hidden')
      setStatus('손과 얼굴을 찾고 있어요')
      frame = requestAnimationFrame(render)
      void ensureHandTracker().then(() => {
        if (running) setStatus('오른손 핀치로 컵의 감튀를 집어 보세요.', 'active')
      }).catch(() => {
        if (running) setStatus('손 추적을 시작하지 못했어요.', 'error')
      })
      void ensureFaceTracker().then(() => {
        if (running && !face) setStatus('얼굴도 카메라 안에 보여 주세요.', 'active')
      }).catch(() => {
        if (running) setStatus('얼굴 추적을 시작하지 못했어요.', 'error')
      })
    } catch {
      setStatus('카메라 권한이 필요해요.', 'error')
      gate.classList.remove('hidden')
    }
  }

  function deactivate() {
    running = false
    cancelAnimationFrame(frame)
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    video.pause()
    video.srcObject = null
    lastHandVideoTime = -1
    lastFaceVideoTime = -1
    lastFaceAt = 0
    face = null
    rightHand = null
    leftHand = null
    grabbedFryId = null
    previousRightPinching = false
    previousLeftOrientation = null
    previousLeftCenter = null
    smoothPoints.clear()
    clearResetGesture()
    host.classList.remove('camera-ready')
    gate.classList.remove('hidden')
    context.clearRect(0, 0, stageRect.width, stageRect.height)
  }

  function resetAll(message = '새 감튀를 준비했어요. 다시 즐겨 보세요!') {
    makeFries()
    previousLeftOrientation = null
    previousLeftCenter = null
    clearResetGesture()
    setStatus(message, running ? 'active' : 'ready')
  }

  startButton.addEventListener('click', () => { void activate() })
  makeFries()
  resizeCanvas()
  return { activate, deactivate }
}
