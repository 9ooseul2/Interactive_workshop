import type { HandLandmarker } from '@mediapipe/tasks-vision'
import './whoAreYou.css'

type Point = { x: number; y: number }
type Landmark = Point & { z: number }
type GestureState = 'IDLE' | 'FIST_READY' | 'FORWARD' | 'KNOCK_TRIGGERED' | 'COOLDOWN'

type HandObservation = {
  fist: boolean
  fistMode: 'strict' | 'side-facing' | 'relaxed' | 'forward-facing' | 'none'
  foldedFingers: number
  thumbFolded: boolean
  scale: number
  depth: number
  palm: Point
  screenPalm: Point
  screenBounds: { x: number; y: number; width: number; height: number }
  scaleVelocity: number
}

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const HAND_MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

// Tuned for a natural three-beat door knock: still temporal, but responsive
// enough that the user does not have to hold each fist pose for a full second.
const FIST_STABLE_MS = 75
const THRUST_MIN_DELAY_MS = 45
const THRUST_MAX_DELAY_MS = 500
const COOLDOWN_MS = 220
const KNOCKS_REQUIRED = 3
const MIN_SCALE_RATIO = 1.03
const MIN_SCALE_VELOCITY = 0.00002
const MIN_DEPTH_DELTA = 0.00005
const FIST_LOSS_GRACE_MS = 180
// Lens controls are intentionally independent: a shallow strength avoids an
// inflated center, while the oversized influence radius carries a gentle curve
// through almost the entire circular peephole.
const FISHEYE_STRENGTH = .35
// Vertical distortion is deliberately weaker than horizontal distortion. It
// prevents lower-face features from being pulled into a long oval while the
// center still has a friendly convex-lens presence.
const FISHEYE_VERTICAL_STRENGTH = .55
const FISHEYE_INFLUENCE_RADIUS = 1.7
const FISHEYE_FALLOFF = 1.4
// Samples a wider portion of the camera before the radial mapping compresses
// it back into the circular lens. Values above 1.0 create a true wide FOV.
const FISHEYE_WIDE_SCALE = 2.0

const vertexShader = `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = aPosition * .5 + .5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`

