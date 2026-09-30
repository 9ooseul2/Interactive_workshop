import type { FaceLandmarker, HandLandmarker } from '@mediapipe/tasks-vision'
import './goodNight.css'

type Point = { x: number; y: number }
type Landmark = Point & { z: number }
type Hand = { id: string; pinch: Point | null; tips: Point[] }

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const HAND_MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const FACE_MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const FINGER_TIPS = [4, 8, 12, 16, 20]
const MOTION_DURATION = 2_000

export function setupGoodNight(host: HTMLElement, isActive: () => boolean) {
  host.innerHTML = `
    <div class="goodnight-stage">
      <video class="goodnight-camera" autoplay muted playsinline></video>
      <div class="goodnight-shade"></div>
      <canvas class="goodnight-hands" aria-hidden="true"></canvas>
      <div class="goodnight-cord-wrap" aria-label="램프 끈">
        <div class="goodnight-cord"><i></i></div>
        <button class="goodnight-pull" type="button" aria-label="램프 끈을 아래로 당기세요"><span></span></button>
      </div>
      <div class="goodnight-blanket" aria-hidden="true"><img src="/goodnight/gingham-duvet.png" alt="" /></div>
      <div class="goodnight-vignette"></div>
    </div>
    <button class="goodnight-reset" type="button" aria-label="GoodNight 다시 시작">↻</button>
    <div class="goodnight-gate">
      <button class="goodnight-start" type="button" aria-label="카메라 시작">◉</button>
    </div>
  `

  const stage = host.querySelector<HTMLElement>('.goodnight-stage')!
  const video = host.querySelector<HTMLVideoElement>('.goodnight-camera')!
  const handCanvas = host.querySelector<HTMLCanvasElement>('.goodnight-hands')!
  const handContext = handCanvas.getContext('2d')!
  const pull = host.querySelector<HTMLButtonElement>('.goodnight-pull')!
  const gate = host.querySelector<HTMLElement>('.goodnight-gate')!
  const start = host.querySelector<HTMLButtonElement>('.goodnight-start')!
  const reset = host.querySelector<HTMLButtonElement>('.goodnight-reset')!

  let handTracker: HandLandmarker | null = null
  let handLoading: Promise<HandLandmarker> | null = null
  let faceTracker: FaceLandmarker | null = null
  let faceLoading: Promise<FaceLandmarker> | null = null
  let stream: MediaStream | null = null
  let running = false
  let frameId = 0
  let lastHandVideoTime = -1
  let lastHandAt = 0
  let lastFaceVideoTime = -1
  let lastFaceAt = 0
  let stageRect = stage.getBoundingClientRect()
  let phase: 'wake' | 'cord' | 'sleep' = 'wake'
  let motionProgress = 0
  let lastMotionAt = 0
  let hands: Hand[] = []
  let faceMouth: Point | null = null
  let dragging = false
  let pointerDragging = false
  let pullAmount = 0
  const previousTips = new Map<string, Point>()
  const resizeObserver = new ResizeObserver(() => { stageRect = stage.getBoundingClientRect(); placeBlanket() })
  resizeObserver.observe(stage)

  function setStatus(text: string, state: 'ready' | 'active' | 'error' = 'ready') {
    void text
    host.dataset.goodnightState = state
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

  function updateHands(now: number) {
    if (!handTracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastHandVideoTime) return
    const handDt = lastHandAt ? Math.min(55, now - lastHandAt) : 0
    lastHandAt = now
    lastHandVideoTime = video.currentTime
    const result = handTracker.detectForVideo(video, now)
    hands = []
    let movement = 0
    let measuredTips = 0
    result.landmarks.slice(0, 2).forEach((rawLandmarks, handIndex) => {
      const landmarks = rawLandmarks as Landmark[]
      const id = result.handedness[handIndex]?.[0]?.categoryName ?? String(handIndex)
      const tips = FINGER_TIPS.map((tip) => screenPoint(landmarks[tip]))
      const index = tips[1]
      const thumb = tips[0]
      const pinchDistance = Math.hypot(index.x - thumb.x, index.y - thumb.y)
      const pinch = pinchDistance < Math.min(stageRect.width, stageRect.height) * .075
        ? { x: (index.x + thumb.x) / 2, y: (index.y + thumb.y) / 2 }
        : null
      hands.push({ id, pinch, tips })
      tips.forEach((tip, tipIndex) => {
        const key = `${id}-${FINGER_TIPS[tipIndex]}`
        const previous = previousTips.get(key)
        if (previous) {
          movement += Math.hypot(tip.x - previous.x, tip.y - previous.y)
          measuredTips += 1
        }
        previousTips.set(key, tip)
      })
    })
    if (phase === 'wake') {
      const averageMovement = movement / Math.max(measuredTips, 1)
      // Requiring two recognized hands avoids filling the wake timer with one idle hand.
      const movingWithBothHands = hands.length >= 2 && averageMovement > Math.max(2.1, Math.min(stageRect.width, stageRect.height) * .0035)
      if (movingWithBothHands) {
        motionProgress = Math.min(MOTION_DURATION, motionProgress + handDt)
        lastMotionAt = now
      } else if (now - lastMotionAt > 180) {
        motionProgress = Math.max(0, motionProgress - handDt * .55)
      }
      if (motionProgress >= MOTION_DURATION) revealCord()
    }
    if (phase === 'cord') updateHandGrab()
  }

  function updateFace(now: number) {
    if (!faceTracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastFaceVideoTime || now - lastFaceAt < 90) return
    lastFaceVideoTime = video.currentTime
    lastFaceAt = now
    const result = faceTracker.detectForVideo(video, now)
    const landmarks = result.faceLandmarks[0] as Landmark[] | undefined
    if (!landmarks) return
    const upperLip = screenPoint(landmarks[13])
    const lowerLip = screenPoint(landmarks[14])
    faceMouth = { x: (upperLip.x + lowerLip.x) / 2, y: (upperLip.y + lowerLip.y) / 2 }
    if (phase === 'sleep') placeBlanket()
  }

  function cordBaseY() {
    // This exactly matches the responsive cord height in the stylesheet.
    return Math.min(stageRect.height * .54, 430)
  }

  function cordX() {
    return stageRect.width * .835
  }

  function updateHandGrab() {
    const grabPoint = hands.find((hand) => hand.pinch && Math.hypot(hand.pinch.x - cordX(), hand.pinch.y - (cordBaseY() + pullAmount)) < 92)?.pinch
    if (grabPoint) {
      dragging = true
      updatePull(grabPoint.y - cordBaseY())
    } else {
      dragging = false
      host.classList.remove('cord-grabbed')
    }
  }

  function updatePull(value: number) {
    pullAmount = Math.max(0, Math.min(155, value))
    const darkness = Math.min(.82, pullAmount / 122 * .82)
    host.style.setProperty('--cord-pull', `${pullAmount}px`)
    host.style.setProperty('--night-darkness', `${darkness}`)
    host.classList.toggle('cord-grabbed', dragging || pointerDragging)
    if (pullAmount >= 72) goToSleep()
  }

  function revealCord() {
    if (phase !== 'wake') return
    phase = 'cord'
    host.classList.add('cord-visible')
    setStatus('LAMP CORD READY', 'active')
  }

  function placeBlanket() {
    const fallback = stageRect.height * .62
    const imageHeight = stageRect.width * (941 / 1672)
    // The transparent source image has roughly 35% breathing room above its
    // quilt edge. Align that edge, rather than the image box, below the mouth.
    const top = Math.max(-imageHeight * .2, Math.min(stageRect.height * .72, (faceMouth?.y ?? fallback) + 28 - imageHeight * .35))
    host.style.setProperty('--blanket-image-top', `${top}px`)
  }

  function goToSleep() {
    if (phase === 'sleep') return
    phase = 'sleep'
    dragging = false
    pointerDragging = false
    pullAmount = 105
    host.style.setProperty('--cord-pull', '105px')
    host.style.setProperty('--night-darkness', '.86')
    placeBlanket()
    host.classList.add('sleeping')
    setStatus('GOOD NIGHT', 'active')
  }

  function resetExperience() {
    phase = 'wake'
    motionProgress = 0
    lastMotionAt = 0
    lastHandAt = 0
    pullAmount = 0
    dragging = false
    pointerDragging = false
    faceMouth = null
    previousTips.clear()
    host.classList.remove('cord-visible', 'cord-grabbed', 'sleeping')
    host.style.setProperty('--cord-pull', '0px')
    host.style.setProperty('--night-darkness', '0')
    if (running) setStatus('BOTH HANDS READY', 'active')
  }

  function drawHands() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
    const width = Math.max(1, Math.round(stageRect.width * ratio))
    const height = Math.max(1, Math.round(stageRect.height * ratio))
    if (handCanvas.width !== width || handCanvas.height !== height) { handCanvas.width = width; handCanvas.height = height }
    handContext.clearRect(0, 0, width, height)
    if (phase === 'sleep') return
    hands.forEach((hand) => hand.tips.forEach((tip, index) => {
      const x = tip.x * ratio
      const y = tip.y * ratio
      handContext.beginPath()
      handContext.arc(x, y, (index === 1 ? 5 : 3.2) * ratio, 0, Math.PI * 2)
      handContext.fillStyle = index === 1 ? 'rgba(255, 245, 207, .96)' : 'rgba(255, 242, 204, .62)'
      handContext.shadowColor = '#ffd985'
      handContext.shadowBlur = 10 * ratio
      handContext.fill()
    }))
    handContext.shadowBlur = 0
  }

  async function ensureHandTracker() {
    if (handTracker) return handTracker
    if (!handLoading) {
      handLoading = (async () => {
        const { FilesetResolver, HandLandmarker: HandLandmarkerClass } = await import('@mediapipe/tasks-vision')
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
        handTracker = await HandLandmarkerClass.createFromOptions(vision, {
          baseOptions: { modelAssetPath: HAND_MODEL_PATH }, runningMode: 'VIDEO', numHands: 2,
          minHandDetectionConfidence: .58, minHandPresenceConfidence: .55, minTrackingConfidence: .55,
        })
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
        faceTracker = await FaceLandmarkerClass.createFromOptions(vision, {
          baseOptions: { modelAssetPath: FACE_MODEL_PATH }, runningMode: 'VIDEO', numFaces: 1,
          minFaceDetectionConfidence: .55, minFacePresenceConfidence: .55, minTrackingConfidence: .55,
        })
        return faceTracker
      })()
      faceLoading.catch(() => { faceLoading = null })
    }
    return faceLoading
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
      running = true
      gate.classList.add('hidden')
      resetExperience()
      setStatus('CAMERA LIVE · LOADING HANDS')
      frameId = requestAnimationFrame(render)
      void ensureHandTracker().then(() => { if (running) setStatus('MOVE BOTH HANDS', 'active') }).catch(() => { if (running) setStatus('HAND TRACKER UNAVAILABLE', 'error') })
      void ensureFaceTracker().catch(() => { /* The blanket has a centered fallback without face landmarks. */ })
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
    lastHandVideoTime = -1
    lastHandAt = 0
    lastFaceVideoTime = -1
    hands = []
    handContext.clearRect(0, 0, handCanvas.width, handCanvas.height)
    resetExperience()
    gate.classList.remove('hidden')
  }

  function render(now: number) {
    if (!running || !isActive()) return
    updateHands(now)
    updateFace(now)
    drawHands()
    frameId = requestAnimationFrame(render)
  }

  function pullFromPointer(event: PointerEvent) {
    if (!pointerDragging || phase !== 'cord') return
    updatePull(event.clientY - stageRect.top - cordBaseY())
  }

  pull.addEventListener('pointerdown', (event) => {
    if (phase !== 'cord') return
    pointerDragging = true
    pull.setPointerCapture(event.pointerId)
    pullFromPointer(event)
  })
  pull.addEventListener('pointermove', pullFromPointer)
  pull.addEventListener('pointerup', () => { pointerDragging = false; host.classList.remove('cord-grabbed') })
  pull.addEventListener('pointercancel', () => { pointerDragging = false; host.classList.remove('cord-grabbed') })
  start.addEventListener('click', () => { void activate() })
  reset.addEventListener('click', resetExperience)

  return { activate, deactivate }
}
