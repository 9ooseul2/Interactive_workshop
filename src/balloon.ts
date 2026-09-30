import type { FaceLandmarker, HandLandmarker } from '@mediapipe/tasks-vision'
import './balloon.css'

type Point = { x: number; y: number }
type Landmark = Point & { z: number }
type Hand = { id: string; index: Point; pinch: Point | null; previousPinch: Point | null }
type Mouth = { center: Point; strength: number }
type Balloon = {
  element: HTMLElement
  string: SVGSVGElement
  stringPath: SVGPathElement
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  height: number
  stringLength: number
  color: string
  phase: number
  scale: number
  grabbedBy: string | null
  alive: boolean
}

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const FACE_MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const COLORS = ['#ff6f8f', '#ffad54', '#ffe367', '#73dfa5', '#73c7ff', '#9c8cff', '#e68fce']

export function setupBalloon(host: HTMLElement, isActive: () => boolean) {
  host.innerHTML = `
    <div class="balloon-stage">
      <video id="balloon-camera" class="balloon-camera" autoplay muted playsinline></video>
      <div class="balloon-tint"></div>
      <div id="balloon-layer" class="balloon-layer" aria-hidden="true"></div>
      <div id="balloon-particles" class="balloon-particles" aria-hidden="true"></div>
      <div class="balloon-title"><span>INTERACTIVE CAMERA / 05</span><strong>BALLOON<br><em>POP</em></strong></div>
      <div class="balloon-guide"><b>INDEX · POP</b><p>검지로 풍선을 터뜨리세요.</p><b>PINCH · HOLD</b><p>엄지와 검지로 끈을 잡으세요.</p></div>
      <div class="balloon-status"><i></i><span id="balloon-status">CAMERA READY</span></div>
      <div class="balloon-gauge" aria-label="풍선 흡입 게이지" style="--gauge:0%"><span>INHALE</span><strong id="balloon-gauge-value">0%</strong><div><i id="balloon-gauge-fill"></i></div><small>POP ALL</small></div>
      <div id="balloon-gate" class="balloon-gate"><p>BALLOON PLAY</p><h1>손끝으로 풍선을<br><em>터뜨려 보세요.</em></h1><button id="balloon-start" type="button">카메라 시작 <span>↗</span></button></div>
    </div>
  `

  const stage = host.querySelector<HTMLElement>('.balloon-stage')!
  const video = host.querySelector<HTMLVideoElement>('#balloon-camera')!
  const layer = host.querySelector<HTMLElement>('#balloon-layer')!
  const particleLayer = host.querySelector<HTMLElement>('#balloon-particles')!
  const status = host.querySelector<HTMLElement>('#balloon-status')!
  const gauge = host.querySelector<HTMLElement>('.balloon-gauge')!
  const gaugeValue = host.querySelector<HTMLElement>('#balloon-gauge-value')!
  const gaugeFill = host.querySelector<HTMLElement>('#balloon-gauge-fill')!
  const gate = host.querySelector<HTMLElement>('#balloon-gate')!
  const startButton = host.querySelector<HTMLButtonElement>('#balloon-start')!

  let tracker: HandLandmarker | null = null
  let trackerLoading: Promise<HandLandmarker> | null = null
  let faceTracker: FaceLandmarker | null = null
  let faceTrackerLoading: Promise<FaceLandmarker> | null = null
  let stream: MediaStream | null = null
  let running = false
  let frameId = 0
  let lastTime = performance.now()
  let lastVideoTime = -1
  let lastFaceVideoTime = -1
  let lastFaceDetectionAt = 0
  let stageRect = stage.getBoundingClientRect()
  let spawnAt = 0
  let liveBalloonCount = 0
  let inhaleGauge = 0
  let burstingAll = false
  let balloons: Balloon[] = []
  let hands: Hand[] = []
  let mouth: Mouth | null = null
  const pinchingHands = new Map<string, Hand>()
  const lastPinches = new Map<string, Point>()
  const resizeObserver = new ResizeObserver(() => { stageRect = stage.getBoundingClientRect() })
  resizeObserver.observe(stage)

  function setStatus(text: string, state: 'ready' | 'active' | 'error' = 'ready') {
    status.textContent = text
    host.dataset.balloonState = state
  }

  function screenPoint(landmark: Landmark): Point {
    const videoAspect = video.videoWidth / Math.max(video.videoHeight, 1)
    const stageAspect = stageRect.width / Math.max(stageRect.height, 1)
    let x = 1 - landmark.x
    let y = landmark.y
    if (stageAspect > videoAspect) {
      const renderedHeight = stageRect.width / videoAspect
      y = (y * renderedHeight - (renderedHeight - stageRect.height) / 2) / stageRect.height
    } else {
      const renderedWidth = stageRect.height * videoAspect
      x = (x * renderedWidth - (renderedWidth - stageRect.width) / 2) / stageRect.width
    }
    return { x: x * stageRect.width, y: y * stageRect.height }
  }

  function createBalloon() {
    const radius = 29 + Math.random() * 30
    const height = radius * 1.22
    const color = COLORS[Math.floor(Math.random() * COLORS.length)]
    const element = document.createElement('div')
    element.className = 'floating-balloon'
    element.style.setProperty('--balloon-color', color)
    element.innerHTML = '<div class="balloon-shape"><i></i></div><b class="balloon-knot"></b>'
    const string = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    string.setAttribute('class', 'balloon-string')
    string.setAttribute('aria-hidden', 'true')
    const stringPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    stringPath.setAttribute('class', 'balloon-string-path')
    string.append(stringPath)
    layer.append(string, element)
    liveBalloonCount += 1
    balloons.push({
      element, string, x: radius + Math.random() * Math.max(1, stageRect.width - radius * 2),
      y: stageRect.height + height, vx: (Math.random() - .5) * 12, vy: -(20 + Math.random() * 26),
      radius, height, stringLength: 88 + Math.random() * 44, color, phase: Math.random() * Math.PI * 2,
      scale: 1, stringPath, grabbedBy: null, alive: true,
    })
  }

  function removeBalloon(balloon: Balloon) {
    if (!balloon.alive) return
    balloon.alive = false
    liveBalloonCount -= 1
    balloon.element.remove()
    balloon.string.remove()
  }

  function renderGauge() {
    const value = Math.round(inhaleGauge)
    gauge.style.setProperty('--gauge', `${value}%`)
    gaugeFill.style.height = `${value}%`
    gaugeValue.textContent = `${value}%`
  }

  function burstAllBalloons() {
    if (burstingAll) return
    burstingAll = true
    balloons.forEach((balloon) => {
      if (balloon.alive) popBalloon(balloon)
    })
    inhaleGauge = 0
    renderGauge()
    gauge.classList.add('burst-ready')
    setStatus('BALLOON RAIN!', 'active')
    window.setTimeout(() => {
      burstingAll = false
      gauge.classList.remove('burst-ready')
      if (running) setStatus('INDEX / PINCH READY', 'active')
    }, 720)
  }

  function inhaleBalloon(balloon: Balloon) {
    if (!balloon.alive) return
    removeBalloon(balloon)
    inhaleGauge = Math.min(100, inhaleGauge + 7 + (balloon.radius - 29) * .24)
    renderGauge()
    if (inhaleGauge >= 100) burstAllBalloons()
  }

  function popBalloon(balloon: Balloon) {
    if (!balloon.alive) return
    const originX = balloon.x
    const originY = balloon.y
    for (let index = 0; index < 16; index += 1) {
      const particle = document.createElement('i')
      const angle = (Math.PI * 2 * index) / 16 + Math.random() * .24
      const distance = 42 + Math.random() * 80
      particle.className = 'balloon-piece'
      particle.style.left = `${originX}px`
      particle.style.top = `${originY}px`
      particle.style.setProperty('--piece-color', balloon.color)
      particle.style.setProperty('--piece-x', `${Math.cos(angle) * distance}px`)
      particle.style.setProperty('--piece-y', `${Math.sin(angle) * distance + 42}px`)
      particleLayer.append(particle)
      window.setTimeout(() => particle.remove(), 760)
    }
    removeBalloon(balloon)
  }

  function updateHands(now: number) {
    if (!tracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastVideoTime) return
    lastVideoTime = video.currentTime
    hands = []
    pinchingHands.clear()
    const result = tracker.detectForVideo(video, now)
    result.landmarks.forEach((raw, handIndex) => {
      const landmarks = raw as Landmark[]
      const id = result.handedness[handIndex]?.[0]?.categoryName ?? String(handIndex)
      const index = screenPoint(landmarks[8])
      const thumb = screenPoint(landmarks[4])
      const pinchDistance = Math.hypot(index.x - thumb.x, index.y - thumb.y)
      const pinch = pinchDistance < Math.min(stageRect.width, stageRect.height) * .065 ? { x: (index.x + thumb.x) / 2, y: (index.y + thumb.y) / 2 } : null
      hands.push({ id, index, pinch, previousPinch: lastPinches.get(id) ?? null })
      if (pinch) pinchingHands.set(id, hands[hands.length - 1])
      if (pinch) lastPinches.set(id, pinch)
      else lastPinches.delete(id)
    })
  }

  function updateMouth(now: number) {
    if (!faceTracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastFaceVideoTime || now - lastFaceDetectionAt < 100) return
    lastFaceVideoTime = video.currentTime
    lastFaceDetectionAt = now
    const result = faceTracker.detectForVideo(video, now)
    const landmarks = result.faceLandmarks[0] as Landmark[] | undefined
    if (!landmarks) {
      mouth = null
      return
    }
    const upper = screenPoint(landmarks[13])
    const lower = screenPoint(landmarks[14])
    const left = screenPoint(landmarks[78])
    const right = screenPoint(landmarks[308])
    const width = Math.max(1, Math.hypot(right.x - left.x, right.y - left.y))
    const openness = Math.hypot(lower.x - upper.x, lower.y - upper.y) / width
    mouth = openness > .16 ? {
      center: { x: (upper.x + lower.x) / 2, y: (upper.y + lower.y) / 2 },
      strength: Math.min(1.35, .8 + openness * 1.5),
    } : null
  }

  function attachStrings() {
    hands.forEach((hand) => {
      if (!hand.pinch) return
      let alreadyHeld = false
      let candidate: Balloon | null = null
      let closestDistance = Infinity
      for (const balloon of balloons) {
        if (!balloon.alive) continue
        if (balloon.grabbedBy === hand.id) { alreadyHeld = true; break }
        if (balloon.grabbedBy) continue
        const endY = balloon.y + balloon.height * .48 + balloon.stringLength
        const distance = Math.hypot(balloon.x - hand.pinch.x, endY - hand.pinch.y)
        if (distance < closestDistance) { candidate = balloon; closestDistance = distance }
      }
      if (alreadyHeld) return
      if (!candidate) return
      const stringEndY = candidate.y + candidate.height * .48 + candidate.stringLength
      if (Math.hypot(candidate.x - hand.pinch.x, stringEndY - hand.pinch.y) < 42) candidate.grabbedBy = hand.id
    })
  }

  function renderBalloon(balloon: Balloon, now: number) {
    const anchorY = balloon.y + balloon.height * .48
    const hand = balloon.grabbedBy ? pinchingHands.get(balloon.grabbedBy) : undefined
    const end = hand?.pinch ?? { x: balloon.x, y: anchorY + balloon.stringLength }
    const padding = 18
    const stringLeft = Math.min(balloon.x, end.x) - padding
    const stringTop = Math.min(anchorY, end.y)
    const stringWidth = Math.max(1, Math.abs(end.x - balloon.x) + padding * 2)
    const stringHeight = Math.max(1, Math.abs(end.y - anchorY))
    const startX = balloon.x - stringLeft
    const startY = anchorY - stringTop
    const endX = end.x - stringLeft
    const endY = end.y - stringTop
    const windA = Math.sin(now * .0045 + balloon.phase) * 8 + Math.max(-11, Math.min(11, balloon.vx * .1))
    const windB = Math.sin(now * .006 + balloon.phase * 1.7) * 11 - Math.max(-9, Math.min(9, balloon.vx * .07))
    balloon.string.setAttribute('viewBox', `0 0 ${stringWidth} ${stringHeight}`)
    balloon.stringPath.setAttribute('d', `M ${startX} ${startY} C ${startX + windA} ${startY + stringHeight * .31}, ${endX + windB} ${endY - stringHeight * .35}, ${endX} ${endY}`)
    balloon.element.style.left = `${balloon.x}px`
    balloon.element.style.top = `${balloon.y}px`
    balloon.element.style.width = `${balloon.radius * 2}px`
    balloon.element.style.height = `${balloon.height * 2}px`
    balloon.element.style.transform = `translate(-50%, -50%) scale(${balloon.scale})`
    balloon.string.style.left = `${stringLeft}px`
    balloon.string.style.top = `${stringTop}px`
    balloon.string.style.width = `${stringWidth}px`
    balloon.string.style.height = `${stringHeight}px`
  }

  function updateBalloons(delta: number, now: number) {
    if (now > spawnAt && liveBalloonCount < 18) {
      createBalloon()
      spawnAt = now + 620 + Math.random() * 580
    }
    attachStrings()
    for (const balloon of balloons) {
      if (!balloon.alive) continue
      const hand = balloon.grabbedBy ? pinchingHands.get(balloon.grabbedBy) : undefined
      if (balloon.grabbedBy && !hand) balloon.grabbedBy = null
      if (!balloon.grabbedBy && mouth) {
        const mouthDx = mouth.center.x - balloon.x
        const mouthDy = mouth.center.y - balloon.y
        const mouthDistance = Math.hypot(mouthDx, mouthDy) || 1
        const suctionRange = Math.max(155, balloon.radius * 3.8)
        if (mouthDistance < suctionRange) {
          const pull = (1 - mouthDistance / suctionRange) ** 2 * mouth.strength
          balloon.vx += (mouthDx / mouthDistance) * 620 * pull * delta
          balloon.vy += (mouthDy / mouthDistance) * 620 * pull * delta
          balloon.scale = Math.max(.18, balloon.scale - pull * delta * .78)
          if (mouthDistance < 16 || balloon.scale <= .2) {
            inhaleBalloon(balloon)
            continue
          }
        }
      } else balloon.scale += (1 - balloon.scale) * Math.min(1, delta * 4)
      if (hand?.pinch) {
        const anchorY = balloon.y + balloon.height * .48
        const dx = anchorY === hand.pinch.y && balloon.x === hand.pinch.x ? 0 : balloon.x - hand.pinch.x
        const dy = anchorY - hand.pinch.y
        const distance = Math.max(.001, Math.hypot(dx, dy))
        const targetX = hand.pinch.x + (dx / distance) * balloon.stringLength
        const targetAnchorY = hand.pinch.y + (dy / distance) * balloon.stringLength
        const targetY = targetAnchorY - balloon.height * .48
        const handVelocityX = hand.previousPinch ? (hand.pinch.x - hand.previousPinch.x) / Math.max(delta, .016) : 0
        const handVelocityY = hand.previousPinch ? (hand.pinch.y - hand.previousPinch.y) / Math.max(delta, .016) : 0
        balloon.vx += (targetX - balloon.x) * delta * 24 + handVelocityX * delta * .12
        balloon.vy += (targetY - balloon.y) * delta * 24 + handVelocityY * delta * .12
        // A held balloon still has buoyancy: the fixed string turns it into a
        // pendulum that settles above the pinching fingers instead of sagging.
        balloon.vy -= 52 * delta
      } else {
        balloon.vy -= 7 * delta
      }
      balloon.vx *= .985
      balloon.vy *= .985
      balloon.x += balloon.vx * delta
      balloon.y += balloon.vy * delta
      if (balloon.grabbedBy && hand?.pinch) {
        const anchorY = balloon.y + balloon.height * .48
        let dx = balloon.x - hand.pinch.x
        let dy = anchorY - hand.pinch.y
        const length = Math.hypot(dx, dy) || 1
        dx /= length
        dy /= length
        balloon.x = hand.pinch.x + dx * balloon.stringLength
        balloon.y = hand.pinch.y + dy * balloon.stringLength - balloon.height * .48
      }
      balloon.x = Math.max(-balloon.radius, Math.min(stageRect.width + balloon.radius, balloon.x))
      renderBalloon(balloon, now)
      for (const handPoint of hands) {
        if (balloon.grabbedBy || Math.hypot(balloon.x - handPoint.index.x, balloon.y - handPoint.index.y) > balloon.radius * .92) continue
        popBalloon(balloon)
        break
      }
      if (balloon.y < -balloon.height - balloon.stringLength) removeBalloon(balloon)
    }
    let writeIndex = 0
    for (const balloon of balloons) {
      if (balloon.alive) balloons[writeIndex++] = balloon
    }
    balloons.length = writeIndex
  }

  async function ensureTracker() {
    if (tracker) return tracker
    if (!trackerLoading) {
      trackerLoading = (async () => {
        const { FilesetResolver, HandLandmarker: HandLandmarkerClass } = await import('@mediapipe/tasks-vision')
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
        tracker = await HandLandmarkerClass.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_PATH }, runningMode: 'VIDEO', numHands: 2,
          minHandDetectionConfidence: .58, minHandPresenceConfidence: .55, minTrackingConfidence: .55,
        })
        return tracker
      })()
      trackerLoading.catch(() => { trackerLoading = null })
    }
    return trackerLoading
  }

  async function ensureFaceTracker() {
    if (faceTracker) return faceTracker
    if (!faceTrackerLoading) {
      faceTrackerLoading = (async () => {
        const { FilesetResolver, FaceLandmarker } = await import('@mediapipe/tasks-vision')
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
        faceTracker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: FACE_MODEL_PATH }, runningMode: 'VIDEO', numFaces: 1,
          minFaceDetectionConfidence: .58, minFacePresenceConfidence: .55, minTrackingConfidence: .55,
        })
        return faceTracker
      })()
      faceTrackerLoading.catch(() => { faceTrackerLoading = null })
    }
    return faceTrackerLoading
  }

  async function activate() {
    if (running) return
    try {
      setStatus('REQUESTING CAMERA')
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      video.srcObject = stream
      await video.play()
      if (!isActive()) { deactivate(); return }
      stageRect = stage.getBoundingClientRect()
      if (!balloons.length) for (let index = 0; index < 11; index += 1) createBalloon()
      running = true
      spawnAt = performance.now()
      gate.classList.add('hidden')
      setStatus('CAMERA LIVE · LOADING HANDS')
      frameId = requestAnimationFrame(render)
      void ensureTracker().then(() => { if (running) setStatus('INDEX / PINCH READY', 'active') }).catch(() => { if (running) setStatus('HAND TRACKER UNAVAILABLE', 'error') })
      void ensureFaceTracker().catch(() => { /* Hand controls remain available if face tracking cannot load. */ })
    } catch {
      setStatus('CAMERA ACCESS NEEDED', 'error')
      gate.classList.remove('hidden')
    }
  }

  function deactivate() {
    running = false
    window.cancelAnimationFrame(frameId)
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    video.srcObject = null
    lastVideoTime = -1
    lastFaceVideoTime = -1
    hands = []
    pinchingHands.clear()
    mouth = null
    inhaleGauge = 0
    burstingAll = false
    renderGauge()
    balloons.forEach(removeBalloon)
    balloons = []
    liveBalloonCount = 0
    particleLayer.innerHTML = ''
    gate.classList.remove('hidden')
  }

  function render(now: number) {
    if (!running || !isActive()) return
    const delta = Math.min((now - lastTime) / 1000, .05)
    lastTime = now
    updateHands(now)
    updateMouth(now)
    updateBalloons(delta, now)
    frameId = requestAnimationFrame(render)
  }

  startButton.addEventListener('click', () => { void activate() })
  renderGauge()
  return { activate, deactivate }
}
