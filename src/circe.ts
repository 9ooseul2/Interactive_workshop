import type { FaceLandmarker, HandLandmarker } from '@mediapipe/tasks-vision'
import './circe.css'
import { publicAssetUrl } from './publicAssetUrl.ts'

type Point = { x: number; y: number }
type Landmark = Point & { z: number }
type FoodKind = 'burger' | 'chicken' | 'taco' | 'ramen' | 'rice' | 'pizza' | 'bbq'
type FoodState = 'floating' | 'grabbed' | 'returning' | 'eating' | 'eaten'
type FoodSprite = { x: number; y: number; width: number; height: number; displayScale: number }

type Food = {
  id: string
  kind: FoodKind
  position: Point
  homePosition: Point
  state: FoodState
  phase: number
  size: number
  holdStartedAt: number | null
  eatingStartedAt: number | null
  eatTarget: Point | null
  grabbedBy: string | null
}

type Face = {
  mouth: Point
  leftMouthCorner: Point
  rightMouthCorner: Point
  leftEye: Point
  rightEye: Point
  nose: Point
  forehead: Point
  chin: Point
  leftEdge: Point
  rightEdge: Point
  leftOuterContour: Point[]
  rightOuterContour: Point[]
  leftInnerContour: Point[]
  rightInnerContour: Point[]
  width: number
  angle: number
  puckered: boolean
}

type Pinch = { id: string; position: Point }

type WebcamRenderer = {
  gl: WebGLRenderingContext
  program: WebGLProgram
  texture: WebGLTexture
  positionBuffer: WebGLBuffer
  positionLocation: number
  videoLocation: WebGLUniformLocation
  stageAspectLocation: WebGLUniformLocation
  videoAspectLocation: WebGLUniformLocation
  leftOuterContourLocation: WebGLUniformLocation
  rightOuterContourLocation: WebGLUniformLocation
  leftInnerContourLocation: WebGLUniformLocation
  rightInnerContourLocation: WebGLUniformLocation
  faceWidthLocation: WebGLUniformLocation
  strengthLocation: WebGLUniformLocation
  faceCenterLocation: WebGLUniformLocation
  faceRadiusLocation: WebGLUniformLocation
  leftEyeLocation: WebGLUniformLocation
  rightEyeLocation: WebGLUniformLocation
  wideAngleStrengthLocation: WebGLUniformLocation
  faceCorrectionStrengthLocation: WebGLUniformLocation
  videoTexelLocation: WebGLUniformLocation
  leftMouthCornerLocation: WebGLUniformLocation
  rightMouthCornerLocation: WebGLUniformLocation
  mouthFrownStrengthLocation: WebGLUniformLocation
}

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const HAND_MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const FACE_MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const PUCKER_HOLD_MS = 500
const EAT_ANIMATION_MS = 360
const CHEEK_BOUNCE_MS = 220
const DEBUG_CHEEK_WARP = false
const CHEEK_MAX_COUNT = 3
const EAT_CHEEK_STRENGTHS = [0, .2, .4, .6]
const FOOD_RENDER_SCALE = .7
const WIDE_ANGLE_STRENGTH = .62
const FACE_CORRECTION_STRENGTH = .72
const CONTOUR_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [234, 454], [93, 323], [132, 361], [58, 288], [172, 397], [136, 365], [150, 379],
]
const FOOD_SPRITES: Record<FoodKind, FoodSprite> = {
  burger: { x: 18, y: 24, width: 455, height: 410, displayScale: 1 },
  chicken: { x: 472, y: 42, width: 445, height: 365, displayScale: .96 },
  taco: { x: 905, y: 58, width: 420, height: 380, displayScale: .95 },
  ramen: { x: 1300, y: 18, width: 474, height: 430, displayScale: .96 },
  rice: { x: 66, y: 458, width: 480, height: 414, displayScale: .94 },
  pizza: { x: 542, y: 442, width: 540, height: 440, displayScale: .9 },
  bbq: { x: 1042, y: 502, width: 732, height: 372, displayScale: .72 },
}
const PIG_CELLS = {
  leftEar: { x: 0, y: 108, width: 625, height: 515 },
  rightEar: { x: 630, y: 108, width: 624, height: 515 },
  nose: { x: 292, y: 648, width: 672, height: 478 },
}
function distance(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y) }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)) }
function lerpPoint(from: Point, to: Point, amount: number): Point {
  return { x: from.x + (to.x - from.x) * amount, y: from.y + (to.y - from.y) * amount }
}

