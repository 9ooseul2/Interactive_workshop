import { barycentric, GRACE_MS, poseOf } from './shampoo/geometry.ts'
import type { HeadMask, Point, Triangle } from './shampoo/geometry.ts'
import { ShampooFoam } from './shampoo/foam.ts'
import { ShampooGestures } from './shampoo/gestures.ts'
import type { HandObservation } from './shampoo/gestures.ts'
import './shampoo.css'

type Reply = { type: 'ready'; triangles: Triangle[]; labels?: string[] } | { type: 'hands'; timestamp: number; hands: HandObservation[] } | { type: 'face'; timestamp: number; points: Point[] | null; head: HeadMask | null; segmented: boolean } | { type: 'error'; message: string } | { type: 'closed' }
type Inference = { worker: Worker; ready: boolean; busy: boolean; sentAt: number; videoTime: number; timeout: number }
type PendingStamp = { point: Point; face: Point[] }

export function setupShampoo(host: HTMLElement, isActive: () => boolean) {
  host.innerHTML = `
    <div class="shampoo-stage">
      <video id="shampoo-camera" class="shampoo-camera" autoplay muted playsinline></video>
      <canvas class="shampoo-foam" aria-label="얼굴에 붙는 샴푸 거품"></canvas>
      <div class="shampoo-heading"><span>INTERACTIVE CAMERA / 09</span><h1>SHAM<br><em>POO.</em></h1><p>A LITTLE FOAM, A LITTLE FUN.</p></div>
      <div class="shampoo-guide"><b>PINCH & LATHER</b><p>엄지와 검지를 맞대세요.<br>Pinch를 유지한 채 얼굴과 머리 위에<br>투명한 거품을 그릴 수 있어요.</p></div>
      <p class="shampoo-status" role="status" aria-live="polite">카메라 준비</p>
      <button class="shampoo-reset" type="button" aria-label="추가한 거품 지우기">↻ 거품 씻기</button>
      <div class="shampoo-gate"><span>YOUR DAILY BUBBLE BREAK</span><h2>오늘은<br><em>거품 놀이.</em></h2><p class="shampoo-message">손끝으로 나만의 거품을 만들어 보세요.</p><button class="shampoo-start" type="button">카메라 시작 ↗</button><small>영상은 기기 안에서 처리됩니다.</small></div>
    </div>`

  const video = host.querySelector<HTMLVideoElement>('#shampoo-camera')!
  const canvas = host.querySelector<HTMLCanvasElement>('.shampoo-foam')!
  const context = canvas.getContext('2d')!
  const gate = host.querySelector<HTMLElement>('.shampoo-gate')!
  const start = host.querySelector<HTMLButtonElement>('.shampoo-start')!
  const message = host.querySelector<HTMLElement>('.shampoo-message')!
  const status = host.querySelector<HTMLElement>('.shampoo-status')!
  const foam = new ShampooFoam()
  const gestures = new ShampooGestures()
  let stream: MediaStream | null = null
  let hands: Inference | null = null, vision: Inference | null = null
  let running = false, starting = false, session = 0, frame = 0
  let width = 1, height = 1, aspect = 16 / 9
  let face: Point[] | null = null, triangles: Triangle[] = []
  let faceSeenAt = -Infinity, faceMissingAt = Infinity, headUntil = -Infinity, segmentAt = -Infinity
  let pendingStamps: PendingStamp[] = []
  const retired = new Map<Worker, number>()

  function setStatus(text: string) { if (status.textContent !== text) status.textContent = text }
  function resize() {
    const rect = host.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    width = rect.width; height = rect.height
    const ratio = Math.min(devicePixelRatio || 1, 1.5)
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(host)

  function retire(slot: Inference | null, immediate: boolean) {
    if (!slot) return
    clearTimeout(slot.timeout)
    if (immediate) { slot.worker.terminate(); return }
    const worker = slot.worker
    worker.onerror = null
    worker.onmessage = ({ data }: MessageEvent<Reply>) => {
      if (data.type !== 'closed') return
      const timer = retired.get(worker)
      if (timer) clearTimeout(timer)
      retired.delete(worker); worker.terminate()
    }
    worker.postMessage({ type: 'close' })
    retired.set(worker, window.setTimeout(() => { worker.terminate(); retired.delete(worker) }, 400))
  }

  function deactivate(immediate = false) {
    session += 1; running = false; starting = false
    cancelAnimationFrame(frame)
    stream?.getTracks().forEach(track => track.stop()); stream = null
    video.pause(); video.srcObject = null
    retire(hands, immediate); retire(vision, immediate); hands = vision = null
    if (immediate) retired.forEach((timer, worker) => { clearTimeout(timer); worker.terminate(); retired.delete(worker) })
    face = null; triangles = []; pendingStamps = []
    faceSeenAt = -Infinity; faceMissingAt = Infinity; headUntil = -Infinity; segmentAt = -Infinity
    gestures.reset(); foam.clear(); context.clearRect(0, 0, width, height)
    gate.classList.remove('hidden'); start.disabled = false; start.textContent = '카메라 시작 ↗'
  }

  function fail(text: string, error?: unknown) {
    if (error) console.error('[Shampoo]', error)
    deactivate(); message.textContent = text; setStatus(text)
  }

  function faceAvailable(now: number) { return Boolean(face) && now - faceMissingAt <= GRACE_MS && now - faceSeenAt < 1800 }
  function hit(point: Point) {
    const now = performance.now()
    if (!face || !faceAvailable(now)) return false
    if (now < headUntil && foam.contains(point)) return true
    return triangles.some(([a, b, c]) => {
      const weights = barycentric(point, face![a], face![b], face![c])
      return Boolean(weights && Math.min(...weights) >= 0)
    })
  }

  function worker(role: 'hands' | 'face', token: number): Inference {
    const value = new Worker(new URL('./shampoo/inference.worker.ts', import.meta.url), { type: 'module', name: `shampoo-${role}` })
    const slot: Inference = { worker: value, ready: false, busy: false, sentAt: -Infinity, videoTime: -1, timeout: 0 }
    slot.timeout = window.setTimeout(() => { if (session === token) fail('인식 준비가 지연됐어요. 다시 시작해 주세요.') }, 45000)
    value.onerror = event => { if (session === token) fail('인식을 시작하지 못했어요. 다시 시도해 주세요.', event.message) }
    value.onmessage = ({ data }: MessageEvent<Reply>) => {
      if (session !== token) return
      if (data.type === 'error') { fail('인식 연결을 확인한 뒤 다시 시작해 주세요.', data.message); return }
      if (data.type === 'ready') {
        clearTimeout(slot.timeout); slot.ready = true
        if (role === 'face') triangles = data.triangles
        setStatus(hands?.ready && vision?.ready ? '얼굴과 머리를 찾고 있어요' : '거품 놀이 준비 중…')
        return
      }
      slot.busy = false
      const now = performance.now()
      if (data.type === 'face') {
        if (data.points) { face = data.points; faceSeenAt = now; faceMissingAt = Infinity }
        else if (!Number.isFinite(faceMissingAt)) faceMissingAt = now
        if (data.segmented) {
          if (data.head && data.points) { foam.setHead(data.head, data.points, aspect); headUntil = now + 1150 }
          else headUntil = Math.min(headUntil, now + GRACE_MS)
        }
      }
      if (data.type === 'hands') {
        if (face && faceAvailable(now)) gestures.update(data.hands, now, poseOf(face).scale, hit, point => pendingStamps.push({ point, face: face! }))
        else gestures.reset()
      }
    }
    value.postMessage({ type: 'init', role })
    return slot
  }

  async function send(slot: Inference, now: number, segment: boolean, token: number) {
    slot.busy = true; slot.sentAt = now; slot.videoTime = video.currentTime
    try {
      const bitmap = await createImageBitmap(video, { resizeWidth: 640, resizeHeight: Math.round(640 / aspect), resizeQuality: 'low' })
      if (session !== token || !running) { bitmap.close(); return }
      slot.worker.postMessage({ type: 'frame', bitmap, timestamp: now, segment }, [bitmap])
    } catch (error) {
      slot.busy = false
      if (session === token && running) fail('카메라 프레임을 읽지 못했어요. 다시 시작해 주세요.', error)
    }
  }

  function render(now: number) {
    if (!running || !isActive()) return
    const gesturing = gestures.active(now)
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      if (hands?.ready && !hands.busy && now - hands.sentAt >= (gesturing ? 33 : 45) && hands.videoTime !== video.currentTime) void send(hands, now, false, session)
      if (vision?.ready && !vision.busy && now - vision.sentAt >= (gesturing ? 110 : 75) && vision.videoTime !== video.currentTime) {
        const shouldSegment = now - segmentAt >= (gesturing ? 800 : 240)
        if (shouldSegment) segmentAt = now
        void send(vision, now, shouldSegment, session)
      }
      if ((hands?.busy && now - hands.sentAt > 8000) || (vision?.busy && now - vision.sentAt > 8000)) { fail('인식이 멈췄어요. 다시 시작해 주세요.'); return }
    }
    context.clearRect(0, 0, width, height)
    const deadline = performance.now() + 3
    while (pendingStamps.length && performance.now() < deadline) {
      const stamp = pendingStamps.shift()!
      foam.stamp(stamp.point, stamp.face, triangles)
    }
    if (face && faceAvailable(now)) {
      const pixelScale = Math.max(width / aspect, height)
      const project = (point: Point) => ({ x: width / 2 + (aspect / 2 - point.x) * pixelScale, y: height / 2 + (point.y - .5) * pixelScale })
      foam.draw(context, face, now, project, pixelScale, now < headUntil)
      if (hands?.ready && vision?.ready) setStatus(gesturing ? '몽글몽글, 거품을 만드는 중' : now < headUntil ? '손끝으로 거품을 만들어 보세요' : '머리가 잘 보이도록 정면을 바라봐 주세요')
    } else if (vision?.ready) setStatus('얼굴이 카메라 안에 들어오도록 해 주세요')
    frame = requestAnimationFrame(render)
  }

  async function activate() {
    if (running || starting || !isActive()) return
    const token = ++session
    starting = true; start.disabled = true; start.textContent = '준비 중…'
    message.textContent = '카메라 권한을 허용해 주세요.'; setStatus('카메라 연결 중…')
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      if (session !== token || !isActive()) { nextStream.getTracks().forEach(track => track.stop()); return }
      stream = nextStream; video.srcObject = nextStream
      nextStream.getVideoTracks()[0]?.addEventListener('ended', () => { if (session === token) fail('카메라 연결이 종료됐어요. 다시 시작해 주세요.') }, { once: true })
      await video.play()
      if (session !== token || !isActive()) return
      aspect = video.videoWidth / video.videoHeight
      hands = worker('hands', token); vision = worker('face', token)
      running = true; starting = false; gate.classList.add('hidden'); resize()
      frame = requestAnimationFrame(render)
    } catch (error) {
      if (session === token) fail('카메라 권한과 네트워크 연결을 확인해 주세요.', error)
    }
  }

  start.addEventListener('click', () => { void activate() })
  host.querySelector<HTMLButtonElement>('.shampoo-reset')!.addEventListener('click', () => { foam.resetStrokes(); gestures.reset(); pendingStamps = [] })
  const pageHide = () => deactivate(true)
  const visibility = () => { if (document.hidden) deactivate(true) }
  window.addEventListener('pagehide', pageHide)
  document.addEventListener('visibilitychange', visibility)
  return { activate, deactivate: () => deactivate(), dispose: () => { deactivate(true); resizeObserver.disconnect(); window.removeEventListener('pagehide', pageHide); document.removeEventListener('visibilitychange', visibility) } }
}
