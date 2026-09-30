import type { FaceLandmarker, HandLandmarker } from '@mediapipe/tasks-vision'
import './hbd.css'

type Point = { x: number; y: number }
type Landmark = Point & { z: number }
type Confetti = { x: number; y: number; vx: number; vy: number; size: number; angle: number; spin: number; color: string; life: number; maxLife: number }
type Smoke = { x: number; y: number; vx: number; vy: number; radius: number; life: number; maxLife: number; drift: number }

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const HAND_MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const FACE_MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const CONFETTI_COLORS = ['#ff5b78', '#ffb637', '#ffe58a', '#75d8ff', '#8bf0bd', '#b28aff', '#ff8fc3']

export function setupHbd(host: HTMLElement, isActive: () => boolean) {
  host.innerHTML = `
    <div class="hbd-stage">
      <video class="hbd-camera" autoplay muted playsinline></video>
      <div class="hbd-warmth"></div>
      <canvas class="hbd-art" aria-hidden="true"></canvas>
      <div class="hbd-finger-letters" aria-hidden="true">
        <span data-hand="left" data-finger="8">!</span><span data-hand="left" data-finger="12">D</span><span data-hand="left" data-finger="16">B</span><span data-hand="left" data-finger="20">H</span>
        <span data-hand="right" data-finger="8">!</span><span data-hand="right" data-finger="12">D</span><span data-hand="right" data-finger="16">B</span><span data-hand="right" data-finger="20">H</span>
      </div>
    </div>
  `

  const stage = host.querySelector<HTMLElement>('.hbd-stage')!
  const video = host.querySelector<HTMLVideoElement>('.hbd-camera')!
  const canvas = host.querySelector<HTMLCanvasElement>('.hbd-art')!
  const context = canvas.getContext('2d')!
  const warmth = host.querySelector<HTMLElement>('.hbd-warmth')!
  const letterElements = new Map([...host.querySelectorAll<HTMLElement>('.hbd-finger-letters span')].map((element) => [`${element.dataset.hand}-${element.dataset.finger}`, element]))

  let handTracker: HandLandmarker | null = null
  let handLoading: Promise<HandLandmarker> | null = null
  let faceTracker: FaceLandmarker | null = null
  let faceLoading: Promise<FaceLandmarker> | null = null
  let stream: MediaStream | null = null
  let running = false
  let frameId = 0
  let lastHandVideoTime = -1
  let lastFaceVideoTime = -1
  let lastFaceAt = 0
  let lastFrameAt = performance.now()
  let stageRect = stage.getBoundingClientRect()
  let flamePoints: (Point | null)[] = [null, null]
  let flameTargets: (Point | null)[] = [null, null]
  let lastIndexSeen = [0, 0]
  let faceTop: Point | null = null
  let faceSize = 0
  let mouth: { center: Point; confidence: number } | null = null
  let oConfidence = 0
  let oSince = 0
  let lit = false
  let blown = false
  let litAt = 0
  let celebrationAt = 0
  let nextConfettiWaveAt = 0
  let lastHandSeen = [0, 0]
  let awaitingFingerLift = false
  let confetti: Confetti[] = []
  let smoke: Smoke[] = []
  const resizeObserver = new ResizeObserver(() => { stageRect = stage.getBoundingClientRect() })
  resizeObserver.observe(stage)

  function screenPoint(landmark: Landmark): Point {
    const sourceAspect = video.videoWidth / Math.max(1, video.videoHeight)
    const screenAspect = stageRect.width / Math.max(1, stageRect.height)
    let x = 1 - landmark.x
    let y = landmark.y
    if (screenAspect > sourceAspect) {
      const renderedHeight = stageRect.width / sourceAspect
      y = (y * renderedHeight - (renderedHeight - stageRect.height) / 2) / stageRect.height
    } else {
      const renderedWidth = stageRect.height * sourceAspect
      x = (x * renderedWidth - (renderedWidth - stageRect.width) / 2) / stageRect.width
    }
    return { x: x * stageRect.width, y: y * stageRect.height }
  }

  function landmarkDistance(a: Landmark, b: Landmark) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  }

  function hasExtendedThumb(landmarks: Landmark[]) {
    const wrist = landmarks[0]
    const thumbTip = landmarks[4]
    const thumbIp = landmarks[3]
    return landmarkDistance(thumbTip, wrist) > landmarkDistance(thumbIp, wrist) * 1.12 && Math.abs(thumbTip.x - landmarks[2].x) > .035
  }

  function isExtended(landmarks: Landmark[], tip: number, pip: number) {
    const wrist = landmarks[0]
    return landmarks[tip].y < landmarks[pip].y - .018 && landmarkDistance(landmarks[tip], wrist) > landmarkDistance(landmarks[pip], wrist) * 1.1
  }

  function updateFingerLetters(landmarks: Landmark[], side: 0 | 1, now: number) {
    const fingerStates: [number, boolean][] = [
      [8, isExtended(landmarks, 8, 6)], [12, isExtended(landmarks, 12, 10)], [16, isExtended(landmarks, 16, 14)], [20, isExtended(landmarks, 20, 18)],
    ]
    const hand = side === 0 ? 'left' : 'right'
    lastHandSeen[side] = now
    fingerStates.forEach(([tip, extended]) => {
      const element = letterElements.get(`${hand}-${tip}`)!
      if (!extended) { element.classList.remove('visible'); return }
      const point = screenPoint(landmarks[tip])
      element.style.left = `${point.x}px`
      element.style.top = `${point.y - 19}px`
      element.classList.add('visible')
    })
  }

  function updateHand(now: number) {
    if (!handTracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastHandVideoTime) return
    lastHandVideoTime = video.currentTime
    const result = handTracker.detectForVideo(video, now)
    // Each hand has its own stable thumb flame slot. Other fingers are used
    // exclusively for the H/B/D/heart letter effects below.
    flameTargets = [null, null]
    const handsFound = [false, false]
    result.landmarks.slice(0, 2).forEach((raw, handIndex) => {
      const side: 0 | 1 = result.handedness[handIndex]?.[0]?.categoryName === 'Left' ? 0 : 1
      const landmarks = raw as Landmark[]
      updateFingerLetters(landmarks, side, now)
      handsFound[side] = true
      if (!hasExtendedThumb(landmarks)) return
      flameTargets[side] = screenPoint(landmarks[4])
      lastIndexSeen[side] = now
      if (!flamePoints[side]) flamePoints[side] = { ...flameTargets[side]! }
    })
    handsFound.forEach((found, side) => {
      if (!found && now - lastHandSeen[side] > 180) {
        const hand = side === 0 ? 'left' : 'right'
        letterElements.forEach((element) => { if (element.dataset.hand === hand) element.classList.remove('visible') })
      }
    })
    flamePoints = flamePoints.map((point, index) => now - lastIndexSeen[index] > 240 ? null : point)
    const hasIndexTip = flameTargets.some(Boolean)
    if (!hasIndexTip && awaitingFingerLift) awaitingFingerLift = false
    if (!lit && !blown && !awaitingFingerLift && hasIndexTip) ignite(now)
  }

  function updateFace(now: number) {
    if (!faceTracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastFaceVideoTime || now - lastFaceAt < 80) return
    lastFaceVideoTime = video.currentTime
    lastFaceAt = now
    const result = faceTracker.detectForVideo(video, now)
    const landmarks = result.faceLandmarks[0] as Landmark[] | undefined
    if (!landmarks) { mouth = null; oConfidence = 0; faceTop = null; return }
    const forehead = screenPoint(landmarks[10])
    const leftFace = screenPoint(landmarks[234])
    const rightFace = screenPoint(landmarks[454])
    faceTop = forehead
    faceSize = Math.max(62, Math.hypot(rightFace.x - leftFace.x, rightFace.y - leftFace.y))
    const upper = screenPoint(landmarks[13])
    const lower = screenPoint(landmarks[14])
    const outerUpper = screenPoint(landmarks[0])
    const outerLower = screenPoint(landmarks[17])
    const outerLeft = screenPoint(landmarks[61])
    const outerRight = screenPoint(landmarks[291])
    const innerLeft = screenPoint(landmarks[78])
    const innerRight = screenPoint(landmarks[308])
    const outerWidth = Math.max(1, Math.hypot(outerRight.x - outerLeft.x, outerRight.y - outerLeft.y))
    const innerWidth = Math.max(1, Math.hypot(innerRight.x - innerLeft.x, innerRight.y - innerLeft.y))
    const innerOpening = Math.hypot(lower.x - upper.x, lower.y - upper.y)
    const outerOpening = Math.hypot(outerLower.x - outerUpper.x, outerLower.y - outerUpper.y)
    const pucker = result.faceBlendshapes[0]?.categories.find((item) => item.categoryName === 'mouthPucker')?.score ?? 0
    const funnel = result.faceBlendshapes[0]?.categories.find((item) => item.categoryName === 'mouthFunnel')?.score ?? 0
    // Blendshape pucker/funnel plus inner and outer lip proportions distinguish
    // a rounded O from a smile or a normally open mouth.
    const roundness = Math.max(innerOpening / innerWidth, outerOpening / outerWidth)
    const widthRatio = outerWidth / Math.max(1, faceSize)
    const narrowness = 1 - Math.min(1, outerWidth / Math.max(1, faceSize * .58))
    const pursedWidth = Math.min(1, Math.max(0, (.46 - widthRatio) / .22))
    // A tightly pursed mouth can have almost no vertical opening, so width
    // compression is evaluated independently of the visible mouth opening.
    const geometry = Math.min(1, Math.max(0, (roundness - .09) * 1.8 + (outerOpening / faceSize - .018) * 3.1 + narrowness * .52))
    const currentConfidence = Math.max(geometry, pursedWidth * .78, Math.min(1, pucker * 1.35 + funnel * 1.12))
    oConfidence += (currentConfidence - oConfidence) * .58
    mouth = { center: { x: (upper.x + lower.x) / 2, y: (upper.y + lower.y) / 2 }, confidence: oConfidence }
  }

  function ignite(now: number) {
    lit = true
    litAt = now
    oSince = 0
    host.classList.add('lit')
  }

  function blowOut() {
    const origin = flamePoints.find((point) => point)
    if (!lit || !origin) return
    lit = false
    blown = true
    celebrationAt = performance.now()
    nextConfettiWaveAt = celebrationAt + 540
    host.classList.remove('lit')
    host.classList.add('celebrating')
    for (let index = 0; index < 26; index += 1) {
      smoke.push({ x: origin.x + (Math.random() - .5) * 8, y: origin.y - 12, vx: (Math.random() - .5) * 18, vy: -22 - Math.random() * 34, radius: 5 + Math.random() * 8, life: 0, maxLife: 1.1 + Math.random() * .7, drift: Math.random() * Math.PI * 2 })
    }
    burstConfetti(170)
  }

  function burstConfetti(count = 48) {
    const center = faceTop ? { x: faceTop.x, y: Math.max(70, faceTop.y - faceSize * .25) } : { x: stageRect.width / 2, y: stageRect.height * .38 }
    for (let index = 0; index < count; index += 1) {
      const angle = Math.PI * 2 * Math.random()
      const velocity = 95 + Math.random() * 315
      confetti.push({ x: center.x + (Math.random() - .5) * faceSize, y: center.y, vx: Math.cos(angle) * velocity, vy: Math.sin(angle) * velocity - 80, size: 5 + Math.random() * 9, angle: Math.random() * Math.PI, spin: (Math.random() - .5) * 14, color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)], life: 0, maxLife: 2.4 + Math.random() * 1.5 })
    }
  }

  function draw(now: number, dt: number) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(stageRect.width * ratio))
    const height = Math.max(1, Math.round(stageRect.height * ratio))
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, stageRect.width, stageRect.height)
    flamePoints = flamePoints.map((point, index) => {
      const target = flameTargets[index]
      if (!target) return point
      if (!point) return { ...target }
      // A short adaptive low-pass removes landmark jitter while retaining fast finger motion.
      const distance = Math.hypot(target.x - point.x, target.y - point.y)
      const follow = Math.min(1, dt * (22 + Math.min(34, distance * .24)))
      point.x += (target.x - point.x) * follow
      point.y += (target.y - point.y) * follow
      return point
    })
    if (lit) {
      const activeFlames = flamePoints.filter((point): point is Point => Boolean(point))
      warmth.style.background = activeFlames.map((point) => `radial-gradient(circle 155px at ${point.x}px ${point.y - 30}px, rgba(255,225,146,.56) 0%, rgba(255,154,57,.28) 23%, rgba(255,98,30,.10) 43%, transparent 72%)`).join(',')
      activeFlames.forEach((point, index) => drawFlame(now + index * 191, point))
      const nearMouth = activeFlames.some((point) => mouth && Math.hypot(mouth.center.x - point.x, mouth.center.y - point.y) < Math.max(240, faceSize * 1.9))
      // Ignore any already-rounded mouth detected at the instant of ignition.
      // Blowing becomes eligible only after the flame has settled on the fingertip.
      if (now - litAt > 700 && mouth && mouth.confidence > .30 && nearMouth) {
        if (!oSince) oSince = now
        if (now - oSince >= 2_000) blowOut()
      } else oSince = 0
    } else warmth.style.background = 'none'
    if (blown && celebrationAt) {
      if (now - celebrationAt < 10_000) {
        if (now >= nextConfettiWaveAt) {
          burstConfetti(42)
          nextConfettiWaveAt = now + 480 + Math.random() * 240
        }
      } else resetExperience()
    }
    updateSmoke(dt)
    updateConfetti(dt)
  }

  function drawFlame(now: number, point: Point) {
    const x = point.x
    const y = point.y - 6
    const flicker = Math.sin(now * .019) * 3 + Math.sin(now * .043) * 1.5
    const height = Math.max(28, Math.min(43, stageRect.height * .065))
    context.save()
    context.globalCompositeOperation = 'lighter'
    const glow = context.createRadialGradient(x, y - height * .28, 4, x, y - height * .28, height * 1.65)
    glow.addColorStop(0, 'rgba(255,231,153,.82)')
    glow.addColorStop(.22, 'rgba(255,157,50,.34)')
    glow.addColorStop(1, 'rgba(255,101,22,0)')
    context.fillStyle = glow
    context.beginPath(); context.arc(x, y - height * .28, height * 1.65, 0, Math.PI * 2); context.fill()
    context.shadowColor = '#ff8a2f'; context.shadowBlur = 25
    context.beginPath(); context.moveTo(x, y + 8); context.bezierCurveTo(x - height * .52 + flicker, y - height * .17, x - height * .17 - flicker, y - height * .84, x + flicker * .28, y - height); context.bezierCurveTo(x + height * .42 + flicker, y - height * .58, x + height * .38, y - height * .14, x, y + 8); context.fillStyle = '#ff782c'; context.fill()
    context.shadowBlur = 14
    context.beginPath(); context.moveTo(x, y + 4); context.bezierCurveTo(x - height * .22, y - height * .22, x - height * .04 + flicker, y - height * .57, x + flicker * .15, y - height * .68); context.bezierCurveTo(x + height * .22, y - height * .33, x + height * .14, y - height * .08, x, y + 4); context.fillStyle = '#ffe77b'; context.fill()
    context.restore()
  }

  function updateSmoke(dt: number) {
    smoke = smoke.filter((particle) => {
      particle.life += dt; particle.x += (particle.vx + Math.sin(particle.life * 5 + particle.drift) * 15) * dt; particle.y += particle.vy * dt; particle.radius += 11 * dt
      const alpha = (1 - particle.life / particle.maxLife) * .38
      context.beginPath(); context.fillStyle = `rgba(206,215,226,${alpha})`; context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2); context.fill()
      return particle.life < particle.maxLife
    })
  }

  function updateConfetti(dt: number) {
    confetti = confetti.filter((piece) => {
      piece.life += dt; piece.vy += 385 * dt; piece.x += piece.vx * dt; piece.y += piece.vy * dt; piece.angle += piece.spin * dt
      const alpha = Math.min(1, (piece.maxLife - piece.life) * 1.4)
      context.save(); context.translate(piece.x, piece.y); context.rotate(piece.angle); context.globalAlpha = alpha; context.fillStyle = piece.color; context.fillRect(-piece.size / 2, -piece.size * .28, piece.size, piece.size * .56); context.restore()
      return piece.life < piece.maxLife && piece.y < stageRect.height + 40
    })
  }

  function resetExperience() {
    lit = false
    blown = false
    celebrationAt = 0
    nextConfettiWaveAt = 0
    awaitingFingerLift = true
    oSince = 0
    confetti = []
    smoke = []
    warmth.style.background = 'none'
    host.classList.remove('lit', 'celebrating')
  }

  async function ensureHandTracker() {
    if (handTracker) return handTracker
    if (!handLoading) {
      handLoading = (async () => {
        const { FilesetResolver, HandLandmarker: HandLandmarkerClass } = await import('@mediapipe/tasks-vision')
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
        handTracker = await HandLandmarkerClass.createFromOptions(vision, { baseOptions: { modelAssetPath: HAND_MODEL_PATH }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: .58, minHandPresenceConfidence: .55, minTrackingConfidence: .55 })
        return handTracker
      })()
      handLoading.catch(() => { handLoading = null })
    }
    return handLoading
  }

  async function ensureFaceTracker() {
    if (faceTracker) return faceTracker
    if (!faceLoading) {
      faceLoading = (async () => {
        const { FilesetResolver, FaceLandmarker: FaceLandmarkerClass } = await import('@mediapipe/tasks-vision')
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
        faceTracker = await FaceLandmarkerClass.createFromOptions(vision, { baseOptions: { modelAssetPath: FACE_MODEL_PATH }, runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, minFaceDetectionConfidence: .55, minFacePresenceConfidence: .55, minTrackingConfidence: .55 })
        return faceTracker
      })()
      faceLoading.catch(() => { faceLoading = null })
    }
    return faceLoading
  }

  async function activate() {
    if (running) return
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      video.srcObject = stream
      await video.play()
      if (!isActive()) { deactivate(); return }
      stageRect = stage.getBoundingClientRect(); lastFrameAt = performance.now(); running = true
      frameId = requestAnimationFrame(render)
      void Promise.all([ensureHandTracker(), ensureFaceTracker()]).catch(() => { /* The camera remains visible if a remote landmark model cannot load. */ })
    } catch { /* Camera permission is handled by the browser without adding an on-screen message. */ }
  }

  function deactivate() {
    running = false; window.cancelAnimationFrame(frameId); stream?.getTracks().forEach((track) => track.stop()); stream = null; video.srcObject = null
    lastHandVideoTime = -1; lastFaceVideoTime = -1; flamePoints = [null, null]; flameTargets = [null, null]; lastIndexSeen = [0, 0]; lastHandSeen = [0, 0]; faceTop = null; mouth = null; oConfidence = 0; oSince = 0; lit = false; blown = false; celebrationAt = 0; nextConfettiWaveAt = 0; awaitingFingerLift = false; confetti = []; smoke = []
    warmth.style.background = 'none'; host.classList.remove('lit', 'celebrating'); letterElements.forEach((element) => element.classList.remove('visible'))
  }

  function render(now: number) {
    if (!running || !isActive()) return
    const dt = Math.min(.05, (now - lastFrameAt) / 1000); lastFrameAt = now
    updateHand(now); updateFace(now); draw(now, dt)
    frameId = requestAnimationFrame(render)
  }

  return { activate, deactivate }
}
