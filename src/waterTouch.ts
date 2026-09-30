import type { HandLandmarker } from '@mediapipe/tasks-vision'
import './waterTouch.css'

type Point = { x: number; y: number }
type Landmark = Point & { z: number }
type Ripple = { x: number; y: number; born: number; strength: number }

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const FINGER_TIPS = [4, 8, 12, 16, 20]
const MAX_FINGERS = 10
const MAX_RIPPLES = 28

const vertexSource = `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = aPosition * .5 + .5;
    gl_Position = vec4(aPosition, 0., 1.);
  }
`

const fragmentSource = `
  precision mediump float;
  varying vec2 vUv;
  uniform sampler2D uCamera;
  uniform vec2 uResolution;
  uniform vec2 uVideoSize;
  uniform float uTime;
  uniform vec4 uFingers[10];
  uniform vec2 uMotion[10];
  uniform vec4 uRipples[28];

  vec2 originalCameraUv(vec2 uv, out float visible) {
    float screenAspect = uResolution.x / uResolution.y;
    float videoAspect = uVideoSize.x / uVideoSize.y;
    if (screenAspect > videoAspect) uv.x = (uv.x - .5) * screenAspect / videoAspect + .5;
    else uv.y = (uv.y - .5) * videoAspect / screenAspect + .5;
    visible = step(0., uv.x) * step(uv.x, 1.) * step(0., uv.y) * step(uv.y, 1.);
    return uv;
  }

  void main() {
    vec2 uv = vUv;
    vec2 displacement = vec2(0.);
    float shimmer = 0.;
    for (int i = 0; i < 10; i++) {
      vec4 finger = uFingers[i];
      if (finger.z > .0) {
        vec2 delta = uv - finger.xy;
        float distance = length(delta) + .0001;
        float contact = exp(-distance * 38.);
        float contactRing = exp(-pow(distance - .026, 2.) * 1900.);
        displacement += normalize(delta) * (contactRing * .0042 + contact * sin(uTime * 8.) * .0012) * finger.w;
        vec2 motion = uMotion[i];
        float speed = min(length(motion) * 2.8, 1.);
        if (speed > .01) {
          vec2 direction = normalize(motion);
          float along = dot(delta, direction);
          float across = dot(delta, vec2(-direction.y, direction.x));
          float trailingWater = exp(-abs(across) * 18.) * (1. - smoothstep(-.18, .02, along)) * smoothstep(-.24, -.01, along);
          displacement += vec2(-direction.y, direction.x) * sin(across * 88.) * trailingWater * speed * .0042 * finger.w;
        }
      }
    }
    for (int i = 0; i < 28; i++) {
      vec4 ripple = uRipples[i];
      float age = uTime - ripple.z;
      if (ripple.w > .0 && age > 0. && age < 1.9) {
        vec2 delta = uv - ripple.xy;
        float distance = length(delta) + .0001;
        float radius = age * .28;
        float primaryRing = exp(-pow(distance - radius, 2.) * 3100.);
        float secondaryRing = exp(-pow(distance - max(radius - .038, 0.), 2.) * 2600.) * .34;
        float fade = exp(-age * .72);
        float rings = (primaryRing + secondaryRing) * fade * ripple.w;
        displacement += normalize(delta) * rings * .011 * ripple.w;
        shimmer += rings * .32;
      }
    }
    float visible;
    vec2 cameraUv = originalCameraUv(vec2(1. - uv.x, uv.y) + displacement, visible);
    vec4 camera = texture2D(uCamera, cameraUv);
    camera.rgb += vec3(.035, .11, .13) * shimmer;
    gl_FragColor = mix(vec4(.015, .075, .09, 1.), camera, visible);
  }
`

function shader(gl: WebGLRenderingContext, type: number, source: string) {
  const value = gl.createShader(type)!
  gl.shaderSource(value, source)
  gl.compileShader(value)
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value) || 'Shader error')
  return value
}