function createWebcamRenderer(canvas: HTMLCanvasElement): WebcamRenderer | null {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false })
  if (!gl) return null
  const webgl: WebGLRenderingContext = gl

  const vertexSource = `
    attribute vec2 aPosition;
    varying vec2 vUv;
    void main() {
      vUv = (aPosition + 1.0) * 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `
  const fragmentSource = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uVideo;
    uniform float uStageAspect;
    uniform float uVideoAspect;
    uniform vec2 uLeftOuterContour[7];
    uniform vec2 uRightOuterContour[7];
    uniform vec2 uLeftInnerContour[7];
    uniform vec2 uRightInnerContour[7];
    uniform float uFaceWidth;
    uniform float uStrength;
    uniform vec2 uFaceCenter;
    uniform vec2 uFaceRadius;
    uniform vec2 uLeftEye;
    uniform vec2 uRightEye;
    uniform float uWideAngleStrength;
    uniform float uFaceCorrectionStrength;
    uniform vec2 uVideoTexel;
    uniform vec2 uLeftMouthCorner;
    uniform vec2 uRightMouthCorner;
    uniform float uMouthFrownStrength;

    float verticalWeight(vec2 uv, float topY, float bottomY) {
      float progress = clamp((uv.y - topY) / max(.001, bottomY - topY), 0.0, 1.0);
      float roundedCap = sin(3.14159265 * progress);
      return roundedCap * roundedCap;
    }

    float catmullRom(float previous, float start, float end, float next, float progress) {
      float progressSquared = progress * progress;
      float progressCubed = progressSquared * progress;
      return .5 * ((2.0 * start) + (-previous + end) * progress +
        (2.0 * previous - 5.0 * start + 4.0 * end - next) * progressSquared +
        (-previous + 3.0 * start - 3.0 * end + next) * progressCubed);
    }

    float catmullRomDerivative(float previous, float start, float end, float next, float progress) {
      float progressSquared = progress * progress;
      return .5 * ((-previous + end) +
        2.0 * (2.0 * previous - 5.0 * start + 4.0 * end - next) * progress +
        3.0 * (-previous + 3.0 * start - 3.0 * end + next) * progressSquared);
    }

    void leftSilhouetteBand(vec2 uv, out vec2 mappedUv, out float influence) {
      mappedUv = uv;
      influence = 0.0;
      float outerX = 0.0;
      float outerY = 0.0;
      float innerX = 0.0;
      float tangentX = 0.0;
      float tangentY = 0.0;
      float found = 0.0;
      for (int index = 0; index < 6; index += 1) {
        vec2 outerStart = uLeftOuterContour[index];
        vec2 outerEnd = uLeftOuterContour[index + 1];
        float lowY = min(outerStart.y, outerEnd.y);
        float highY = max(outerStart.y, outerEnd.y);
        if (uv.y >= lowY && uv.y <= highY && found < .5) {
          float deltaY = outerEnd.y - outerStart.y;
          float safeDeltaY = abs(deltaY) < .001 ? .001 : deltaY;
          float progress = clamp((uv.y - outerStart.y) / safeDeltaY, 0.0, 1.0);
          float outerPrevious = uLeftOuterContour[0].x;
          float outerNext = uLeftOuterContour[6].x;
          float outerPreviousY = uLeftOuterContour[0].y;
          float outerNextY = uLeftOuterContour[6].y;
          float innerPrevious = uLeftInnerContour[0].x;
          float innerNext = uLeftInnerContour[6].x;
          if (index > 0) {
            outerPrevious = uLeftOuterContour[index - 1].x;
            outerPreviousY = uLeftOuterContour[index - 1].y;
            innerPrevious = uLeftInnerContour[index - 1].x;
          }
          if (index < 5) {
            outerNext = uLeftOuterContour[index + 2].x;
            outerNextY = uLeftOuterContour[index + 2].y;
            innerNext = uLeftInnerContour[index + 2].x;
          }
          outerX = catmullRom(outerPrevious, outerStart.x, outerEnd.x, outerNext, progress);
          outerY = catmullRom(outerPreviousY, outerStart.y, outerEnd.y, outerNextY, progress);
          tangentX = catmullRomDerivative(outerPrevious, outerStart.x, outerEnd.x, outerNext, progress);
          tangentY = catmullRomDerivative(outerPreviousY, outerStart.y, outerEnd.y, outerNextY, progress);
          innerX = catmullRom(innerPrevious, uLeftInnerContour[index].x, uLeftInnerContour[index + 1].x, innerNext, progress);
          found = 1.0;
        }
      }
      if (found < .5) return;
      float vertical = verticalWeight(uv, min(uLeftOuterContour[0].y, uLeftOuterContour[6].y), max(uLeftOuterContour[0].y, uLeftOuterContour[6].y));
      float outward = uFaceWidth * .15 * uStrength * vertical;
      if (outward < .0001) return;
      vec2 tangent = vec2(tangentX, tangentY);
      vec2 normal = vec2(-tangent.y, tangent.x) / max(.0001, length(tangent));
      if (normal.x > 0.0) normal = -normal;
      vec2 originalOuter = vec2(outerX, outerY);
      vec2 expandedOuter = originalOuter + normal * outward;
      if (uv.x < expandedOuter.x || uv.x > innerX) return;
      float bandProgress = clamp((innerX - uv.x) / max(.001, innerX - expandedOuter.x), 0.0, 1.0);
      float roundedProgress = bandProgress * bandProgress * (3.0 - 2.0 * bandProgress);
      mappedUv = uv - (expandedOuter - originalOuter) * roundedProgress;
      influence = roundedProgress * vertical;
    }

    void rightSilhouetteBand(vec2 uv, out vec2 mappedUv, out float influence) {
      mappedUv = uv;
      influence = 0.0;
      float outerX = 0.0;
      float outerY = 0.0;
      float innerX = 0.0;
      float tangentX = 0.0;
      float tangentY = 0.0;
      float found = 0.0;
      for (int index = 0; index < 6; index += 1) {
        vec2 outerStart = uRightOuterContour[index];
        vec2 outerEnd = uRightOuterContour[index + 1];
        float lowY = min(outerStart.y, outerEnd.y);
        float highY = max(outerStart.y, outerEnd.y);
        if (uv.y >= lowY && uv.y <= highY && found < .5) {
          float deltaY = outerEnd.y - outerStart.y;
          float safeDeltaY = abs(deltaY) < .001 ? .001 : deltaY;
          float progress = clamp((uv.y - outerStart.y) / safeDeltaY, 0.0, 1.0);
          float outerPrevious = uRightOuterContour[0].x;
          float outerNext = uRightOuterContour[6].x;
          float outerPreviousY = uRightOuterContour[0].y;
          float outerNextY = uRightOuterContour[6].y;
          float innerPrevious = uRightInnerContour[0].x;
          float innerNext = uRightInnerContour[6].x;
          if (index > 0) {
            outerPrevious = uRightOuterContour[index - 1].x;
            outerPreviousY = uRightOuterContour[index - 1].y;
            innerPrevious = uRightInnerContour[index - 1].x;
          }
          if (index < 5) {
            outerNext = uRightOuterContour[index + 2].x;
            outerNextY = uRightOuterContour[index + 2].y;
            innerNext = uRightInnerContour[index + 2].x;
          }
          outerX = catmullRom(outerPrevious, outerStart.x, outerEnd.x, outerNext, progress);
          outerY = catmullRom(outerPreviousY, outerStart.y, outerEnd.y, outerNextY, progress);
          tangentX = catmullRomDerivative(outerPrevious, outerStart.x, outerEnd.x, outerNext, progress);
          tangentY = catmullRomDerivative(outerPreviousY, outerStart.y, outerEnd.y, outerNextY, progress);
          innerX = catmullRom(innerPrevious, uRightInnerContour[index].x, uRightInnerContour[index + 1].x, innerNext, progress);
          found = 1.0;
        }
      }
      if (found < .5) return;
      float vertical = verticalWeight(uv, min(uRightOuterContour[0].y, uRightOuterContour[6].y), max(uRightOuterContour[0].y, uRightOuterContour[6].y));
      float outward = uFaceWidth * .15 * uStrength * vertical;
      if (outward < .0001) return;
      vec2 tangent = vec2(tangentX, tangentY);
      vec2 normal = vec2(-tangent.y, tangent.x) / max(.0001, length(tangent));
      if (normal.x < 0.0) normal = -normal;
      vec2 originalOuter = vec2(outerX, outerY);
      vec2 expandedOuter = originalOuter + normal * outward;
      if (uv.x > expandedOuter.x || uv.x < innerX) return;
      float bandProgress = clamp((uv.x - innerX) / max(.001, expandedOuter.x - innerX), 0.0, 1.0);
      float roundedProgress = bandProgress * bandProgress * (3.0 - 2.0 * bandProgress);
      mappedUv = uv - (expandedOuter - originalOuter) * roundedProgress;
      influence = roundedProgress * vertical;
    }

    vec2 screenToVideoUv(vec2 screenUv) {
      vec2 coveredUv = screenUv;
      if (uVideoAspect > uStageAspect) {
        float visibleWidth = uStageAspect / uVideoAspect;
        coveredUv.x = (1.0 - visibleWidth) * 0.5 + screenUv.x * visibleWidth;
      } else {
        float visibleHeight = uVideoAspect / uStageAspect;
        coveredUv.y = (1.0 - visibleHeight) * 0.5 + screenUv.y * visibleHeight;
      }
      return vec2(1.0 - coveredUv.x, coveredUv.y);
    }

    vec2 wideAngleSource(vec2 uv) {
      vec2 offset = uv - .5;
      float radiusSquared = dot(offset, offset);
      float scale = 1.0 - uWideAngleStrength * .22 * radiusSquared;
      return .5 + offset * scale;
    }

    float eyeProtection(vec2 uv, vec2 eye) {
      vec2 radius = vec2(uFaceRadius.x * .3, uFaceRadius.y * .16);
      float distanceFromEye = length((uv - eye) / max(radius, vec2(.001)));
      return smoothstep(.72, 1.14, distanceFromEye);
    }

    vec3 correctFace(vec3 sourceColor, vec2 sourceVideoUv, vec2 screenUv) {
      if (uFaceCorrectionStrength < .001 || uFaceCenter.x < 0.0) return sourceColor;
      float faceDistance = length((screenUv - uFaceCenter) / max(uFaceRadius, vec2(.001)));
      float faceMask = 1.0 - smoothstep(.7, 1.06, faceDistance);
      faceMask *= eyeProtection(screenUv, uLeftEye) * eyeProtection(screenUv, uRightEye);
      if (faceMask < .001) return sourceColor;

      vec3 nearby = sourceColor * 4.0;
      nearby += texture2D(uVideo, sourceVideoUv + vec2(uVideoTexel.x, 0.0)).rgb;
      nearby += texture2D(uVideo, sourceVideoUv - vec2(uVideoTexel.x, 0.0)).rgb;
      nearby += texture2D(uVideo, sourceVideoUv + vec2(0.0, uVideoTexel.y)).rgb;
      nearby += texture2D(uVideo, sourceVideoUv - vec2(0.0, uVideoTexel.y)).rgb;
      nearby /= 8.0;
      float edgeAmount = length(sourceColor - nearby);
      float lowContrastMask = 1.0 - smoothstep(.035, .16, edgeAmount);
      float blendAmount = faceMask * lowContrastMask * uFaceCorrectionStrength * .32;
      return mix(sourceColor, nearby, blendAmount);
    }

    vec2 mouthCornerFrown(vec2 uv, vec2 corner, out float influence) {
      influence = 0.0;
      if (uMouthFrownStrength < .001 || corner.x < 0.0) return uv;
      vec2 radius = vec2(uFaceWidth * .105, uFaceWidth * uStageAspect * .082);
      vec2 relative = (uv - corner) / max(radius, vec2(.001));
      float distanceFromCorner = length(relative);
      if (distanceFromCorner >= 1.0) return uv;
      float falloff = pow(1.0 - distanceFromCorner * distanceFromCorner, 2.0);
      float downwardOffset = uFaceWidth * uStageAspect * .072 * uMouthFrownStrength * falloff;
      influence = falloff;
      return uv - vec2(0.0, downwardOffset);
    }

    void main() {
      vec2 screenUv = vec2(vUv.x, 1.0 - vUv.y);
      vec2 leftMapped;
      vec2 rightMapped;
      float leftInfluence;
      float rightInfluence;
      leftSilhouetteBand(screenUv, leftMapped, leftInfluence);
      rightSilhouetteBand(screenUv, rightMapped, rightInfluence);
      vec2 sourceScreenUv = leftInfluence > rightInfluence ? leftMapped : rightMapped;
      float leftFrownInfluence;
      float rightFrownInfluence;
      vec2 leftFrownMapped = mouthCornerFrown(sourceScreenUv, uLeftMouthCorner, leftFrownInfluence);
      vec2 rightFrownMapped = mouthCornerFrown(sourceScreenUv, uRightMouthCorner, rightFrownInfluence);
      if (leftFrownInfluence > 0.0 || rightFrownInfluence > 0.0) {
        sourceScreenUv = leftFrownInfluence > rightFrownInfluence ? leftFrownMapped : rightFrownMapped;
      }
      sourceScreenUv = wideAngleSource(sourceScreenUv);
      vec2 sourceVideoUv = screenToVideoUv(clamp(sourceScreenUv, vec2(0.0), vec2(1.0)));
      vec2 sampledVideoUv = vec2(sourceVideoUv.x, 1.0 - sourceVideoUv.y);
      vec3 sourceColor = texture2D(uVideo, sampledVideoUv).rgb;
      gl_FragColor = vec4(correctFace(sourceColor, sampledVideoUv, screenUv), 1.0);
    }
  `

  function compile(type: number, source: string) {
    const shader = webgl.createShader(type)
    if (!shader) return null
    webgl.shaderSource(shader, source)
    webgl.compileShader(shader)
    return webgl.getShaderParameter(shader, webgl.COMPILE_STATUS) ? shader : null
  }

  const vertexShader = compile(gl.VERTEX_SHADER, vertexSource)
  const fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSource)
  if (!vertexShader || !fragmentShader) return null
  const program = gl.createProgram()
  if (!program) return null
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null

  const texture = gl.createTexture()
  const positionBuffer = gl.createBuffer()
  if (!texture || !positionBuffer) return null
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1,
  ]), gl.STATIC_DRAW)

  return {
    gl,
    program,
    texture,
    positionBuffer,
    positionLocation: gl.getAttribLocation(program, 'aPosition'),
    videoLocation: gl.getUniformLocation(program, 'uVideo')!,
    stageAspectLocation: gl.getUniformLocation(program, 'uStageAspect')!,
    videoAspectLocation: gl.getUniformLocation(program, 'uVideoAspect')!,
    leftOuterContourLocation: gl.getUniformLocation(program, 'uLeftOuterContour[0]')!,
    rightOuterContourLocation: gl.getUniformLocation(program, 'uRightOuterContour[0]')!,
    leftInnerContourLocation: gl.getUniformLocation(program, 'uLeftInnerContour[0]')!,
    rightInnerContourLocation: gl.getUniformLocation(program, 'uRightInnerContour[0]')!,
    faceWidthLocation: gl.getUniformLocation(program, 'uFaceWidth')!,
    strengthLocation: gl.getUniformLocation(program, 'uStrength')!,
    faceCenterLocation: gl.getUniformLocation(program, 'uFaceCenter')!,
    faceRadiusLocation: gl.getUniformLocation(program, 'uFaceRadius')!,
    leftEyeLocation: gl.getUniformLocation(program, 'uLeftEye')!,
    rightEyeLocation: gl.getUniformLocation(program, 'uRightEye')!,
    wideAngleStrengthLocation: gl.getUniformLocation(program, 'uWideAngleStrength')!,
    faceCorrectionStrengthLocation: gl.getUniformLocation(program, 'uFaceCorrectionStrength')!,
    videoTexelLocation: gl.getUniformLocation(program, 'uVideoTexel')!,
    leftMouthCornerLocation: gl.getUniformLocation(program, 'uLeftMouthCorner')!,
    rightMouthCornerLocation: gl.getUniformLocation(program, 'uRightMouthCorner')!,
    mouthFrownStrengthLocation: gl.getUniformLocation(program, 'uMouthFrownStrength')!,
  }
}

export function setupCirce(host: HTMLElement, isActive: () => boolean) {
  host.innerHTML = `
    <div class="circe-stage">
      <div class="circe-background" aria-hidden="true"></div>
      <div class="circe-camera-frame">
        <video class="circe-camera" autoplay muted playsinline></video>
        <canvas class="circe-webgl" aria-hidden="true"></canvas>
        <canvas class="circe-canvas" aria-label="웹캠 위 음식과 AR 효과"></canvas>
        <div class="circe-vignette"></div>
      </div>
      <div class="circe-gauge" aria-label="먹은 음식 수"><i></i><i></i><i></i></div>
      <div class="circe-hold" aria-hidden="true"><i></i><span></span></div>
      <p class="circe-status" role="status" aria-live="polite" hidden></p>
      <button class="circe-reset" type="button" aria-label="키르케2 다시 시작" title="다시 시작">↻</button>
      <div class="circe-gate"><button type="button" aria-label="카메라 시작" title="카메라 시작"><span aria-hidden="true">▶</span></button></div>
    </div>`

  const cameraFrame = host.querySelector<HTMLElement>('.circe-camera-frame')!
  const video = host.querySelector<HTMLVideoElement>('.circe-camera')!
  const webglCanvas = host.querySelector<HTMLCanvasElement>('.circe-webgl')!
  const canvas = host.querySelector<HTMLCanvasElement>('.circe-canvas')!
  const context = canvas.getContext('2d')!
  const webcamRenderer = createWebcamRenderer(webglCanvas)
  if (!webcamRenderer) webglCanvas.hidden = true
  const gate = host.querySelector<HTMLElement>('.circe-gate')!
  const startButton = gate.querySelector<HTMLButtonElement>('button')!
  const resetButton = host.querySelector<HTMLButtonElement>('.circe-reset')!
  const status = host.querySelector<HTMLElement>('.circe-status')!
  const gaugeDots = Array.from(host.querySelectorAll<HTMLElement>('.circe-gauge i'))
  const hold = host.querySelector<HTMLElement>('.circe-hold')!
  const holdFill = hold.querySelector<HTMLElement>('i')!
  const holdLabel = hold.querySelector<HTMLElement>('span')!
  const foodSheet = new Image()
  const pigSheet = new Image()
  foodSheet.src = publicAssetUrl('circe/feast-sheet.png')
  pigSheet.src = publicAssetUrl('circe/pig-overlay.png')

  let handTracker: HandLandmarker | null = null
  let handLoading: Promise<HandLandmarker> | null = null
  let faceTracker: FaceLandmarker | null = null
  let faceLoading: Promise<FaceLandmarker> | null = null
  let stream: MediaStream | null = null
  let running = false
  let frame = 0
  let lastHandTime = -1
  let lastFaceTime = -1
  let lastFaceAt = 0
  let stageRect = cameraFrame.getBoundingClientRect()
  let pixelRatio = 1
  let face: Face | null = null
  let eatCount = 0
  let cheekBounceAt = -Infinity
  let lastFrameAt = performance.now()
  let grabbedFoodId: string | null = null
  let previousPinchIds = new Set<string>()
  const smoothedPoints = new Map<string, Point>()
  const foods: Food[] = []
  const resizeObserver = new ResizeObserver(() => {
    stageRect = cameraFrame.getBoundingClientRect()
    resizeCanvas()
  })
  resizeObserver.observe(cameraFrame)

  function setStatus(text: string, state: 'ready' | 'active' | 'error' = 'ready') {
    status.textContent = text
    host.dataset.circeState = state
  }

  function updateGauge() {
    gaugeDots.forEach((dot, index) => dot.classList.toggle('filled', index < eatCount))
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
    const offsetX = x - .5
    const offsetY = y - .5
    const inverseLensScale = 1 + WIDE_ANGLE_STRENGTH * .22 * (offsetX * offsetX + offsetY * offsetY)
    x = .5 + offsetX * inverseLensScale
    y = .5 + offsetY * inverseLensScale
    return { x: x * stageRect.width, y: y * stageRect.height }
  }

  function smoothPoint(key: string, next: Point, amount = .32) {
    const previous = smoothedPoints.get(key)
    const value = previous ? lerpPoint(previous, next, amount) : next
    smoothedPoints.set(key, value)
    return value
  }

  function sortedPair(first: Point, second: Point): [Point, Point] {
    return first.x <= second.x ? [first, second] : [second, first]
  }

  function floatingPosition(food: Food, now: number): Point {
    return {
      x: food.homePosition.x * stageRect.width + Math.sin(now / 1800 + food.phase) * 17,
      y: food.homePosition.y * stageRect.height + Math.cos(now / 2100 + food.phase * 1.3) * 13,
    }
  }

  function makeFoods() {
    const homes: Point[] = [
      { x: .11, y: .24 }, { x: .24, y: .69 }, { x: .39, y: .2 }, { x: .53, y: .77 },
      { x: .69, y: .22 }, { x: .86, y: .35 }, { x: .78, y: .74 }, { x: .14, y: .48 },
      { x: .38, y: .49 }, { x: .58, y: .42 }, { x: .88, y: .61 }, { x: .31, y: .86 },
    ]
    const kinds: FoodKind[] = ['burger', 'chicken', 'taco', 'ramen', 'rice', 'pizza', 'bbq', 'burger', 'pizza', 'ramen', 'chicken', 'taco']
    foods.splice(0, foods.length, ...homes.map((homePosition, index) => ({
      id: `food-${index + 1}`,
      kind: kinds[index],
      position: { x: homePosition.x * stageRect.width, y: homePosition.y * stageRect.height },
      homePosition,
      state: 'floating' as FoodState,
      phase: index * 1.91,
      size: 70 + (index % 3) * 5,
      holdStartedAt: null,
      eatingStartedAt: null,
      eatTarget: null,
      grabbedBy: null,
    })))
    grabbedFoodId = null
    previousPinchIds.clear()
  }

  function resizeCanvas() {
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(stageRect.width * pixelRatio))
    const height = Math.max(1, Math.round(stageRect.height * pixelRatio))
    canvas.width = width
    canvas.height = height
    webglCanvas.width = width
    webglCanvas.height = height
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    webcamRenderer?.gl.viewport(0, 0, width, height)
  }

  function updateFaceTracking(now: number) {
    if (!faceTracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastFaceTime || now - lastFaceAt < 50) return
    lastFaceTime = video.currentTime
    lastFaceAt = now
    const result = faceTracker.detectForVideo(video, now)
    const landmarks = result.faceLandmarks[0] as Landmark[] | undefined
    if (!landmarks) {
      face = null
      smoothedPoints.clear()
      return
    }

    const upperLip = screenPoint(landmarks[13])
    const lowerLip = screenPoint(landmarks[14])
    const [leftEdge, rightEdge] = sortedPair(screenPoint(landmarks[234]), screenPoint(landmarks[454]))
    const [mouthLeft, mouthRight] = sortedPair(screenPoint(landmarks[61]), screenPoint(landmarks[291]))
    const [leftEye, rightEye] = sortedPair(
      lerpPoint(screenPoint(landmarks[33]), screenPoint(landmarks[133]), .5),
      lerpPoint(screenPoint(landmarks[362]), screenPoint(landmarks[263]), .5),
    )
    const rawMouth = lerpPoint(upperLip, lowerLip, .5)
    const rawFaceCenter = lerpPoint(leftEdge, rightEdge, .5)
    const leftOuterContour: Point[] = []
    const rightOuterContour: Point[] = []
    const leftInnerContour: Point[] = []
    const rightInnerContour: Point[] = []
    CONTOUR_PAIRS.forEach(([firstIndex, secondIndex]) => {
      const [leftOuter, rightOuter] = sortedPair(screenPoint(landmarks[firstIndex]), screenPoint(landmarks[secondIndex]))
      leftOuterContour.push(leftOuter)
      rightOuterContour.push(rightOuter)
      leftInnerContour.push(lerpPoint(leftOuter, rawFaceCenter, .34))
      rightInnerContour.push(lerpPoint(rightOuter, rawFaceCenter, .34))
    })
    const faceWidth = Math.max(1, distance(leftEdge, rightEdge))
    const mouthWidth = distance(mouthLeft, mouthRight) / faceWidth
    const opening = distance(upperLip, lowerLip) / faceWidth
    const blendshapes = result.faceBlendshapes[0]?.categories ?? []
    const blendshapePucker = Math.max(...blendshapes
      .filter((shape) => shape.categoryName === 'mouthPucker' || shape.categoryName === 'mouthFunnel')
      .map((shape) => shape.score), 0)
    const geometryPucker = clamp((.42 - mouthWidth) / .18, 0, 1) * clamp((.105 - opening) / .075, 0, 1)
    const puckerScore = Math.max(blendshapePucker, geometryPucker)
    const stableLeft = smoothPoint('left-edge', leftEdge)
    const stableRight = smoothPoint('right-edge', rightEdge)
    const stableMouth = smoothPoint('mouth', rawMouth)
    const stableLeftMouthCorner = smoothPoint('left-mouth-corner', mouthLeft)
    const stableRightMouthCorner = smoothPoint('right-mouth-corner', mouthRight)
    const stableLeftEye = smoothPoint('left-eye', leftEye)
    const stableRightEye = smoothPoint('right-eye', rightEye)
    const stableNose = smoothPoint('nose', screenPoint(landmarks[1]))
    const stableForehead = smoothPoint('forehead', screenPoint(landmarks[10]))
    const stableChin = smoothPoint('chin', screenPoint(landmarks[152]))
    const stableLeftOuterContour = leftOuterContour.map((point, index) => smoothPoint(`left-outer-${index}`, point))
    const stableRightOuterContour = rightOuterContour.map((point, index) => smoothPoint(`right-outer-${index}`, point))
    const stableLeftInnerContour = leftInnerContour.map((point, index) => smoothPoint(`left-inner-${index}`, point))
    const stableRightInnerContour = rightInnerContour.map((point, index) => smoothPoint(`right-inner-${index}`, point))
    const stableWidth = distance(stableLeft, stableRight)
    face = {
      mouth: stableMouth,
      leftMouthCorner: stableLeftMouthCorner,
      rightMouthCorner: stableRightMouthCorner,
      leftEye: stableLeftEye,
      rightEye: stableRightEye,
      nose: stableNose,
      forehead: stableForehead,
      chin: stableChin,
      leftEdge: stableLeft,
      rightEdge: stableRight,
      leftOuterContour: stableLeftOuterContour,
      rightOuterContour: stableRightOuterContour,
      leftInnerContour: stableLeftInnerContour,
      rightInnerContour: stableRightInnerContour,
      width: stableWidth,
      angle: Math.atan2(stableRight.y - stableLeft.y, stableRight.x - stableLeft.x),
      puckered: puckerScore > .28,
    }
  }

  function updateHandTracking(now: number) {
    if (!handTracker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastHandTime) return
    lastHandTime = video.currentTime
    const result = handTracker.detectForVideo(video, now)
    const pinches: Pinch[] = []
    result.landmarks.slice(0, 2).forEach((raw, index) => {
      const landmarks = raw as Landmark[]
      const thumb = screenPoint(landmarks[4])
      const indexTip = screenPoint(landmarks[8])
      if (distance(thumb, indexTip) < Math.min(stageRect.width, stageRect.height) * .07) {
        const handedness = result.handedness[index]?.[0]?.categoryName ?? `hand-${index}`
        pinches.push({ id: handedness, position: lerpPoint(thumb, indexTip, .5) })
      }
    })

    const grabbedFood = foods.find((food) => food.id === grabbedFoodId)
    if (grabbedFood) {
      const matchingPinch = pinches.find((pinch) => pinch.id === grabbedFood.grabbedBy)
      if (matchingPinch) grabbedFood.position = matchingPinch.position
      else releaseFood(grabbedFood)
    }

    if (!grabbedFoodId) {
      const pinchStarted = pinches.filter((pinch) => !previousPinchIds.has(pinch.id))
      for (const pinch of pinchStarted) {
        const candidate = foods
          .filter((food) => food.state === 'floating' || food.state === 'returning')
          .sort((first, second) => distance(first.position, pinch.position) - distance(second.position, pinch.position))[0]
        if (candidate && distance(candidate.position, pinch.position) < Math.max(58, candidate.size * .72)) {
          grabFood(candidate, pinch)
          break
        }
      }
    }
    previousPinchIds = new Set(pinches.map((pinch) => pinch.id))
  }

  function grabFood(food: Food, pinch: Pinch) {
    food.state = 'grabbed'
    food.grabbedBy = pinch.id
    food.position = pinch.position
    food.holdStartedAt = null
    grabbedFoodId = food.id
    setStatus('음식을 집었어요. 입으로 가져가세요', 'active')
  }

  function releaseFood(food: Food) {
    food.state = 'returning'
    food.grabbedBy = null
    food.holdStartedAt = null
    grabbedFoodId = null
    hold.classList.remove('visible')
    setStatus('음식이 식탁으로 돌아가요', 'active')
  }

  function startEating(food: Food, now: number) {
    if (!face) return
    food.state = 'eating'
    food.eatingStartedAt = now
    food.eatTarget = { ...face.mouth }
    food.holdStartedAt = null
    food.grabbedBy = null
    grabbedFoodId = null
    hold.classList.remove('visible')
    setStatus('냠! 음식이 입으로 빨려 들어가요', 'active')
  }

  function finishEating(food: Food) {
    food.state = 'eaten'
    food.position = food.eatTarget ?? food.position
    food.eatTarget = null
    eatCount = Math.min(eatCount + 1, CHEEK_MAX_COUNT)
    cheekBounceAt = performance.now()
    updateGauge()
    if (eatCount >= CHEEK_MAX_COUNT) setStatus('변신 완료! 돼지코와 귀가 나타났어요', 'active')
    else setStatus(`${eatCount}번째 한 입! 볼이 더 통통해졌어요`, 'active')
  }

  function updateFoodStates(now: number, delta: number) {
    for (const food of foods) {
      if (food.state === 'floating') {
        food.position = floatingPosition(food, now)
        continue
      }
      if (food.state === 'returning') {
        const home = floatingPosition(food, now)
        food.position = lerpPoint(food.position, home, Math.min(1, delta * .006))
        if (distance(food.position, home) < 2) food.state = 'floating'
        continue
      }
      if (food.state === 'grabbed') {
        const closeToMouth = Boolean(face && distance(food.position, face.mouth) < Math.max(108, face.width * .56))
        if (closeToMouth && face?.puckered) {
          food.holdStartedAt ??= now
          const progress = clamp((now - food.holdStartedAt) / PUCKER_HOLD_MS, 0, 1)
          hold.classList.add('visible')
          holdFill.style.transform = `scaleX(${progress})`
          holdLabel.textContent = progress > .72 ? '거의 다 됐어요!' : '입술을 오므린 채 유지하세요'
          if (progress >= 1) startEating(food, now)
        } else {
          food.holdStartedAt = null
          if (closeToMouth) {
            hold.classList.add('visible')
            holdFill.style.transform = 'scaleX(0)'
            holdLabel.textContent = face ? '입술을 오므려 보세요' : '얼굴을 찾는 중이에요'
          }
        }
        continue
      }
      if (food.state === 'eating' && food.eatingStartedAt !== null && food.eatTarget) {
        const progress = clamp((now - food.eatingStartedAt) / EAT_ANIMATION_MS, 0, 1)
        food.position = lerpPoint(food.position, food.eatTarget, Math.min(1, delta * .022))
        if (progress >= 1) finishEating(food)
      }
    }
    if (!foods.some((food) => food.state === 'grabbed')) hold.classList.remove('visible')
  }

  function drawVideoCover(target: CanvasRenderingContext2D) {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return
    const sourceAspect = video.videoWidth / video.videoHeight
    const destinationAspect = stageRect.width / Math.max(stageRect.height, 1)
    let sourceX = 0
    let sourceY = 0
    let sourceWidth = video.videoWidth
    let sourceHeight = video.videoHeight
    if (sourceAspect > destinationAspect) {
      sourceWidth = video.videoHeight * destinationAspect
      sourceX = (video.videoWidth - sourceWidth) / 2
    } else {
      sourceHeight = video.videoWidth / destinationAspect
      sourceY = (video.videoHeight - sourceHeight) / 2
    }
    target.save()
    target.translate(stageRect.width, 0)
    target.scale(-1, 1)
    target.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, stageRect.width, stageRect.height)
    target.restore()
  }

  function cheekStrength(now: number) {
    if (DEBUG_CHEEK_WARP) return .85
    const base = EAT_CHEEK_STRENGTHS[Math.min(eatCount, CHEEK_MAX_COUNT)]
    const elapsed = now - cheekBounceAt
    if (elapsed < 0 || elapsed > CHEEK_BOUNCE_MS) return base
    return base + Math.sin((elapsed / CHEEK_BOUNCE_MS) * Math.PI) * .13
  }

  function mouthFrownStrength() {
    return eatCount >= CHEEK_MAX_COUNT ? .92 : 0
  }

  function renderWebcam(now: number) {
    if (!webcamRenderer || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return false
    const { gl } = webcamRenderer
    const stageWidth = Math.max(stageRect.width, 1)
    const stageHeight = Math.max(stageRect.height, 1)
    const shouldBulge = Boolean(face && (DEBUG_CHEEK_WARP || eatCount > 0))
    const faceState = face
    const invisibleContour = Array.from({ length: 14 }, () => -2)
    const contourUv = (contour: Point[]) => contour.flatMap((point) => [point.x / stageWidth, point.y / stageHeight])
    const leftOuterContour = shouldBulge && faceState ? contourUv(faceState.leftOuterContour) : invisibleContour
    const rightOuterContour = shouldBulge && faceState ? contourUv(faceState.rightOuterContour) : invisibleContour
    const leftInnerContour = shouldBulge && faceState ? contourUv(faceState.leftInnerContour) : invisibleContour
    const rightInnerContour = shouldBulge && faceState ? contourUv(faceState.rightInnerContour) : invisibleContour
    const faceCenter = faceState
      ? [
        (faceState.forehead.x + faceState.chin.x) / (2 * stageWidth),
        (faceState.forehead.y + faceState.chin.y) / (2 * stageHeight),
      ]
      : [-2, -2]
    const faceHeight = faceState ? distance(faceState.forehead, faceState.chin) : 0
    const faceRadius = faceState
      ? [faceState.width * .54 / stageWidth, faceHeight * .52 / stageHeight]
      : [0, 0]
    const leftEye = faceState
      ? [faceState.leftEye.x / stageWidth, faceState.leftEye.y / stageHeight]
      : [-2, -2]
    const rightEye = faceState
      ? [faceState.rightEye.x / stageWidth, faceState.rightEye.y / stageHeight]
      : [-2, -2]
    const leftMouthCorner = faceState
      ? [faceState.leftMouthCorner.x / stageWidth, faceState.leftMouthCorner.y / stageHeight]
      : [-2, -2]
    const rightMouthCorner = faceState
      ? [faceState.rightMouthCorner.x / stageWidth, faceState.rightMouthCorner.y / stageHeight]
      : [-2, -2]

    gl.useProgram(webcamRenderer.program)
    gl.disable(gl.BLEND)
    gl.bindBuffer(gl.ARRAY_BUFFER, webcamRenderer.positionBuffer)
    gl.enableVertexAttribArray(webcamRenderer.positionLocation)
    gl.vertexAttribPointer(webcamRenderer.positionLocation, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, webcamRenderer.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
    gl.uniform1i(webcamRenderer.videoLocation, 0)
    gl.uniform1f(webcamRenderer.stageAspectLocation, stageWidth / stageHeight)
    gl.uniform1f(webcamRenderer.videoAspectLocation, video.videoWidth / video.videoHeight)
    gl.uniform2fv(webcamRenderer.leftOuterContourLocation, leftOuterContour)
    gl.uniform2fv(webcamRenderer.rightOuterContourLocation, rightOuterContour)
    gl.uniform2fv(webcamRenderer.leftInnerContourLocation, leftInnerContour)
    gl.uniform2fv(webcamRenderer.rightInnerContourLocation, rightInnerContour)
    gl.uniform1f(webcamRenderer.faceWidthLocation, faceState ? faceState.width / stageWidth : 0)
    gl.uniform1f(webcamRenderer.strengthLocation, shouldBulge ? cheekStrength(now) : 0)
    gl.uniform2fv(webcamRenderer.faceCenterLocation, faceCenter)
    gl.uniform2fv(webcamRenderer.faceRadiusLocation, faceRadius)
    gl.uniform2fv(webcamRenderer.leftEyeLocation, leftEye)
    gl.uniform2fv(webcamRenderer.rightEyeLocation, rightEye)
    gl.uniform1f(webcamRenderer.wideAngleStrengthLocation, WIDE_ANGLE_STRENGTH)
    gl.uniform1f(webcamRenderer.faceCorrectionStrengthLocation, faceState ? FACE_CORRECTION_STRENGTH : 0)
    gl.uniform2f(webcamRenderer.videoTexelLocation, 1 / video.videoWidth, 1 / video.videoHeight)
    gl.uniform2fv(webcamRenderer.leftMouthCornerLocation, leftMouthCorner)
    gl.uniform2fv(webcamRenderer.rightMouthCornerLocation, rightMouthCorner)
    gl.uniform1f(webcamRenderer.mouthFrownStrengthLocation, mouthFrownStrength())
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    return true
  }

  function drawFood(food: Food, now: number) {
    if (!foodSheet.complete || food.state === 'eaten') return
    const eatingProgress = food.state === 'eating' && food.eatingStartedAt !== null
      ? clamp((now - food.eatingStartedAt) / EAT_ANIMATION_MS, 0, 1)
      : 0
    const scale = food.state === 'eating' ? Math.max(.06, 1 - eatingProgress) : 1
    const sprite = FOOD_SPRITES[food.kind]
    const height = food.size * sprite.displayScale * FOOD_RENDER_SCALE * scale
    const width = height * (sprite.width / sprite.height)
    context.save()
    context.translate(Math.round(food.position.x), Math.round(food.position.y))
    context.rotate(Math.sin(now / 1450 + food.phase) * .055)
    context.shadowColor = 'rgba(20, 7, 16, .34)'
    context.shadowBlur = 11
    context.shadowOffsetY = 4
    context.drawImage(foodSheet, sprite.x, sprite.y, sprite.width, sprite.height, -width / 2, -height / 2, width, height)
    context.restore()
  }

  function drawPigPart(cell: { x: number; y: number; width: number; height: number }, center: Point, width: number, height: number, rotation: number) {
    context.save()
    context.translate(center.x, center.y)
    context.rotate(rotation)
    context.drawImage(pigSheet, cell.x, cell.y, cell.width, cell.height, -width / 2, -height / 2, width, height)
    context.restore()
  }

  function drawPigOverlay(faceState: Face) {
    if (eatCount < CHEEK_MAX_COUNT || !pigSheet.complete) return
    const headCenter = lerpPoint(faceState.leftEdge, faceState.rightEdge, .5)
    const width = faceState.width
    const earRise = width * .15
    const leftEar = {
      x: headCenter.x - Math.cos(faceState.angle) * width * .31 + Math.sin(faceState.angle) * earRise,
      y: faceState.forehead.y - Math.sin(faceState.angle) * width * .31 - Math.cos(faceState.angle) * earRise,
    }
    const rightEar = {
      x: headCenter.x + Math.cos(faceState.angle) * width * .31 + Math.sin(faceState.angle) * earRise,
      y: faceState.forehead.y + Math.sin(faceState.angle) * width * .31 - Math.cos(faceState.angle) * earRise,
    }
    drawPigPart(PIG_CELLS.leftEar, leftEar, width * .34, width * .28, faceState.angle - .28)
    drawPigPart(PIG_CELLS.rightEar, rightEar, width * .34, width * .28, faceState.angle + .28)
    drawPigPart(PIG_CELLS.nose, { x: faceState.nose.x, y: faceState.nose.y + width * .025 }, width * .34, width * .24, faceState.angle)
  }

  function drawTear(eye: Point, faceState: Face, now: number, phase: number) {
    const cycle = (now / 1850 + phase) % 1
    const fade = Math.pow(Math.sin(Math.PI * cycle), .72)
    const width = faceState.width * .027
    const height = faceState.width * (.07 + cycle * .11)
    const startY = faceState.width * .045

    context.save()
    context.translate(eye.x, eye.y + startY)
    context.rotate(faceState.angle * .25)
    const fill = context.createLinearGradient(0, 0, 0, height)
    fill.addColorStop(0, `rgba(255, 255, 255, ${.13 * fade})`)
    fill.addColorStop(.42, `rgba(255, 255, 255, ${.27 * fade})`)
    fill.addColorStop(1, `rgba(255, 255, 255, ${.05 * fade})`)
    context.fillStyle = fill
    context.strokeStyle = `rgba(255, 255, 255, ${.34 * fade})`
    context.lineWidth = Math.max(.7, faceState.width * .004)
    context.beginPath()
    context.moveTo(0, 0)
    context.bezierCurveTo(width, height * .18, width * .86, height * .58, 0, height)
    context.bezierCurveTo(-width * .86, height * .58, -width, height * .18, 0, 0)
    context.fill()
    context.stroke()
    context.strokeStyle = `rgba(255, 255, 255, ${.48 * fade})`
    context.lineWidth = Math.max(.55, faceState.width * .0025)
    context.beginPath()
    context.moveTo(-width * .3, height * .17)
    context.quadraticCurveTo(-width * .16, height * .42, -width * .2, height * .62)
    context.stroke()
    context.restore()
  }

  function drawTears(faceState: Face, now: number) {
    if (eatCount < CHEEK_MAX_COUNT) return
    drawTear(faceState.leftEye, faceState, now, .08)
    drawTear(faceState.rightEye, faceState, now, .56)
  }

  function render(now: number) {
    if (!running || !isActive()) return
    const delta = Math.min(50, now - lastFrameAt)
    lastFrameAt = now
    updateFaceTracking(now)
    updateHandTracking(now)
    updateFoodStates(now, delta)

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    context.clearRect(0, 0, stageRect.width, stageRect.height)
    if (!renderWebcam(now)) drawVideoCover(context)
    foods.filter((food) => food.state !== 'grabbed').forEach((food) => drawFood(food, now))
    foods.filter((food) => food.state === 'grabbed').forEach((food) => drawFood(food, now))
    if (face) {
      drawPigOverlay(face)
      drawTears(face, now)
    }
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
      makeFoods()
      running = true
      host.classList.add('camera-ready')
      gate.classList.add('hidden')
      lastFrameAt = performance.now()
      setStatus('손과 얼굴을 찾고 있어요')
      frame = requestAnimationFrame(render)
      void ensureHandTracker().then(() => {
        if (running) setStatus('핀치 준비 완료. 음식을 집어 보세요', 'active')
      }).catch(() => {
        if (running) setStatus('손 추적을 시작하지 못했어요', 'error')
      })
      void ensureFaceTracker().catch(() => {
        if (running) setStatus('얼굴 추적을 시작하지 못했어요', 'error')
      })
    } catch {
      setStatus('카메라 권한이 필요해요', 'error')
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
    lastHandTime = -1
    lastFaceTime = -1
    lastFaceAt = 0
    face = null
    smoothedPoints.clear()
    previousPinchIds.clear()
    grabbedFoodId = null
    hold.classList.remove('visible')
    host.classList.remove('camera-ready')
    gate.classList.remove('hidden')
    context.clearRect(0, 0, stageRect.width, stageRect.height)
  }

  function reset() {
    eatCount = 0
    cheekBounceAt = -Infinity
    updateGauge()
    makeFoods()
    hold.classList.remove('visible')
    setStatus(running ? '새 식탁을 준비했어요. 다시 집어 보세요!' : '카메라를 시작해 보세요', running ? 'active' : 'ready')
  }

  startButton.addEventListener('click', () => { void activate() })
  resetButton.addEventListener('click', reset)
  makeFoods()
  resizeCanvas()
  return { activate, deactivate }
}
