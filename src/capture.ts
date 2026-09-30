import './capture.css'

const HOLD_DURATION = 520
type Html2Canvas = typeof import('html2canvas').default
let html2canvasLoader: Promise<Html2Canvas> | null = null

function loadHtml2Canvas() {
  html2canvasLoader ??= import('html2canvas').then((module) => module.default)
  return html2canvasLoader
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
}

function recordingMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ]
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime))
}

export function setupCapture() {
  const control = document.createElement('div')
  control.className = 'capture-control'
  control.dataset.html2canvasIgnore = 'true'
  control.innerHTML = `
    <p class="capture-status" role="status" aria-live="polite"></p>
    <button class="capture-button" type="button" aria-label="짧게 눌러 사진 촬영, 길게 눌러 동영상 촬영">
      <span class="capture-button-core" aria-hidden="true"></span>
    </button>
    <small>짧게: 사진 · 길게: 동영상</small>
  `
  document.body.append(control)

  const button = control.querySelector<HTMLButtonElement>('.capture-button')!
  const status = control.querySelector<HTMLElement>('.capture-status')!
  let pressedAt = 0
  let isPressing = false
  let recorder: MediaRecorder | null = null
  let recordingStream: MediaStream | null = null
  let chunks: BlobPart[] = []
  let stopPageRender: (() => void) | null = null

  function setStatus(text = '') {
    status.textContent = text
    control.classList.toggle('has-status', Boolean(text))
  }

  async function renderPage(scale: number) {
    const activeVideo = document.querySelector<HTMLVideoElement>('section.active video')
    const activeVideoId = activeVideo?.id ?? ''
    let videoFrame = ''
    try {
      if (activeVideo && activeVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        const frame = document.createElement('canvas')
        frame.width = activeVideo.videoWidth
        frame.height = activeVideo.videoHeight
        frame.getContext('2d')?.drawImage(activeVideo, 0, 0)
        videoFrame = frame.toDataURL('image/png')
      }
    } catch {
      // A camera frame that cannot be read still leaves the rest of the page capturable.
    }
    const html2canvas = await loadHtml2Canvas()
    return html2canvas(document.querySelector<HTMLElement>('.game-shell')!, {
      backgroundColor: '#0d1715',
      logging: false,
      scale,
      useCORS: true,
      onclone: (documentClone) => {
        if (!videoFrame) return
        const cloneVideo = documentClone.querySelector<HTMLVideoElement>(`#${activeVideoId}`)
        if (!cloneVideo) return
        const image = documentClone.createElement('img')
        image.src = videoFrame
        image.className = cloneVideo.className
        image.style.cssText = cloneVideo.style.cssText
        cloneVideo.replaceWith(image)
      },
    })
  }

  async function takePhoto() {
    setStatus('사진 저장 중…')
    button.disabled = true
    try {
      const canvas = await renderPage(Math.min(window.devicePixelRatio || 1, 2))
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('PNG export failed')
      download(blob, `claw-club-${timestamp()}.png`)
      setStatus('사진이 저장됐어요')
    } catch {
      setStatus('사진을 저장하지 못했어요')
    } finally {
      button.disabled = false
      window.setTimeout(() => setStatus(), 1800)
    }
  }

  function stopRecording() {
    if (!recorder || recorder.state === 'inactive') return
    setStatus('영상 저장 중…')
    recorder.stop()
  }

  async function startRecording() {
    if (recorder) return
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      setStatus('이 브라우저는 동영상 촬영을 지원하지 않아요')
      window.setTimeout(() => setStatus(), 2400)
      return
    }
    try {
      const recordingCanvas = document.createElement('canvas')
      const recordingContext = recordingCanvas.getContext('2d')!
      let renderActive = true
      let renderTimer = 0
      const renderFrame = async () => {
        if (!renderActive) return
        try {
          const frame = await renderPage(1)
          if (recordingCanvas.width !== frame.width || recordingCanvas.height !== frame.height) {
            recordingCanvas.width = frame.width
            recordingCanvas.height = frame.height
          }
          recordingContext.drawImage(frame, 0, 0)
        } catch {
          // Keep the last valid frame if one DOM render is interrupted.
        }
        if (renderActive) renderTimer = window.setTimeout(() => { void renderFrame() }, 125)
      }
      await renderFrame()
      stopPageRender = () => {
        renderActive = false
        window.clearTimeout(renderTimer)
      }
      recordingStream = recordingCanvas.captureStream(8)
      const mimeType = recordingMimeType()
      recorder = mimeType ? new MediaRecorder(recordingStream, { mimeType }) : new MediaRecorder(recordingStream)
      chunks = []
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      })
      recorder.addEventListener('stop', () => {
        const type = recorder?.mimeType || mimeType || 'video/webm'
        const extension = type.includes('mp4') ? 'mp4' : 'webm'
        if (chunks.length) download(new Blob(chunks, { type }), `claw-club-${timestamp()}.${extension}`)
        stopPageRender?.()
        stopPageRender = null
        recordingStream?.getTracks().forEach((track) => track.stop())
        recordingStream = null
        recorder = null
        chunks = []
        button.classList.remove('recording')
        button.setAttribute('aria-label', '짧게 눌러 사진 촬영, 길게 눌러 동영상 촬영')
        setStatus('영상이 저장됐어요')
        window.setTimeout(() => setStatus(), 1800)
      }, { once: true })
      recorder.start(250)
      button.classList.remove('arming')
      button.classList.add('recording')
      button.setAttribute('aria-label', '녹화 중지 및 저장')
      setStatus('REC · 버튼을 다시 눌러 저장')
    } catch {
      stopPageRender?.()
      stopPageRender = null
      recordingStream?.getTracks().forEach((track) => track.stop())
      recordingStream = null
      recorder = null
      button.classList.remove('arming')
      setStatus('화면 녹화가 취소됐어요')
      window.setTimeout(() => setStatus(), 1800)
    }
  }

  function beginPress(event: PointerEvent) {
    if (recorder) {
      event.preventDefault()
      stopRecording()
      return
    }
    if (button.disabled) return
    isPressing = true
    pressedAt = performance.now()
    button.classList.add('arming')
    button.setPointerCapture?.(event.pointerId)
  }

  function endPress(event: PointerEvent) {
    if (!isPressing || recorder) return
    isPressing = false
    button.classList.remove('arming')
    const heldLongEnough = performance.now() - pressedAt >= HOLD_DURATION
    if (heldLongEnough) void startRecording()
    else void takePhoto()
    if (button.hasPointerCapture?.(event.pointerId)) button.releasePointerCapture(event.pointerId)
  }

  function cancelPress() {
    if (!isPressing) return
    isPressing = false
    button.classList.remove('arming')
  }

  button.addEventListener('pointerdown', beginPress)
  button.addEventListener('pointerup', endPress)
  button.addEventListener('pointercancel', cancelPress)
  button.addEventListener('contextmenu', (event) => event.preventDefault())
  button.addEventListener('keydown', (event) => {
    if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    if (recorder) stopRecording()
    else void takePhoto()
  })
}