export function setupWaterTouch(host: HTMLElement, isActive: () => boolean) {
  host.innerHTML = `
    <div class="water-stage">
      <video id="water-camera" class="water-camera" autoplay muted playsinline></video>
      <canvas id="water-surface" class="water-surface"></canvas>
      <canvas id="water-fingers" class="water-fingers" aria-hidden="true"></canvas>
      <div class="water-tint"></div>
    </div>
    <div class="water-heading"><span>INTERACTIVE CAMERA / 04</span><strong>WATER<br><em>TOUCH</em></strong></div>
    <div class="water-guide"><b>BOTH HANDS · 10 FINGERS</b><p>손끝으로 화면의 물결을 움직여 보세요.</p></div>
    <div class="water-status"><i></i><span id="water-status">CAMERA READY</span></div>
    <div id="water-gate" class="water-gate"><p>WATERTOUCH</p><h1>손끝으로 <em>물결을 만드세요.</em></h1><button id="water-start" type="button">카메라 시작 <span>↗</span></button></div>
  `

  const video = host.querySelector<HTMLVideoElement>('#water-camera')!
  const stage = host.querySelector<HTMLElement>('.water-stage')!
  const surface = host.querySelector<HTMLCanvasElement>('#water-surface')!
  const fingerCanvas = host.querySelector<HTMLCanvasElement>('#water-fingers')!
  const fingerContext = fingerCanvas.getContext('2d')!
  const status = host.querySelector<HTMLElement>('#water-status')!
  const gate = host.querySelector<HTMLElement>('#water-gate')!
  const startButton = host.querySelector<HTMLButtonElement>('#water-start')!
  const gl = surface.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'high-performance' })

  let tracker: HandLandmarker | null = null
  let trackerLoading: Promise<HandLandmarker> | null = null
  let stream: MediaStream | null = null
  let running = false
  let frameId = 0
  let lastVideoTime = -1
  let lastTextureVideoTime = -1
  let texture: WebGLTexture | null = null
  let program: WebGLProgram | null = null
  let locations: Record<string, WebGLUniformLocation | null> = {}
  let fingerValues = new Float32Array(MAX_FINGERS * 4)
  let motionValues = new Float32Array(MAX_FINGERS * 2)
  const rippleValues = new Float32Array(MAX_RIPPLES * 4)
  let visibleFingers: Point[] = []
  let ripples: Ripple[] = []
  let stageRect = stage.getBoundingClientRect()
  let overlayDirty = true
  const previousTips = new Map<string, Point>()
  const lastRippleAt = new Map<string, number>()

  function setStatus(text: string, state: 'ready' | 'active' | 'error' = 'ready') {
    status.textContent = text
    host.dataset.waterState = state
  }

  function resizeStage() {
    const rect = host.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9
    let width = rect.width * .7
    let height = width / aspect
    if (height > rect.height * .7) {
      height = rect.height * .7
      width = height * aspect
    }
    stage.style.width = `${width}px`
    stage.style.height = `${height}px`
    host.style.setProperty('--water-aspect', `${aspect}`)
    stageRect = stage.getBoundingClientRect()
    overlayDirty = true
  }

  const stageObserver = new ResizeObserver(resizeStage)
  stageObserver.observe(host)

  function setupGl() {
    if (!gl || program) return Boolean(gl)
    const value = gl.createProgram()!
    gl.attachShader(value, shader(gl, gl.VERTEX_SHADER, vertexSource))
    gl.attachShader(value, shader(gl, gl.FRAGMENT_SHADER, fragmentSource))
    gl.linkProgram(value)
    if (!gl.getProgramParameter(value, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(value) || 'Program error')
    program = value
    const buffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'aPosition')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    locations = {
      camera: gl.getUniformLocation(program, 'uCamera'), resolution: gl.getUniformLocation(program, 'uResolution'),
      videoSize: gl.getUniformLocation(program, 'uVideoSize'), time: gl.getUniformLocation(program, 'uTime'),
      fingers: gl.getUniformLocation(program, 'uFingers[0]'), motion: gl.getUniformLocation(program, 'uMotion[0]'),
      ripples: gl.getUniformLocation(program, 'uRipples[0]'),
    }
    return true
  }

  function screenPoint(landmark: Landmark): Point {
    const rect = stageRect
    const videoAspect = video.videoWidth / Math.max(video.videoHeight, 1)
    const screenAspect = rect.width / Math.max(rect.height, 1)
    let x = 1 - landmark.x
    let y = landmark.y
    if (screenAspect > videoAspect) x = (x - .5) * (videoAspect / screenAspect) + .5
    else y = (y - .5) * (screenAspect / videoAspect) + .5
    return { x, y }
  }

  function addRipple(point: Point, strength: number, now: number) {
    ripples.push({ x: point.x, y: point.y, born: now / 1000, strength })
    if (ripples.length > MAX_RIPPLES) ripples.shift()
  }

  function updateHands(now: number) {
    if (!tracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastVideoTime) return
    lastVideoTime = video.currentTime
    fingerValues.fill(0)
    motionValues.fill(0)
    visibleFingers.length = 0
    const result = tracker.detectForVideo(video, now)
    let slot = 0
    result.landmarks.forEach((rawLandmarks, handIndex) => {
      const landmarks = rawLandmarks as Landmark[]
      const label = result.handedness[handIndex]?.[0]?.categoryName ?? String(handIndex)
      // MediaPipe z becomes more negative as the hand comes closer to the camera.
      const averageDepth = landmarks.reduce((total, landmark) => total + landmark.z, 0) / landmarks.length
      const proximity = Math.min(1.45, Math.max(.4, 1 - averageDepth * 4.5))
      FINGER_TIPS.forEach((tip) => {
        if (slot >= MAX_FINGERS) return
        const point = screenPoint(landmarks[tip])
        const waterPoint = { x: point.x, y: 1 - point.y }
        fingerValues[slot * 4] = point.x
        fingerValues[slot * 4 + 1] = waterPoint.y
        fingerValues[slot * 4 + 2] = 1
        fingerValues[slot * 4 + 3] = proximity
        visibleFingers.push(point)
        const key = `${label}-${tip}`
        const previous = previousTips.get(key)
        const last = lastRippleAt.get(key) ?? 0
        if (previous) {
          motionValues[slot * 2] = waterPoint.x - previous.x
          motionValues[slot * 2 + 1] = waterPoint.y - previous.y
        }
        const movement = previous ? Math.hypot(waterPoint.x - previous.x, waterPoint.y - previous.y) : .03
        if (movement > .006 && now - last > 700) {
          addRipple(waterPoint, Math.min(1.6, (.7 + movement * 13) * proximity), now)
          lastRippleAt.set(key, now)
        }
        previousTips.set(key, waterPoint)
        slot += 1
      })
    })
    overlayDirty = true
  }

  function drawFingerOverlay() {
    const rect = stageRect
    const ratio = Math.min(window.devicePixelRatio, 1.5)
    const width = Math.max(1, Math.floor(rect.width * ratio))
    const height = Math.max(1, Math.floor(rect.height * ratio))
    const resized = fingerCanvas.width !== width || fingerCanvas.height !== height
    if (resized) {
      fingerCanvas.width = width
      fingerCanvas.height = height
    }
    if (!overlayDirty && !resized) return
    fingerContext.clearRect(0, 0, width, height)
    visibleFingers.forEach((finger) => {
      fingerContext.strokeStyle = 'rgba(220, 255, 250, .85)'
      fingerContext.lineWidth = 1.5 * ratio
      fingerContext.beginPath()
      fingerContext.arc(finger.x * width, finger.y * height, 10 * ratio, 0, Math.PI * 2)
      fingerContext.stroke()
      fingerContext.fillStyle = 'rgba(207, 255, 245, .9)'
      fingerContext.beginPath()
      fingerContext.arc(finger.x * width, finger.y * height, 2.6 * ratio, 0, Math.PI * 2)
      fingerContext.fill()
    })
    overlayDirty = false
  }

  function drawSurface(now: number) {
    if (!gl || !program || !texture || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    const rect = stageRect
    const ratio = Math.min(window.devicePixelRatio, 1.5)
    const width = Math.max(1, Math.floor(rect.width * ratio))
    const height = Math.max(1, Math.floor(rect.height * ratio))
    if (surface.width !== width || surface.height !== height) {
      surface.width = width
      surface.height = height
      gl.viewport(0, 0, width, height)
    }
    rippleValues.fill(0)
    let activeRipples = 0
    for (const ripple of ripples) {
      if (now / 1000 - ripple.born >= 1.9) continue
      ripples[activeRipples] = ripple
      const offset = activeRipples * 4
      rippleValues[offset] = ripple.x
      rippleValues[offset + 1] = ripple.y
      rippleValues[offset + 2] = ripple.born
      rippleValues[offset + 3] = ripple.strength
      activeRipples += 1
    }
    ripples.length = activeRipples
    gl.useProgram(program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    if (video.currentTime !== lastTextureVideoTime) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
      lastTextureVideoTime = video.currentTime
    }
    gl.uniform1i(locations.camera, 0)
    gl.uniform2f(locations.resolution, width, height)
    gl.uniform2f(locations.videoSize, video.videoWidth, video.videoHeight)
    gl.uniform1f(locations.time, now / 1000)
    gl.uniform4fv(locations.fingers, fingerValues)
    gl.uniform2fv(locations.motion, motionValues)
    gl.uniform4fv(locations.ripples, rippleValues)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
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

  async function activate() {
    if (running) return
    try {
      if (!setupGl()) throw new Error('WebGL unsupported')
      setStatus('REQUESTING CAMERA')
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      video.srcObject = stream
      await video.play()
      if (video.videoWidth && video.videoHeight) host.style.setProperty('--water-aspect', `${video.videoWidth} / ${video.videoHeight}`)
      resizeStage()
      if (!isActive()) { deactivate(); return }
      running = true
      gate.classList.add('hidden')
      setStatus('CAMERA LIVE · LOADING HANDS')
      frameId = requestAnimationFrame(render)
      void ensureTracker().then(() => {
        if (running) setStatus('10 FINGERS TRACKING', 'active')
      }).catch(() => {
        if (running) setStatus('HAND TRACKER UNAVAILABLE', 'error')
      })
    } catch {
      setStatus('CAMERA / WEBGL ACCESS NEEDED', 'error')
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
    lastTextureVideoTime = -1
    visibleFingers.length = 0
    fingerValues.fill(0)
    motionValues.fill(0)
    overlayDirty = true
    fingerContext.clearRect(0, 0, fingerCanvas.width, fingerCanvas.height)
    gate.classList.remove('hidden')
  }

  function render(now: number) {
    if (!running || !isActive()) return
    updateHands(now)
    drawSurface(now)
    drawFingerOverlay()
    frameId = requestAnimationFrame(render)
  }

  startButton.addEventListener('click', () => { void activate() })
  return { activate, deactivate }
}
