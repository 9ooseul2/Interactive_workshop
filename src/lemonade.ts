import type { HandLandmarker } from '@mediapipe/tasks-vision'
import './lemonade.css'

type Point = { x: number; y: number }
type Landmark = Point & { z: number }
type HandState = { landmarks: Landmark[]; palm: Point; knuckles: Point; fist: boolean }
type LemonState = 'floating' | 'held' | 'falling'
type Lemon = {
  element: HTMLElement
  core: HTMLElement
  meter: HTMLElement
  x: number
  y: number
  baseX: number
  baseY: number
  phase: number
  size: number
  rotation: number
  juice: number
  state: LemonState
  streaming: boolean
}
type JuiceStream = {
  element: SVGSVGElement
  mainPath: SVGPathElement
  highlightPath: SVGPathElement
  lemon: Lemon
  x: number
  originY: number
  length: number
  amount: number
  curve: number
  phase: number
}

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const LEMON_SOURCE = '/lemons/lemon.png'

export function setupLemonade(host: HTMLElement, isActive: () => boolean) {
  host.innerHTML = `
    <div class="lemonade-stage">
      <video id="lemon-camera" class="lemon-camera" autoplay muted playsinline></video>
      <div class="camera-tint"></div>
      <canvas id="hand-overlay" class="hand-overlay" aria-hidden="true"></canvas>
      <div id="lemon-layer" class="lemon-layer" aria-hidden="true"></div>
      <div id="juice-layer" class="juice-layer" aria-hidden="true"></div>

      <div class="lemonade-brand">
        <span>CLAW CLUB / 03</span>
        <strong>LEMON<br><em>ADE</em></strong>
      </div>
      <div class="lemonade-instructions">
        <p><b>LEFT HAND</b> 주먹으로 레몬을 잡고 짜세요</p>
        <p><b>RIGHT HAND</b> 손바닥으로 컵을 옮기세요</p>
      </div>
      <div class="tracking-status" id="tracking-status">
        <i></i><span id="camera-status">CAMERA READY</span>
      </div>

      <div class="hand-readout left"><span>LEFT</span><strong id="left-state">손을 찾는 중</strong></div>
      <div class="hand-readout right"><span>RIGHT</span><strong id="right-state">컵 대기 중</strong></div>

      <div id="lemon-cup" class="lemon-cup" style="--cup-x:50%;--cup-y:78%;--fill:0%;--ice-lift:0px">
        <div class="cup-rim"></div>
        <div class="cup-body">
          <div class="lemonade-fill"><span></span></div>
          <i class="ice ice-one"></i><i class="ice ice-two"></i><i class="ice ice-three"></i>
          <b class="lemon-slice"></b>
        </div>
        <div class="cup-stem"></div>
        <div class="cup-foot"></div>
        <div class="cup-shadow"></div>
      </div>

      <div class="lemonade-meter">
        <span>GLASS FILL</span><strong id="fill-value">0%</strong>
        <div><i id="fill-bar"></i></div>
      </div>
      <button id="refill-lemons" class="refill-lemons" type="button">↻ 레몬 리필</button>

      <div id="camera-gate" class="camera-gate">
        <div class="camera-gate-icon">⌁</div>
        <p>LEMONADE INTERACTION</p>
        <h1>손으로 레몬을<br><em>짜보세요.</em></h1>
        <button id="start-camera" type="button">카메라 시작 <span>↗</span></button>
        <small>카메라 권한과 네트워크 연결이 필요합니다.</small>
      </div>
    </div>
  `

  const video = host.querySelector<HTMLVideoElement>('#lemon-camera')!
  const canvas = host.querySelector<HTMLCanvasElement>('#hand-overlay')!
  const context = canvas.getContext('2d')!
  const lemonLayer = host.querySelector<HTMLElement>('#lemon-layer')!
  const juiceLayer = host.querySelector<HTMLElement>('#juice-layer')!
  const cup = host.querySelector<HTMLElement>('#lemon-cup')!
  const cameraGate = host.querySelector<HTMLElement>('#camera-gate')!
  const startCameraButton = host.querySelector<HTMLButtonElement>('#start-camera')!
  const refillButton = host.querySelector<HTMLButtonElement>('#refill-lemons')!
  const cameraStatus = host.querySelector<HTMLElement>('#camera-status')!
  const leftState = host.querySelector<HTMLElement>('#left-state')!
  const rightState = host.querySelector<HTMLElement>('#right-state')!
  const fillValue = host.querySelector<HTMLElement>('#fill-value')!
  const fillBar = host.querySelector<HTMLElement>('#fill-bar')!

  let handLandmarker: HandLandmarker | null = null
  let handLandmarkerClass: typeof import('@mediapipe/tasks-vision').HandLandmarker | null = null
  let handLandmarkerLoading: Promise<HandLandmarker> | null = null
  let cameraStream: MediaStream | null = null
  let running = false
  let frameId = 0
  let previewFrameId = 0
  let previewLastFrameTime = performance.now()
  let lastFrameTime = performance.now()
  let lastVideoTime = -1
  let cupFill = 0
  let cupPosition: Point = { x: 0.5, y: 0.78 }
  let cupTarget: Point = { ...cupPosition }
  let latestLeft: HandState | null = null
  let latestRight: HandState | null = null
  let lastLeftSeen = 0
  let lemons: Lemon[] = []
  const juiceStreams: JuiceStream[] = []

  function setCameraStatus(text: string, mode: 'ready' | 'active' | 'error' = 'ready') {
    cameraStatus.textContent = text
    host.dataset.cameraState = mode
  }

  function createLemonImage() {
    const image = document.createElement('img')
    image.alt = ''
    image.draggable = false
    image.addEventListener('load', () => image.parentElement?.classList.add('image-loaded'))
    image.addEventListener('error', () => {
      // Keep the CSS lemon underneath as a graceful fallback if the user has
      // not added public/lemons/lemon.png yet.
      image.remove()
    })
    image.src = LEMON_SOURCE
    return image
  }

  function makeLemons() {
    lemons.forEach((lemon) => lemon.element.remove())
    juiceStreams.forEach((stream) => stream.element.remove())
    juiceStreams.length = 0
    lemonLayer.innerHTML = ''
    const seeds = [
      [.17, .25, .79, 104, .1], [.39, .16, 1.05, 86, 1.8], [.64, .27, .88, 118, 3.3],
      [.82, .18, .74, 95, 4.9], [.27, .53, .72, 91, 2.6], [.55, .49, .98, 110, 5.5], [.78, .58, .76, 97, .7],
    ]
    lemons = seeds.map(([x, y, size, juice, phase], index) => {
      const element = document.createElement('div')
      element.className = 'floating-lemon'
      // The cup is 150px wide. Keep every real lemon clearly above half of it.
      const lemonSize = Math.max(120, size * 1.5)
      element.style.setProperty('--lemon-size', `${lemonSize}px`)
      element.innerHTML = `<div class="lemon-core"><span class="lemon-fallback"></span><span class="lemon-juice-meter"><i></i></span></div>`
      const core = element.querySelector<HTMLElement>('.lemon-core')!
      core.prepend(createLemonImage())
      const meter = element.querySelector<HTMLElement>('.lemon-juice-meter i')!
      lemonLayer.append(element)
      const lemon: Lemon = {
        element,
        core,
        meter,
        x,
        y,
        baseX: x,
        baseY: y,
        phase,
        size: lemonSize,
        rotation: index % 2 ? -12 : 10,
        juice,
        state: 'floating',
        streaming: false,
      }
      renderLemon(lemon)
      return lemon
    })
  }

  function renderLemon(lemon: Lemon, squish = 1) {
    lemon.element.style.left = `${lemon.x * 100}%`
    lemon.element.style.top = `${lemon.y * 100}%`
    lemon.element.style.transform = `translate(-50%, -50%) rotate(${lemon.rotation}deg)`
    lemon.core.style.transform = `scaleX(${1 + (1 - squish) * 0.42}) scaleY(${squish})`
    lemon.meter.style.transform = `scaleX(${lemon.juice / 100})`
    lemon.element.classList.toggle('held', lemon.state === 'held')
  }

  function distance(a: Point, b: Point) {
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  function getScreenPoint(landmark: Landmark): Point {
    const rect = host.getBoundingClientRect()
    const sourceAspect = video.videoWidth / Math.max(video.videoHeight, 1)
    const screenAspect = rect.width / Math.max(rect.height, 1)
    let x = 1 - landmark.x
    let y = landmark.y
    if (screenAspect > sourceAspect) {
      const renderedHeight = rect.width / sourceAspect
      y = (y * renderedHeight - (renderedHeight - rect.height) / 2) / rect.height
    } else {
      const renderedWidth = rect.height * sourceAspect
      x = (x * renderedWidth - (renderedWidth - rect.width) / 2) / rect.width
    }
    return { x, y }
  }

  function getPalm(landmarks: Landmark[]) {
    const palmIndexes = [0, 5, 9, 13, 17]
    const total = palmIndexes.reduce((sum, index) => {
      const point = getScreenPoint(landmarks[index])
      return { x: sum.x + point.x, y: sum.y + point.y }
    }, { x: 0, y: 0 })
    return { x: total.x / palmIndexes.length, y: total.y / palmIndexes.length }
  }

  function getKnuckleCenter(landmarks: Landmark[]) {
    // MCP joints: where the four fingers meet the hand. This is visibly closer
    // to the finger joints than the palm centre and remains stable in motion.
    const knuckleIndexes = [5, 9, 13, 17]
    const total = knuckleIndexes.reduce((sum, index) => {
      const point = getScreenPoint(landmarks[index])
      return { x: sum.x + point.x, y: sum.y + point.y }
    }, { x: 0, y: 0 })
    return { x: total.x / knuckleIndexes.length, y: total.y / knuckleIndexes.length }
  }

  function isFist(landmarks: Landmark[]) {
    const wrist = landmarks[0]
    const palmSize = Math.max(Math.hypot(landmarks[9].x - wrist.x, landmarks[9].y - wrist.y), 0.035)
    const tips = [4, 8, 12, 16, 20]
    const averageReach = tips.reduce((sum, index) => sum + Math.hypot(landmarks[index].x - wrist.x, landmarks[index].y - wrist.y), 0) / tips.length
    return averageReach / palmSize < 1.55
  }

  function drawHands(hands: { landmarks: Landmark[]; kind: 'left' | 'right' }[]) {
    const rect = host.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio, 2)
    const width = Math.max(1, Math.floor(rect.width * dpr))
    const height = Math.max(1, Math.floor(rect.height * dpr))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    context.clearRect(0, 0, width, height)
    context.lineWidth = 2.1 * dpr
    hands.forEach((hand) => {
      const color = hand.kind === 'left' ? '#f5dc59' : '#8fffd1'
      context.strokeStyle = color
      context.fillStyle = color
      handLandmarkerClass?.HAND_CONNECTIONS.forEach(({ start, end }) => {
        const a = getScreenPoint(hand.landmarks[start])
        const b = getScreenPoint(hand.landmarks[end])
        context.beginPath()
        context.moveTo(a.x * width, a.y * height)
        context.lineTo(b.x * width, b.y * height)
        context.stroke()
      })
      hand.landmarks.forEach((landmark) => {
        const point = getScreenPoint(landmark)
        context.beginPath()
        context.arc(point.x * width, point.y * height, 3.2 * dpr, 0, Math.PI * 2)
        context.fill()
      })
    })
  }

  function updateHands() {
    if (!handLandmarker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    if (video.currentTime === lastVideoTime) return
    lastVideoTime = video.currentTime
    const result = handLandmarker.detectForVideo(video, performance.now())
    let left: HandState | null = null
    let right: HandState | null = null
    const renderHands: { landmarks: Landmark[]; kind: 'left' | 'right' }[] = []
    for (let index = 0; index < result.landmarks.length; index += 1) {
      const rawLandmarks = result.landmarks[index]
      const landmarks = rawLandmarks as Landmark[]
      const category = result.handedness[index]?.[0]?.categoryName ?? result.handednesses[index]?.[0]?.categoryName
      // The webcam pixels are unmirrored for MediaPipe but mirrored in CSS for
      // the user, so handedness needs swapping to match the user's real hands.
      const kind = category?.toLowerCase() === 'left' ? 'right' : 'left'
      const hand = {
        landmarks,
        palm: getPalm(landmarks),
        knuckles: getKnuckleCenter(landmarks),
        fist: isFist(landmarks),
      }
      if (kind === 'left') left = hand
      else right = hand
      renderHands.push({ landmarks, kind })
    }
    latestLeft = left
    latestRight = right
    if (left) lastLeftSeen = performance.now()
    leftState.textContent = left ? (left.fist ? 'LEMON SQUEEZE' : '손바닥 인식') : '손을 찾는 중'
    rightState.textContent = right ? 'CUP TRACKING' : '컵 대기 중'
    drawHands(renderHands)
  }

  function spawnJuiceStream(lemon: Lemon) {
    if (lemon.streaming) return
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    element.setAttribute('class', 'lemon-juice-stream')
    element.setAttribute('aria-hidden', 'true')
    const mainPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    mainPath.classList.add('juice-main-path')
    const highlightPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    highlightPath.classList.add('juice-highlight-path')
    element.append(mainPath, highlightPath)
    juiceLayer.append(element)
    lemon.streaming = true
    juiceStreams.push({
      element,
      mainPath,
      highlightPath,
      lemon,
      x: lemon.x,
      originY: lemon.y + 0.06,
      length: 0.02,
      amount: 2.1,
      curve: (Math.random() > 0.5 ? 1 : -1) * (10 + Math.random() * 15),
      phase: Math.random() * Math.PI * 2,
    })
  }

  function updateDrops(delta: number, now: number) {
    const screenHeight = Math.max(host.getBoundingClientRect().height, 1)
    for (let index = juiceStreams.length - 1; index >= 0; index -= 1) {
      const stream = juiceStreams[index]
      stream.length += delta * 0.78
      const height = Math.max(22, stream.length * screenHeight)
      const sway = Math.sin(now * 0.012 + stream.phase) * 5
      const width = 72
      const center = width / 2
      const endOffset = stream.curve * 0.28 + sway * 0.35
      const path = `M ${center} 0 C ${center + stream.curve + sway} ${height * 0.25}, ${center - stream.curve * 0.62 - sway} ${height * 0.67}, ${center + endOffset} ${height}`
      const highlight = `M ${center - 1.4} 2 C ${center + stream.curve * 0.76 + sway * 0.6} ${height * 0.3}, ${center - stream.curve * 0.42} ${height * 0.64}, ${center + endOffset - 1} ${height - 4}`
      stream.element.setAttribute('viewBox', `0 0 ${width} ${height}`)
      stream.mainPath.setAttribute('d', path)
      stream.highlightPath.setAttribute('d', highlight)
      stream.element.style.left = `calc(${stream.x * 100}% - ${center}px)`
      stream.element.style.top = `${stream.originY * 100}%`
      stream.element.style.width = `${width}px`
      stream.element.style.height = `${height}px`
      const streamEnd = stream.originY + stream.length
      const endX = stream.x + endOffset / Math.max(host.getBoundingClientRect().width, 1)
      const reachesCup = streamEnd >= cupPosition.y - 0.075 && Math.abs(endX - cupPosition.x) < 0.1
      if (reachesCup) {
        cupFill = Math.min(100, cupFill + stream.amount)
        stream.element.classList.add('absorbed')
        window.setTimeout(() => stream.element.remove(), 150)
        stream.lemon.streaming = false
        juiceStreams.splice(index, 1)
      } else if (streamEnd > 1.12) {
        stream.element.remove()
        stream.lemon.streaming = false
        juiceStreams.splice(index, 1)
      }
    }
  }

  function updateCup(delta: number) {
    cupTarget = latestRight ? latestRight.knuckles : { x: 0.5, y: 0.79 }
    const follow = Math.min(1, delta * 12)
    cupPosition.x += (cupTarget.x - cupPosition.x) * follow
    cupPosition.y += (cupTarget.y - cupPosition.y) * follow
    const fill = Math.round(cupFill)
    cup.style.setProperty('--cup-x', `${cupPosition.x * 100}%`)
    cup.style.setProperty('--cup-y', `${cupPosition.y * 100}%`)
    cup.style.setProperty('--fill', `${fill}%`)
    cup.style.setProperty('--ice-lift', `${fill * 0.22}px`)
    cup.classList.toggle('tracking', Boolean(latestRight))
    fillValue.textContent = `${fill}%`
    fillBar.style.width = `${fill}%`
  }

  function updateLemons(delta: number, now: number) {
    const left = latestLeft
    const canGrab = left?.fist ?? false
    if (left && canGrab) {
      const target = lemons
        .filter((lemon) => lemon.state === 'floating')
        .sort((a, b) => distance(a, left.palm) - distance(b, left.palm))[0]
      if (target && distance(target, left.palm) < 0.12) target.state = 'held'
    }
    lemons.forEach((lemon) => {
      let squish = 1
      if (lemon.state === 'floating') {
        lemon.x = lemon.baseX + Math.sin(now * 0.001 + lemon.phase) * 0.022
        lemon.y = lemon.baseY + Math.cos(now * 0.00135 + lemon.phase) * 0.027
        lemon.rotation = Math.sin(now * 0.0009 + lemon.phase) * 10
      } else if (lemon.state === 'held') {
        if (left) {
          lemon.x = left.palm.x
          lemon.y = left.palm.y
          lemon.rotation = Math.sin(now * 0.006) * 5
          if (left.fist) {
            squish = 0.72 + Math.sin(now * 0.025) * 0.07
            lemon.juice = Math.max(0, lemon.juice - delta * 18)
            spawnJuiceStream(lemon)
          }
        } else if (now - lastLeftSeen > 420) {
          lemon.state = 'floating'
          lemon.baseX = lemon.x
          lemon.baseY = lemon.y
        }
        if (lemon.juice <= 0) {
          lemon.state = 'falling'
          lemon.element.classList.add('empty')
        }
      } else {
        lemon.y += delta * 0.58
        lemon.rotation += delta * 150
        squish = 0.64
        if (lemon.y > 1.2) {
          lemon.element.remove()
          lemon.state = 'falling'
          return
        }
      }
      renderLemon(lemon, squish)
    })
  }

  function ensureHandLandmarker(): Promise<HandLandmarker> {
    if (handLandmarker) return Promise.resolve(handLandmarker)
    if (!handLandmarkerLoading) {
      handLandmarkerLoading = (async () => {
        const { FilesetResolver, HandLandmarker: HandLandmarkerClass } = await import('@mediapipe/tasks-vision')
        handLandmarkerClass = HandLandmarkerClass
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
        handLandmarker = await HandLandmarkerClass.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_PATH },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.58,
          minHandPresenceConfidence: 0.55,
          minTrackingConfidence: 0.55,
        })
        return handLandmarker
      })()
      handLandmarkerLoading.catch(() => { handLandmarkerLoading = null })
    }
    return handLandmarkerLoading
  }

  async function activate() {
    if (running) return
    beginPreview()
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus('CAMERA UNSUPPORTED', 'error')
      return
    }
    try {
      setCameraStatus('REQUESTING CAMERA', 'ready')
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      video.srcObject = cameraStream
      await video.play()
      if (!isActive()) {
        cameraStream.getTracks().forEach((track) => track.stop())
        cameraStream = null
        video.srcObject = null
        return
      }
      running = true
      lastFrameTime = performance.now()
      cameraGate.classList.add('hidden')
      lemonLayer.classList.remove('camera-preview')
      setCameraStatus('CAMERA LIVE · LOADING TRACKER', 'ready')
      frameId = requestAnimationFrame(renderFrame)
      void ensureHandLandmarker()
        .then(() => {
          if (running && isActive()) setCameraStatus('HAND TRACKING ACTIVE', 'active')
        })
        .catch(() => {
          if (running && isActive()) setCameraStatus('HAND TRACKER UNAVAILABLE', 'error')
        })
    } catch {
      setCameraStatus('CAMERA ACCESS NEEDED', 'error')
      cameraGate.classList.remove('hidden')
      lemonLayer.classList.add('camera-preview')
    }
  }

  function deactivate() {
    running = false
    window.cancelAnimationFrame(frameId)
    window.cancelAnimationFrame(previewFrameId)
    previewFrameId = 0
    cameraStream?.getTracks().forEach((track) => track.stop())
    cameraStream = null
    video.srcObject = null
    latestLeft = null
    latestRight = null
    cameraGate.classList.remove('hidden')
    lemonLayer.classList.add('camera-preview')
    context.clearRect(0, 0, canvas.width, canvas.height)
  }

  function renderFrame(now: number) {
    if (!running || !isActive()) return
    const delta = Math.min((now - lastFrameTime) / 1000, 0.05)
    lastFrameTime = now
    updateHands()
    updateLemons(delta, now)
    updateCup(delta)
    updateDrops(delta, now)
    frameId = requestAnimationFrame(renderFrame)
  }

  function beginPreview() {
    if (previewFrameId) return
    previewLastFrameTime = performance.now()
    previewFrameId = requestAnimationFrame(renderPreview)
  }

  function renderPreview(now: number) {
    if (running || !isActive()) {
      previewFrameId = 0
      return
    }
    const delta = Math.min((now - previewLastFrameTime) / 1000, 0.05)
    previewLastFrameTime = now
    updateLemons(delta, now)
    updateCup(delta)
    updateDrops(delta, now)
    previewFrameId = requestAnimationFrame(renderPreview)
  }

  startCameraButton.addEventListener('click', () => { void activate() })
  refillButton.addEventListener('click', () => {
    cupFill = 0
    makeLemons()
  })

  lemonLayer.classList.add('camera-preview')
  makeLemons()
  return { activate, deactivate }
}
