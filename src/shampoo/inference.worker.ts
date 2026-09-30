import { FaceLandmarker, FilesetResolver, HandLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision'
import { extractHead } from './geometry.ts'
import type { Triangle } from './geometry.ts'

type Request = { type: 'init'; role: 'hands' | 'face' } | { type: 'frame'; bitmap: ImageBitmap; timestamp: number; segment: boolean } | { type: 'close' }
type Scope = { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage: (data: unknown) => void; close: () => void; import: (url: string) => Promise<void>; ModuleFactory?: unknown }
const scope = self as unknown as Scope
let handLandmarker: HandLandmarker | null = null
let faceLandmarker: FaceLandmarker | null = null
let segmenter: ImageSegmenter | null = null
let selfieChannel = -1, disposed = false
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const MODELS = 'https://storage.googleapis.com/mediapipe-models'

// Tasks Vision clears ModuleFactory after an instance is created. Dynamic
// import lets the cached ESM loader reinstall it before the second task.
scope.import = async url => { const module = await import(/* @vite-ignore */ url); scope.ModuleFactory = module.default }

function release() {
  disposed = true
  handLandmarker?.close(); faceLandmarker?.close(); segmenter?.close()
  handLandmarker = null; faceLandmarker = null; segmenter = null
}

async function initialize(role: 'hands' | 'face') {
  const vision = await FilesetResolver.forVisionTasks(WASM, true)
  if (disposed) return
  if (role === 'hands') {
    handLandmarker = await HandLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: `${MODELS}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: .5, minHandPresenceConfidence: .5, minTrackingConfidence: .5 })
  } else {
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: `${MODELS}/face_landmarker/face_landmarker/float16/1/face_landmarker.task` }, runningMode: 'VIDEO', numFaces: 1 })
    if (disposed) { release(); return }
    segmenter = await ImageSegmenter.createFromOptions(vision, { baseOptions: { modelAssetPath: `${MODELS}/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite` }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false })
    selfieChannel = segmenter.getLabels().findIndex(label => label.trim().toLowerCase() === 'selfie')
    if (selfieChannel < 0) throw new Error('HumanSeg selfie confidence channel unavailable')
  }
  if (disposed) { release(); return }
  const triangles: Triangle[] = []
  if (faceLandmarker) {
    const connections = FaceLandmarker.FACE_LANDMARKS_TESSELATION
    for (let index = 0; index + 2 < connections.length; index += 3) {
      const points = [...new Set(connections.slice(index, index + 3).flatMap(connection => [connection.start, connection.end]))]
      if (points.length === 3) triangles.push(points as Triangle)
    }
  }
  scope.postMessage({ type: 'ready', triangles, labels: segmenter?.getLabels() })
}

scope.onmessage = ({ data }) => {
  if (data.type === 'close') { release(); scope.postMessage({ type: 'closed' }); scope.close(); return }
  if (data.type === 'init') { void initialize(data.role).catch(error => { release(); scope.postMessage({ type: 'error', message: String(error) }) }); return }
  const { bitmap, timestamp } = data
  if (disposed) { bitmap.close(); return }
  try {
    const aspect = bitmap.width / bitmap.height
    if (handLandmarker) {
      const result = handLandmarker.detectForVideo(bitmap, timestamp)
      scope.postMessage({ type: 'hands', timestamp, hands: result.landmarks.map((landmarks, index) => ({ label: result.handedness[index]?.[0]?.categoryName ?? String(index), points: landmarks.map(point => ({ x: point.x * aspect, y: point.y, z: point.z })) })) })
    } else if (faceLandmarker && segmenter) {
      const result = faceLandmarker.detectForVideo(bitmap, timestamp)
      const points = result.faceLandmarks[0]?.map(point => ({ x: point.x * aspect, y: point.y, z: point.z })) ?? null
      let head = null
      if (data.segment && points) {
        segmenter.segmentForVideo(bitmap, timestamp, segmentation => {
          const mask = segmentation.confidenceMasks?.[selfieChannel]
          if (mask) head = extractHead(mask.getAsFloat32Array(), mask.width, mask.height, points, aspect)
        })
      }
      scope.postMessage({ type: 'face', timestamp, points, head, segmented: data.segment })
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: String(error) })
  } finally { bitmap.close() }
}