const fragmentShader = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uVideo;
  uniform vec2 uResolution;
  uniform vec2 uVideoResolution;
  uniform vec2 uPeepholeCenter;
  uniform float uPeephole;
  uniform float uLensScale;
  uniform float uFisheyeStrength;
  uniform float uFisheyeVerticalStrength;
  uniform float uFisheyeInfluenceRadius;
  uniform float uFisheyeFalloff;
  uniform float uFisheyeWideScale;

  vec2 coverUv(vec2 screenUv) {
    float screenAspect = uResolution.x / max(uResolution.y, 1.0);
    float videoAspect = uVideoResolution.x / max(uVideoResolution.y, 1.0);
    vec2 uv = screenUv;
    if (screenAspect > videoAspect) {
      uv.y = (uv.y - .5) * screenAspect / videoAspect + .5;
    } else {
      uv.x = (uv.x - .5) * videoAspect / screenAspect + .5;
    }
    uv.x = 1.0 - uv.x;
    return clamp(uv, 0.001, .999);
  }

  vec3 camera(vec2 screenUv) {
    return texture2D(uVideo, coverUv(screenUv)).rgb;
  }

  vec3 strongBlur(vec2 uv) {
    vec2 texel = 1.0 / uResolution;
    vec2 a = texel * vec2(26.0, 26.0);
    vec2 b = texel * vec2(13.0, 13.0);
    vec3 color = camera(uv) * .12;
    color += camera(uv + vec2( a.x, 0.0)) * .075;
    color += camera(uv + vec2(-a.x, 0.0)) * .075;
    color += camera(uv + vec2(0.0,  a.y)) * .075;
    color += camera(uv + vec2(0.0, -a.y)) * .075;
    color += camera(uv + vec2( b.x,  b.y)) * .06;
    color += camera(uv + vec2(-b.x,  b.y)) * .06;
    color += camera(uv + vec2( b.x, -b.y)) * .06;
    color += camera(uv + vec2(-b.x, -b.y)) * .06;
    color += camera(uv + vec2( a.x,  a.y)) * .045;
    color += camera(uv + vec2(-a.x,  a.y)) * .045;
    color += camera(uv + vec2( a.x, -a.y)) * .045;
    color += camera(uv + vec2(-a.x, -a.y)) * .045;
    return color / .84;
  }

  void main() {
    float screenAspect = uResolution.x / max(uResolution.y, 1.0);
    // Establish the lens-local coordinate system from the peephole's actual
    // center and physical radius. This is deliberately independent of the
    // full camera frame's center.
    vec2 physical = vUv - uPeepholeCenter;
    physical.x *= screenAspect;
    float lensRadius = .4 * uLensScale;
    vec2 localLens = physical / lensRadius;
    float r = length(localLens);
    float edge = 1.0 - smoothstep(.985, 1.0, r);

    // The resting camera keeps its 60% blackout. As the peephole opens, the
    // outer image both blurs and deepens to an 80% blackout without dimming
    // the sharp lens interior.
    vec3 unblurredOutside = camera(vUv) * .4;
    vec3 blurredOutside = strongBlur(vUv) * .2;
    vec3 outside = mix(unblurredOutside, blurredOutside, uPeephole);

    // The mapping multiplier begins only mildly magnified at the center and
    // eases toward the rim over a radius larger than the lens itself. This
    // produces one broad, shallow convex surface instead of a center bulge
    // followed by heavily compressed edges.
    float influencedRadius = min(r / uFisheyeInfluenceRadius, 1.0);
    float convexInfluence = 1.0 - pow(influencedRadius, uFisheyeFalloff);
    float radialMappingX = 1.0 - uFisheyeStrength * convexInfluence;
    float radialMappingY = 1.0 - uFisheyeVerticalStrength * convexInfluence;
    vec3 inside = camera(vUv);
    if (r <= 1.0) {
      // Distort in lens-local space, then convert the displaced local point
      // back into its matching screen/video position. The fisheye therefore
      // occupies exactly this circular peephole instead of a warped full frame
      // being cropped after the fact.
      // First zoom out in peephole-local space to collect more of the webcam
      // scene, then compress that wider field through the fisheye curve.
      vec2 wideLocal = localLens * uFisheyeWideScale;
      vec2 distortedLocal = wideLocal * vec2(radialMappingX, radialMappingY);
      vec2 sourcePhysical = distortedLocal * lensRadius;
      vec2 lensScreenUv = uPeepholeCenter + vec2(sourcePhysical.x / screenAspect, sourcePhysical.y);
      inside = camera(lensScreenUv);
    }
    float innerVignette = smoothstep(.68, 1.0, r);
    inside *= 1.0 - innerVignette * .58;
    float rim = smoothstep(.90, .995, r);
    inside = mix(inside, vec3(.012, .014, .019), rim * .84);

    vec3 image = mix(outside, inside, edge * uPeephole);
    gl_FragColor = vec4(image, 1.0);
  }
