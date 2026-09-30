import type { FaceLandmarker, HandLandmarker } from '@mediapipe/tasks-vision'
import './rubberHuman.css'

type Point = { x: number; y: number }
type Landmark = Point & { z: number }
type Grab = { relative: Point; target: Point; pull: Point; velocity: Point; holding: boolean }
type Face = { center: Point; radius: Point; outline: Point[] }

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const HAND_MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const FACE_MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
const MESH_COLUMNS = 34
const MESH_ROWS = 38

const vertexSource = `
  attribute vec2 aPosition;
  attribute vec2 aSource;
  varying vec2 vSource;
  void main() {
    vSource = aSource;
    gl_Position = vec4(aPosition, 0., 1.);
  }
`

const fragmentSource = `
  precision mediump float;
  varying vec2 vSource;
  uniform sampler2D uCamera;
  uniform vec2 uResolution;
  uniform vec2 uVideoSize;

  vec2 cameraUv(vec2 screenUv, out float visible) {
    vec2 uv = vec2(1. - screenUv.x, screenUv.y);
    float screenAspect = uResolution.x / max(uResolution.y, 1.);
    float videoAspect = uVideoSize.x / max(uVideoSize.y, 1.);
    if (screenAspect > videoAspect) uv.y = (uv.y - .5) * screenAspect / videoAspect + .5;
    else uv.x = (uv.x - .5) * videoAspect / screenAspect + .5;
    visible = step(0., uv.x) * step(uv.x, 1.) * step(0., uv.y) * step(uv.y, 1.);
    return uv;
  }

  void main() {
    float sourceVisible;
    vec3 camera = texture2D(uCamera, cameraUv(vSource, sourceVisible)).rgb;
    gl_FragColor = vec4(camera, 1.);
  }
`

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Shader compilation failed')
  return shader
}