`

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)) }
function lerp(from: number, to: number, amount: number) { return from + (to - from) * amount }
function distance(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y) }
function average(points: Point[]): Point {
  const sum = points.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 })
  return { x: sum.x / points.length, y: sum.y / points.length }
}

function jointAngle(a: Point, b: Point, c: Point) {
  const first = { x: a.x - b.x, y: a.y - b.y }
  const second = { x: c.x - b.x, y: c.y - b.y }
  const denominator = Math.max(.000001, Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y))
  return Math.acos(clamp((first.x * second.x + first.y * second.y) / denominator, -1, 1))
}

function jointAngle3d(a: Landmark, b: Landmark, c: Landmark) {
  const first = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
  const second = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z }
  const denominator = Math.max(.000001, Math.hypot(first.x, first.y, first.z) * Math.hypot(second.x, second.y, second.z))
  return Math.acos(clamp((first.x * second.x + first.y * second.y + first.z * second.z) / denominator, -1, 1))
}

function easeOutCubic(value: number) { return 1 - Math.pow(1 - clamp(value, 0, 1), 3) }

export function setupWhoAreYou(host: HTMLElement, isActive: () => boolean) {
  host.innerHTML = `
    <div class="who-are-you-stage">
      <video class="who-are-you-video" autoplay muted playsinline></video>
      <div class="who-are-you-base-darkness" aria-hidden="true"></div>
      <canvas class="who-are-you-render" aria-label="실시간 외시경 뷰"></canvas>
      <canvas class="who-are-you-debug-drawing" aria-hidden="true"></canvas>
      <div class="who-are-you-punctuation" aria-hidden="true">
        ${Array.from({ length: 150 }, () => '<span><i>?</i></span>').join('')}
      </div>
      <button class="who-are-you-reset" type="button" aria-label="외시경 닫기">×</button>
    </div>
  `

  const stage = host.querySelector<HTMLElement>('.who-are-you-stage')!
  const video = host.querySelector<HTMLVideoElement>('.who-are-you-video')!
  const canvas = host.querySelector<HTMLCanvasElement>('.who-are-you-render')!
  const debugCanvas = host.querySelector<HTMLCanvasElement>('.who-are-you-debug-drawing')!
  const debugContext = debugCanvas.getContext('2d')!
  const punctuation = [...host.querySelectorAll<HTMLElement>('.who-are-you-punctuation > span')]
  const resetButton = host.querySelector<HTMLButtonElement>('.who-are-you-reset')!

  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false })
  let program: WebGLProgram | null = null
  let texture: WebGLTexture | null = null
  let positionBuffer: WebGLBuffer | null = null
  let uniforms: Record<string, WebGLUniformLocation | null> = {}
  let handTracker: HandLandmarker | null = null
  let handLoading: Promise<HandLandmarker> | null = null
  let stream: MediaStream | null = null
  let running = false
  let frameId = 0
  let lastVideoTime = -1
  let stageRect = stage.getBoundingClientRect()
  let pixelRatio = 1
  let gestureState: GestureState = 'IDLE'
  let fistStartedAt: number | null = null
  let lastFistSeenAt = -Infinity
  let readyAt = 0
  let readyScale = 0
  let readyDepth = 0
  let forwardAt = 0
  let cooldownUntil = 0
  let knockCount = 0
  let peepholeStartedAt = -Infinity
  let peepholeVisible = false
  let smoothedScale: number | null = null
  let smoothedDepth: number | null = null
  let previousScale: number | null = null
  let previousScaleAt = 0
  let observation: HandObservation | null = null

  const basePunctuationLayout = [
    { x: 8, size: 23, rotation: -16, duration: 7.4, delay: -4.6 },
    { x: 20, size: 31, rotation: 11, duration: 6.3, delay: -1.9 },
    { x: 32, size: 20, rotation: -8, duration: 8.1, delay: -6.8 },
    { x: 67, size: 28, rotation: 14, duration: 7.0, delay: -2.7 },
    { x: 80, size: 22, rotation: -12, duration: 8.5, delay: -5.2 },
    { x: 91, size: 34, rotation: 18, duration: 6.6, delay: -3.8 },
    { x: 43, size: 18, rotation: 7, duration: 9.0, delay: -7.3 },
    { x: 57, size: 25, rotation: -6, duration: 7.7, delay: -1.1 },
  ]
  const punctuationLayout = Array.from({ length: 150 }, (_, index) => {
    const shape = basePunctuationLayout[index % basePunctuationLayout.length]
    const group = Math.floor(index / basePunctuationLayout.length)
    return {
    x: 3 + (shape.x + group * 13 + index * 7) % 94,
    size: shape.size * (.72 + (group % 4) * .09) * 3,
    rotation: shape.rotation + ((group % 7) - 3) * 5,
    // A duration divided by 1.1 means 10% faster than the previous motion.
    duration: (shape.duration + (group % 5) * .42) / 1.1,
    delay: shape.delay - group * .31 - index * .08,
    }
  })

  const resizeObserver = new ResizeObserver(() => {
    stageRect = stage.getBoundingClientRect()
    resizeCanvases()
  })
  resizeObserver.observe(stage)

  function setStatus(text: string) { host.dataset.whoAreYouStatus = text }

  function compileShader(type: number, source: string) {
    if (!gl) return null
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
    gl.deleteShader(shader)
    return null
  }

  function setupRenderer() {
    if (!gl) return false
    const vertex = compileShader(gl.VERTEX_SHADER, vertexShader)
    const fragment = compileShader(gl.FRAGMENT_SHADER, fragmentShader)
    if (!vertex || !fragment) return false
    program = gl.createProgram()
    if (!program) return false
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false
    positionBuffer = gl.createBuffer()
    texture = gl.createTexture()
    if (!positionBuffer || !texture) return false
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    uniforms = {
      video: gl.getUniformLocation(program, 'uVideo'),
      resolution: gl.getUniformLocation(program, 'uResolution'),
      videoResolution: gl.getUniformLocation(program, 'uVideoResolution'),
      peepholeCenter: gl.getUniformLocation(program, 'uPeepholeCenter'),
      peephole: gl.getUniformLocation(program, 'uPeephole'),
      lensScale: gl.getUniformLocation(program, 'uLensScale'),
      fisheyeStrength: gl.getUniformLocation(program, 'uFisheyeStrength'),
      fisheyeVerticalStrength: gl.getUniformLocation(program, 'uFisheyeVerticalStrength'),
      fisheyeInfluenceRadius: gl.getUniformLocation(program, 'uFisheyeInfluenceRadius'),
      fisheyeFalloff: gl.getUniformLocation(program, 'uFisheyeFalloff'),
      fisheyeWideScale: gl.getUniformLocation(program, 'uFisheyeWideScale'),
    }
    resizeCanvases()
    return true
  }

  function resizeCanvases() {
    pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5)
    const width = Math.max(1, Math.round(stageRect.width * pixelRatio))
    const height = Math.max(1, Math.round(stageRect.height * pixelRatio))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    if (debugCanvas.width !== width || debugCanvas.height !== height) {
      debugCanvas.width = width
      debugCanvas.height = height
    }
    stage.style.setProperty('--peephole-radius', `${stageRect.height * .4}px`)
  }

  function stagePoint(point: Point): Point {
    const videoAspect = video.videoWidth / Math.max(video.videoHeight, 1)
    const stageAspect = stageRect.width / Math.max(stageRect.height, 1)
    if (stageAspect > videoAspect) {
      const renderedHeight = stageRect.width / videoAspect
      return { x: (1 - point.x) * stageRect.width, y: point.y * renderedHeight - (renderedHeight - stageRect.height) / 2 }
    }
    const renderedWidth = stageRect.height * videoAspect
    return { x: (1 - point.x) * renderedWidth - (renderedWidth - stageRect.width) / 2, y: point.y * stageRect.height }
  }

  function updatePunctuation() {
    host.classList.toggle('punctuation-visible', peepholeVisible)
    punctuation.forEach((mark, index) => {
      const shape = punctuationLayout[index]
      mark.style.left = `${shape.x}%`
      mark.style.fontSize = `${shape.size}px`
      mark.style.setProperty('--punctuation-rotation', `${shape.rotation}deg`)
      mark.style.setProperty('--punctuation-duration', `${shape.duration}s`)
      mark.style.setProperty('--punctuation-delay', `${shape.delay}s`)
      const glyph = mark.querySelector<HTMLElement>('i')!
      glyph.textContent = '?'
    })
  }

  function makeObservation(landmarks: Landmark[], now: number): HandObservation {
    const palm = average([0, 5, 9, 13, 17].map((index) => landmarks[index]))
    const fingerChains = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]
    const fingerMeasures = fingerChains.map(([mcp, pip, dip, tip]) => {
      const tipDistance = distance(landmarks[tip], palm)
      const pipDistance = distance(landmarks[pip], palm)
      const dipDistance = distance(landmarks[dip], palm)
      const pipBent = jointAngle(landmarks[mcp], landmarks[pip], landmarks[dip]) < 2.72
      const dipBent = jointAngle(landmarks[pip], landmarks[dip], landmarks[tip]) < 2.88
      const pipBent3d = jointAngle3d(landmarks[mcp], landmarks[pip], landmarks[dip]) < 2.74
      const dipBent3d = jointAngle3d(landmarks[pip], landmarks[dip], landmarks[tip]) < 2.9
      return { mcp, pip, dip, tip, tipDistance, pipDistance, dipDistance, pipBent, dipBent, pipBent3d, dipBent3d }
    })
    const foldedFingers = fingerMeasures.filter((finger) =>
      finger.tipDistance < finger.pipDistance * .92 && finger.tipDistance < finger.dipDistance * 1.02 && finger.pipBent && finger.dipBent,
    ).length
    const thumbFolded = distance(landmarks[4], palm) < distance(landmarks[3], palm) * 1.05
    const palmSize = Math.max(.0001, (distance(landmarks[0], landmarks[9]) + distance(landmarks[5], landmarks[17])) / 2)
    const maxLandmarkRadius = Math.max(...landmarks.map((landmark) => distance(landmark, palm)))
    const compactness = maxLandmarkRadius / palmSize
    const compactHand = compactness < 2.9
    // The thumb makes a closed hand more trustworthy, but a tucked thumb is
    // never mandatory: many natural fists keep it partly visible to the lens.
    const strictFist = foldedFingers >= 3 && compactness < 2.55 && (thumbFolded || foldedFingers === 4)
    // A sideways fist can make one or two joint angles ambiguous even though
    // fingertips are visibly gathered around the palm. This looser branch is
    // still protected from open hands by the compactness and curled-tip tests.
    const sideCurledFingers = fingerMeasures.filter((finger) =>
      finger.tipDistance < finger.pipDistance * 1.08
      && finger.tipDistance < finger.dipDistance * 1.15
      && (finger.pipBent || finger.dipBent || finger.pipBent3d || finger.dipBent3d),
    ).length
    const gatheredFingertips = fingerMeasures.filter((finger) =>
      finger.tipDistance < finger.pipDistance * 1.16 && finger.tipDistance < finger.dipDistance * 1.2,
    ).length
    const sideFacingFist = !strictFist && compactHand && sideCurledFingers >= 3
    // Allows natural, partially occluded fists without accepting a flat palm:
    // three fingertips must remain gathered, and at least two must show a
    // curled joint signature.
    const relaxedFist = !strictFist && !sideFacingFist && compactness < 3.05 && gatheredFingertips >= 3 && sideCurledFingers >= 2
    // A fist pointed at the camera is heavily foreshortened. Its PIP/DIP bends
    // can be ambiguous in a 2D image, so depth is used as a supporting cue.
    // An open palm still fails the 3D curled-finger condition below.
    const forwardPointingFingers = fingerMeasures.filter((finger) =>
      finger.tipDistance < finger.pipDistance * 1.07
      && finger.tipDistance < finger.dipDistance * 1.12
      && landmarks[finger.mcp].z - landmarks[finger.tip].z > .002,
    ).length
    const forwardFoldedFingers = fingerMeasures.filter((finger) =>
      finger.tipDistance < finger.pipDistance * 1.07
      && finger.tipDistance < finger.dipDistance * 1.12
      && finger.pipBent3d && finger.dipBent3d,
    ).length
    const forwardFacingFist = !strictFist && !sideFacingFist && !relaxedFist && compactness < 3.05 && forwardFoldedFingers >= 2 && forwardPointingFingers >= 2
    const fist = strictFist || sideFacingFist || relaxedFist || forwardFacingFist
    const xs = landmarks.map((landmark) => landmark.x)
    const ys = landmarks.map((landmark) => landmark.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const rawScale = Math.max(maxX - minX, maxY - minY)
    const rawDepth = landmarks.reduce((total, landmark) => total + landmark.z, 0) / landmarks.length
    smoothedScale = smoothedScale === null ? rawScale : lerp(smoothedScale, rawScale, .3)
    smoothedDepth = smoothedDepth === null ? rawDepth : lerp(smoothedDepth, rawDepth, .28)
    const deltaTime = previousScaleAt ? Math.max(1, now - previousScaleAt) : 0
    const scaleVelocity = previousScale === null || !deltaTime ? 0 : (smoothedScale - previousScale) / deltaTime
    previousScale = smoothedScale
    previousScaleAt = now
    const screenPoints = landmarks.map(stagePoint)
    const screenXs = screenPoints.map((point) => point.x)
    const screenYs = screenPoints.map((point) => point.y)
    return {
      fist, fistMode: strictFist ? 'strict' : sideFacingFist ? 'side-facing' : relaxedFist ? 'relaxed' : forwardFacingFist ? 'forward-facing' : 'none', foldedFingers, thumbFolded, scale: smoothedScale, depth: smoothedDepth,
      palm, screenPalm: stagePoint(palm), scaleVelocity,
      screenBounds: { x: Math.min(...screenXs), y: Math.min(...screenYs), width: Math.max(...screenXs) - Math.min(...screenXs), height: Math.max(...screenYs) - Math.min(...screenYs) },
    }
  }

  function resetToIdle() {
    gestureState = 'IDLE'
    fistStartedAt = null
    lastFistSeenAt = -Infinity
    readyAt = 0
    forwardAt = 0
  }

  function armFistReady(hand: HandObservation, now: number) {
    gestureState = 'FIST_READY'
    readyAt = now
    readyScale = hand.scale
    readyDepth = hand.depth
  }

  function triggerKnock(now: number) {
    gestureState = 'KNOCK_TRIGGERED'
    knockCount = Math.min(KNOCKS_REQUIRED, knockCount + 1)
    if (knockCount === KNOCKS_REQUIRED) {
      peepholeStartedAt = now
      peepholeVisible = true
      host.classList.add('peephole-visible')
      setStatus('THIRD KNOCK DETECTED · LOOKING THROUGH THE DOOR')
    } else {
      setStatus(`KNOCK ${knockCount}/${KNOCKS_REQUIRED} · KNOCK AGAIN`)
    }
  }

  function forwardConditionsMatch(hand: HandObservation, now: number) {
    const elapsed = now - readyAt
    const scaleRatio = hand.scale / Math.max(readyScale, .0001)
    const depthDelta = readyDepth - hand.depth
    return elapsed >= THRUST_MIN_DELAY_MS && elapsed <= THRUST_MAX_DELAY_MS
      && scaleRatio >= MIN_SCALE_RATIO
      && hand.scaleVelocity >= MIN_SCALE_VELOCITY
      && depthDelta >= MIN_DEPTH_DELTA
  }

  function updateGesture(now: number) {
    const hand = observation
    if (hand?.fist) lastFistSeenAt = now
    if (gestureState === 'KNOCK_TRIGGERED') {
      gestureState = 'COOLDOWN'
      cooldownUntil = now + COOLDOWN_MS
      return
    }
    if (gestureState === 'COOLDOWN') {
      if (now >= cooldownUntil) {
        // After the first confirmed fist, re-arm from its current baseline.
        // This accepts an intentional 2nd/3rd tap in a natural quick rhythm,
        // while a held-forward hand cannot retrigger without another scale jump.
        if (hand?.fist) {
          armFistReady(hand, now)
          setStatus(`KNOCK ${knockCount}/${KNOCKS_REQUIRED} · READY FOR NEXT`)
        } else {
          resetToIdle()
        }
      }
      return
    }
    if (!hand || !hand.fist) {
      if (gestureState === 'IDLE') fistStartedAt = null
      else if (now - lastFistSeenAt > FIST_LOSS_GRACE_MS) resetToIdle()
      return
    }
    if (gestureState === 'IDLE') {
      fistStartedAt ??= now
      if (now - fistStartedAt >= FIST_STABLE_MS) {
        armFistReady(hand, now)
        setStatus('FIST READY · PUSH FORWARD QUICKLY')
      }
      return
    }
    if (gestureState === 'FIST_READY') {
      if (now - readyAt > THRUST_MAX_DELAY_MS) {
        resetToIdle()
        return
      }
      if (forwardConditionsMatch(hand, now)) {
        gestureState = 'FORWARD'
        forwardAt = now
      }
      return
    }
    if (gestureState === 'FORWARD') {
      // The FORWARD entry has already validated scale ratio, velocity, depth,
      // and lateral travel. Requiring the instantaneous velocity again on the
      // following camera frame would incorrectly reject a legitimate short hit.
      if (now - forwardAt <= 85 && (hand.fist || now - lastFistSeenAt <= FIST_LOSS_GRACE_MS)) triggerKnock(now)
      else resetToIdle()
    }
  }

  function updateHandTracking(now: number) {
    if (!handTracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastVideoTime) return
    lastVideoTime = video.currentTime
    const result = handTracker.detectForVideo(video, now)
    const candidates = result.landmarks.map((raw) => makeObservation(raw as Landmark[], now))
    const fistCandidate = candidates.find((candidate) => candidate.fist)
    observation = fistCandidate ?? candidates[0] ?? null
    if (!observation) {
      smoothedScale = null
      smoothedDepth = null
      previousScale = null
      previousScaleAt = 0
    }
    updateGesture(now)
  }

  function drawDebug(now: number) {
    const width = debugCanvas.width
    const height = debugCanvas.height
    debugContext.clearRect(0, 0, width, height)
    if (observation) {
      const bounds = observation.screenBounds
      const fistHeld = observation.fist || (gestureState !== 'IDLE' && now - lastFistSeenAt <= FIST_LOSS_GRACE_MS)
      debugContext.save()
      debugContext.scale(pixelRatio, pixelRatio)
      debugContext.strokeStyle = fistHeld ? '#b9ff87' : 'rgba(255,255,255,.52)'
      debugContext.lineWidth = 1.25
      debugContext.setLineDash([5, 4])
      debugContext.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height)
      debugContext.setLineDash([])
      debugContext.beginPath()
      debugContext.arc(observation.screenPalm.x, observation.screenPalm.y, 5, 0, Math.PI * 2)
      debugContext.fillStyle = observation.fist ? '#b9ff87' : '#fff0c9'
      debugContext.fill()
      debugContext.restore()
    }
  }

  function renderWebgl(now: number) {
    if (!gl || !program || !texture || !positionBuffer || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    const progress = peepholeVisible ? easeOutCubic((now - peepholeStartedAt) / 210) : 0
    const lensScale = .92 + progress * .08
    stage.style.setProperty('--peephole-radius', `${stageRect.height * .4 * lensScale}px`)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    const position = gl.getAttribLocation(program, 'aPosition')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
    gl.uniform1i(uniforms.video, 0)
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height)
    gl.uniform2f(uniforms.videoResolution, video.videoWidth, video.videoHeight)
    gl.uniform2f(uniforms.peepholeCenter, .5, .5)
    gl.uniform1f(uniforms.peephole, progress)
    gl.uniform1f(uniforms.lensScale, lensScale)
    gl.uniform1f(uniforms.fisheyeStrength, FISHEYE_STRENGTH)
    gl.uniform1f(uniforms.fisheyeVerticalStrength, FISHEYE_VERTICAL_STRENGTH)
    gl.uniform1f(uniforms.fisheyeInfluenceRadius, FISHEYE_INFLUENCE_RADIUS)
    gl.uniform1f(uniforms.fisheyeFalloff, FISHEYE_FALLOFF)
    gl.uniform1f(uniforms.fisheyeWideScale, FISHEYE_WIDE_SCALE)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  async function ensureHandTracker() {
    if (handTracker) return handTracker
    if (!handLoading) {
      handLoading = (async () => {
        const { FilesetResolver, HandLandmarker: HandLandmarkerClass } = await import('@mediapipe/tasks-vision')
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
        handTracker = await HandLandmarkerClass.createFromOptions(vision, {
          baseOptions: { modelAssetPath: HAND_MODEL_PATH },
          runningMode: 'VIDEO', numHands: 1,
          minHandDetectionConfidence: .64, minHandPresenceConfidence: .62, minTrackingConfidence: .62,
        })
        return handTracker
      })()
      handLoading.catch(() => { handLoading = null })
    }
    return handLoading
  }

  function clearGesture() {
    resetToIdle()
    cooldownUntil = 0
    observation = null
    smoothedScale = null
    smoothedDepth = null
    previousScale = null
    previousScaleAt = 0
    knockCount = 0
  }

  function hidePeephole() {
    peepholeVisible = false
    peepholeStartedAt = -Infinity
    host.classList.remove('peephole-visible')
    host.classList.remove('punctuation-visible')
    clearGesture()
    if (running) setStatus('MAKE A FIST, THEN KNOCK FORWARD')
  }

  async function activate() {
    if (running) return
    if (!gl || !setupRenderer()) {
      setStatus('이 브라우저에서는 WebGL이 필요합니다.')
      return
    }
    try {
      setStatus('카메라 권한을 요청하고 있어요.')
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      video.srcObject = stream
      await video.play()
      if (!isActive()) { deactivate(); return }
      running = true
      stageRect = stage.getBoundingClientRect()
      resizeCanvases()
      clearGesture()
      hidePeephole()
      setStatus('손을 주먹으로 쥐고 잠시 멈춰 보세요.')
      frameId = requestAnimationFrame(render)
      void ensureHandTracker().then(() => {
        if (running) setStatus('FIST READY → SHORT FORWARD THRUST')
      }).catch(() => { if (running) setStatus('손 추적기를 불러오지 못했어요.') })
    } catch {
      setStatus('카메라 접근 권한이 필요합니다.')
    }
  }

  function deactivate() {
    running = false
    window.cancelAnimationFrame(frameId)
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    video.srcObject = null
    lastVideoTime = -1
    clearGesture()
    hidePeephole()
    host.classList.remove('punctuation-visible')
    debugContext.clearRect(0, 0, debugCanvas.width, debugCanvas.height)
  }

  function render(now: number) {
    if (!running || !isActive()) return
    updateHandTracking(now)
    renderWebgl(now)
    drawDebug(now)
    updatePunctuation()
    frameId = requestAnimationFrame(render)
  }

  resetButton.addEventListener('click', hidePeephole)

  return { activate, deactivate }
}