export function setupRubberHuman(host: HTMLElement, isActive: () => boolean) {
  host.innerHTML = `
    <div class="rubber-stage">
      <video class="rubber-camera" autoplay muted playsinline></video>
      <canvas class="rubber-surface" aria-label="고무 얼굴 카메라"></canvas>
      <canvas class="rubber-hands" aria-hidden="true"></canvas>
      <div class="rubber-vignette"></div>
      <div class="rubber-heading"><span>INTERACTIVE CAMERA / 08</span><strong>RUBBER<br><em>HUMAN</em></strong></div>
      <div class="rubber-guide"><b>PINCH · PULL</b><p>얼굴을 엄지와 검지로 잡아<br>부드럽게 늘려 보세요.</p></div>
      <div class="rubber-status"><i></i><span class="rubber-status-text">CAMERA READY</span></div>
      <div class="rubber-reset-note">놓으면 천천히 원래 얼굴로 돌아와요.</div>
      <div class="rubber-gate"><p>RUBBER HUMAN</p><h1>얼굴을 잡아<br><em>늘려 보세요.</em></h1><button type="button">카메라 시작 <span>↗</span></button><small>엄지와 검지를 맞대면 시작됩니다.</small></div>
    </div>
  `

  const stage = host.querySelector<HTMLElement>('.rubber-stage')!
  const video = host.querySelector<HTMLVideoElement>('.rubber-camera')!
  const surface = host.querySelector<HTMLCanvasElement>('.rubber-surface')!
  const handsCanvas = host.querySelector<HTMLCanvasElement>('.rubber-hands')!
  const handContext = handsCanvas.getContext('2d')!
  const status = host.querySelector<HTMLElement>('.rubber-status-text')!
  const gate = host.querySelector<HTMLElement>('.rubber-gate')!
  const startButton = gate.querySelector<HTMLButtonElement>('button')!
  const gl = surface.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'high-performance' })

  let handTracker: HandLandmarker | null = null
  let handLoading: Promise<HandLandmarker> | null = null
  let faceTracker: FaceLandmarker | null = null
  let faceLoading: Promise<FaceLandmarker> | null = null
  let stream: MediaStream | null = null
  let running = false
  let frameId = 0
  let lastVideoTime = -1
  let lastFaceAt = 0
  let lastFaceVideoTime = -1
  let lastFrameAt = performance.now()
  let stageRect = stage.getBoundingClientRect()
  let program: WebGLProgram | null = null
  let texture: WebGLTexture | null = null
  let locations: Record<string, WebGLUniformLocation | null> = {}
  let buffers: { position: WebGLBuffer; source: WebGLBuffer; positionAttribute: number; sourceAttribute: number } | null = null
  let face: Face | null = null
  let visibleHands: Point[][] = []
  const grabs = new Map<string, Grab>()
  const resizeObserver = new ResizeObserver(() => { stageRect = stage.getBoundingClientRect() })
  resizeObserver.observe(stage)

  function setStatus(text: string, state: 'ready' | 'active' | 'error' = 'ready') {
    status.textContent = text
    host.dataset.rubberState = state
  }

  function screenPoint(landmark: Landmark): Point {
    const videoAspect = video.videoWidth / Math.max(video.videoHeight, 1)
    const screenAspect = stageRect.width / Math.max(stageRect.height, 1)
    let x = 1 - landmark.x
    let y = landmark.y
    if (screenAspect > videoAspect) {
      const renderedHeight = stageRect.width / videoAspect
      y = (y * renderedHeight - (renderedHeight - stageRect.height) / 2) / stageRect.height
    } else {
      const renderedWidth = stageRect.height * videoAspect
      x = (x * renderedWidth - (renderedWidth - stageRect.width) / 2) / stageRect.width
    }
    return { x, y }
  }

  function setupGl() {
    if (!gl || program) return Boolean(gl)
    const value = gl.createProgram()!
    gl.attachShader(value, compileShader(gl, gl.VERTEX_SHADER, vertexSource))
    gl.attachShader(value, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource))
    gl.linkProgram(value)
    if (!gl.getProgramParameter(value, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(value) || 'Shader linking failed')
    program = value
    const position = gl.getAttribLocation(program, 'aPosition')
    const source = gl.getAttribLocation(program, 'aSource')
    buffers = { position: gl.createBuffer()!, source: gl.createBuffer()!, positionAttribute: position, sourceAttribute: source }
    texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    locations = {
      camera: gl.getUniformLocation(program, 'uCamera'), resolution: gl.getUniformLocation(program, 'uResolution'), videoSize: gl.getUniformLocation(program, 'uVideoSize'),
    }
    return true
  }

  function updateHands(now: number) {
    if (!handTracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastVideoTime) return
    lastVideoTime = video.currentTime
    const result = handTracker.detectForVideo(video, now)
    const pinchingHands = new Set<string>()
    visibleHands = []
    for (const [index, rawLandmarks] of result.landmarks.slice(0, 2).entries()) {
      const landmarks = rawLandmarks as Landmark[]
      visibleHands.push(landmarks.map(screenPoint))
      const id = result.handedness[index]?.[0]?.categoryName ?? String(index)
      const thumb = screenPoint(landmarks[4])
      const indexTip = screenPoint(landmarks[8])
      const distance = Math.hypot(indexTip.x - thumb.x, indexTip.y - thumb.y)
      if (distance < .062) {
        const pinch = { x: (thumb.x + indexTip.x) / 2, y: (thumb.y + indexTip.y) / 2 }
        pinchingHands.add(id)
        const existing = grabs.get(id)
        if ((!existing || !existing.holding) && face) {
          const relative = { x: (pinch.x - face.center.x) / face.radius.x, y: (pinch.y - face.center.y) / face.radius.y }
          // Only create a grab when this hand first pinches actual face skin.
          if (relative.x * relative.x + relative.y * relative.y < .82) {
            grabs.set(id, { relative, target: { x: 0, y: 0 }, pull: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, holding: true })
          }
        }
        const grab = grabs.get(id)
        if (grab && face) {
          grab.holding = true
          const origin = { x: face.center.x + grab.relative.x * face.radius.x, y: face.center.y + grab.relative.y * face.radius.y }
          const target = { x: pinch.x - origin.x, y: pinch.y - origin.y }
          const length = Math.hypot(target.x, target.y)
          const limit = .36
          const scale = length > limit ? limit / length : 1
          // Limit radial pull length (not each axis) so its direction stays
          // true to the hand motion without folding the face mesh.
          grab.target.x = target.x * scale
          grab.target.y = target.y * scale
        }
      }
    }
    grabs.forEach((grab, id) => {
      if (pinchingHands.has(id)) return
      grab.holding = false
      grab.target.x = 0
      grab.target.y = 0
    })
  }

  function updateFace(now: number) {
    if (!faceTracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastFaceVideoTime || now - lastFaceAt < 50) return
    lastFaceVideoTime = video.currentTime
    lastFaceAt = now
    const result = faceTracker.detectForVideo(video, now)
    const landmarks = result.faceLandmarks[0] as Landmark[] | undefined
    if (!landmarks) { face = null; return }
    const left = screenPoint(landmarks[234])
    const right = screenPoint(landmarks[454])
    const top = screenPoint(landmarks[10])
    const chin = screenPoint(landmarks[152])
    const center = { x: (left.x + right.x + top.x + chin.x) / 4, y: (left.y + right.y + top.y + chin.y) / 4 }
    const radius = { x: Math.max(.08, Math.hypot(right.x - left.x, right.y - left.y) * .57), y: Math.max(.1, Math.hypot(chin.x - top.x, chin.y - top.y) * .55) }
    face = { center, radius, outline: FACE_OVAL.map((index) => screenPoint(landmarks[index])) }
  }

  function insidePolygon(point: Point, polygon: Point[]) {
    let inside = false
    for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
      const first = polygon[a]
      const second = polygon[b]
      const crosses = (first.y > point.y) !== (second.y > point.y)
      if (crosses && point.x < (second.x - first.x) * (point.y - first.y) / (second.y - first.y) + first.x) inside = !inside
    }
    return inside
  }

  function convexHull(points: Point[]) {
    const sorted = [...points].sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x)
    if (sorted.length < 3) return sorted
    const cross = (origin: Point, a: Point, b: Point) => (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
    const lower: Point[] = []
    sorted.forEach((point) => { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop(); lower.push(point) })
    const upper: Point[] = []
    sorted.slice().reverse().forEach((point) => { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop(); upper.push(point) })
    return lower.slice(0, -1).concat(upper.slice(0, -1))
  }

  function deformationAt(point: Point) {
    if (!face) return { x: 0, y: 0 }
    const result = { x: 0, y: 0 }
    const edge = Math.hypot((point.x - face.center.x) / face.radius.x, (point.y - face.center.y) / face.radius.y)
    const boundaryAnchor = 1 - Math.pow(Math.min(1, Math.max(0, (edge - .6) / .4)), 1.7)
    grabs.forEach((grab) => {
      const pullLength = Math.hypot(grab.pull.x, grab.pull.y)
      if (pullLength < .0002) return
      const origin = { x: face!.center.x + grab.relative.x * face!.radius.x, y: face!.center.y + grab.relative.y * face!.radius.y }
      const direction = { x: grab.pull.x / pullLength, y: grab.pull.y / pullLength }
      const toVertex = { x: point.x - origin.x, y: point.y - origin.y }
      const along = toVertex.x * direction.x + toVertex.y * direction.y
      const radius = .13 + Math.min(.15, pullLength * .4)
      const lobe = Math.exp(-Math.pow(Math.hypot(toVertex.x, toVertex.y) / radius, 2) * 1.45)
      // Lock the half of the face behind the picked point. The grabbed point
      // itself moves, but influence drops rapidly across the plane opposite
      // the pull direction instead of towing the other cheek along.
      const forwardOnly = .12 + .88 * (1 / (1 + Math.exp(-(along + .025) * 52)))
      const influence = lobe * forwardOnly * boundaryAnchor
      result.x += grab.pull.x * influence
      result.y += grab.pull.y * influence
    })
    return result
  }

  function updateSpring(dt: number) {
    grabs.forEach((grab, id) => {
      // Keep a held pull steady, then deliberately under-damp the release so
      // the skin overshoots and settles like elastic flesh rather than simply
      // easing back to its original position.
      const stiffness = grab.holding ? 210 : 178
      const damping = grab.holding ? 24 : 7.4
      for (const axis of ['x', 'y'] as const) {
        grab.velocity[axis] += (grab.target[axis] - grab.pull[axis]) * stiffness * dt
        grab.velocity[axis] *= Math.exp(-damping * dt)
        grab.pull[axis] += grab.velocity[axis] * dt
      }
      if (!grab.holding && Math.hypot(grab.pull.x, grab.pull.y, grab.velocity.x, grab.velocity.y) < .00032) grabs.delete(id)
    })
  }

  function addTriangle(targetPositions: number[], targetSources: number[], outputA: Point, outputB: Point, outputC: Point, sourceA: Point, sourceB: Point, sourceC: Point) {
    ;[[outputA, sourceA], [outputB, sourceB], [outputC, sourceC]].forEach(([output, source]) => {
      targetPositions.push(output.x * 2 - 1, 1 - output.y * 2)
      targetSources.push(source.x, source.y)
    })
  }

  function drawMesh(positions: number[], sources: number[]) {
    if (!gl || !buffers || !positions.length) return
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(buffers.positionAttribute)
    gl.vertexAttribPointer(buffers.positionAttribute, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.source)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(sources), gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(buffers.sourceAttribute)
    gl.vertexAttribPointer(buffers.sourceAttribute, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, positions.length / 2)
  }

  function drawFaceMesh() {
    if (!face) return
    const positions: number[] = []
    const sources: number[] = []
    const grid: Point[][] = []
    for (let row = 0; row <= MESH_ROWS; row += 1) {
      const cells: Point[] = []
      for (let column = 0; column <= MESH_COLUMNS; column += 1) {
        cells.push({ x: face.center.x + ((column / MESH_COLUMNS) * 2 - 1) * face.radius.x, y: face.center.y + ((row / MESH_ROWS) * 2 - 1) * face.radius.y })
      }
      grid.push(cells)
    }
    for (let row = 0; row < MESH_ROWS; row += 1) {
      for (let column = 0; column < MESH_COLUMNS; column += 1) {
        const a = grid[row][column]
        const b = grid[row][column + 1]
        const c = grid[row + 1][column]
        const d = grid[row + 1][column + 1]
        const center = { x: (a.x + b.x + c.x + d.x) / 4, y: (a.y + b.y + c.y + d.y) / 4 }
        if (!insidePolygon(center, face.outline)) continue
        const output = [a, b, c, d].map((point) => {
          const deformation = deformationAt(point)
          return { x: point.x + deformation.x, y: point.y + deformation.y }
        })
        addTriangle(positions, sources, output[0], output[1], output[2], a, b, c)
        addTriangle(positions, sources, output[2], output[1], output[3], c, b, d)
      }
    }
    drawMesh(positions, sources)
  }

  function drawHandOverlays() {
    visibleHands.forEach((hand) => {
      const hull = convexHull(hand)
      if (hull.length < 3) return
      const center = hull.reduce((sum, point) => ({ x: sum.x + point.x / hull.length, y: sum.y + point.y / hull.length }), { x: 0, y: 0 })
      const positions: number[] = []
      const sources: number[] = []
      hull.forEach((point, index) => addTriangle(positions, sources, center, point, hull[(index + 1) % hull.length], center, point, hull[(index + 1) % hull.length]))
      drawMesh(positions, sources)
    })
  }

  function drawSurface() {
    if (!gl || !program || !texture || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
    const width = Math.max(1, Math.round(stageRect.width * ratio))
    const height = Math.max(1, Math.round(stageRect.height * ratio))
    if (surface.width !== width || surface.height !== height) { surface.width = width; surface.height = height; gl.viewport(0, 0, width, height) }
    gl.useProgram(program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
    gl.uniform1i(locations.camera, 0)
    gl.uniform2f(locations.resolution, width, height)
    gl.uniform2f(locations.videoSize, video.videoWidth, video.videoHeight)
    // Base camera, deformed face mesh, then the unmodified hand texture.
    drawMesh([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1], [0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0])
    drawFaceMesh()
    drawHandOverlays()
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
        faceTracker = await FaceLandmarkerClass.createFromOptions(vision, { baseOptions: { modelAssetPath: FACE_MODEL_PATH }, runningMode: 'VIDEO', numFaces: 1, minFaceDetectionConfidence: .55, minFacePresenceConfidence: .55, minTrackingConfidence: .55 })
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
      if (!setupGl()) throw new Error('WebGL unavailable')
      stageRect = stage.getBoundingClientRect()
      running = true
      gate.classList.add('hidden')
      lastFrameAt = performance.now()
      setStatus('CAMERA LIVE · FINDING FACE')
      frameId = requestAnimationFrame(render)
      void ensureHandTracker().then(() => { if (running) setStatus('PINCH READY', 'active') }).catch(() => { if (running) setStatus('HAND TRACKER UNAVAILABLE', 'error') })
      void ensureFaceTracker().then(() => { if (running) setStatus('FACE + PINCH READY', 'active') }).catch(() => { if (running) setStatus('FACE TRACKER UNAVAILABLE', 'error') })
    } catch {
      setStatus('CAMERA / WEBGL NEEDED', 'error')
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
    face = null
    grabs.clear()
    handContext.clearRect(0, 0, handsCanvas.width, handsCanvas.height)
    gate.classList.remove('hidden')
  }

  function render(now: number) {
    if (!running || !isActive()) return
    const dt = Math.min(.05, (now - lastFrameAt) / 1000)
    lastFrameAt = now
    updateHands(now)
    updateFace(now)
    updateSpring(dt)
    drawSurface()
    frameId = requestAnimationFrame(render)
  }

  startButton.addEventListener('click', () => { void activate() })
  return { activate, deactivate }
}
