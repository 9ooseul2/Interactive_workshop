import './sampler.css'

const PAD_KEYS = ['q', 'w', 'e', 'a', 's', 'd', 'z', 'x', 'c'] as const
type PadKey = (typeof PAD_KEYS)[number]

const PAD_CODES: Record<string, PadKey> = {
  KeyQ: 'q',
  KeyW: 'w',
  KeyE: 'e',
  KeyA: 'a',
  KeyS: 's',
  KeyD: 'd',
  KeyZ: 'z',
  KeyX: 'x',
  KeyC: 'c',
}

type LoopEvent = { key: PadKey; at: number }
type Recording = {
  id: string
  name: string
  duration: number
  events: LoopEvent[]
  layers: number
}
type PadSettings = { pitch: number; speed: number }

type SamplingMode = 'off' | 'armed' | 'recording' | 'restore'

const padInfo: Record<PadKey, { name: string; color: string; rgb: string }> = {
  q: { name: 'KICK', color: '#ff8c78', rgb: '255,140,120' },
  w: { name: 'SNARE', color: '#ffc36b', rgb: '255,195,107' },
  e: { name: 'HI-HAT', color: '#f5ed83', rgb: '245,237,131' },
  a: { name: 'LOW TOM', color: '#86e4a6', rgb: '134,228,166' },
  s: { name: 'CLAP', color: '#75e6d0', rgb: '117,230,208' },
  d: { name: 'PERC', color: '#74c9ff', rgb: '116,201,255' },
  z: { name: 'BASS', color: '#9eabff', rgb: '158,171,255' },
  x: { name: 'SYNTH', color: '#cf9cff', rgb: '207,156,255' },
  c: { name: 'CHORD', color: '#ff9ed2', rgb: '255,158,210' },
}

export function setupSampler(host: HTMLElement, isActive: () => boolean) {
  host.innerHTML = `
    <div class="sampler-backdrop"></div>
    <div class="sampler-heading">
      <p class="sampler-kicker">BROWSER INSTRUMENT / 02</p>
      <h1>KEYBOARD<br><em>SAMPLER</em></h1>
      <p>키보드 아홉 개로 만드는<br>나만의 사운드 레이어</p>
    </div>

    <div class="sampler-studio">
      <aside class="sample-tools studio-card">
        <div class="card-label"><span>01</span> SAMPLE INPUT</div>
        <button id="sample-mode" class="sample-mode-button" type="button">
          <span class="mic-icon"></span>
          <span><b>샘플링</b><small>마이크로 패드 사운드 만들기</small></span>
        </button>
        <button id="restore-sample" class="restore-sample-button" type="button">
          <span>↺</span><span><b>원음 복구</b><small>녹음한 샘플 취소하기</small></span>
        </button>
        <div id="sample-guide" class="sample-guide">
          버튼을 누른 뒤 원하는 키를 선택하세요.
        </div>
        <ol class="mini-steps">
          <li><span>1</span> 샘플링 버튼 선택</li>
          <li><span>2</span> 녹음할 키 한 번 누르기</li>
          <li><span>3</span> 같은 키를 다시 눌러 완료</li>
        </ol>

        <div class="divider"></div>
        <div class="card-label"><span>02</span> PERFORMANCE REC</div>
        <button id="record-performance" class="performance-record" type="button">
          <i></i><span><b>녹음 시작</b><small>SPACE BAR</small></span>
        </button>
        <p class="overdub-help">녹음본을 선택하고 다시 녹음하면 기존 루프 위에 새로운 연주가 쌓입니다.</p>
      </aside>

      <section class="pad-deck studio-card" aria-label="샘플러 패드">
        <div class="deck-head">
          <div><small>CLAW CLUB AUDIO LAB</small><strong>NINE / 01</strong></div>
          <span id="audio-state"><i></i> AUDIO READY</span>
        </div>
        <canvas id="sampler-scope" class="sampler-scope" aria-hidden="true"></canvas>
        <div class="sound-editor" aria-label="선택한 패드 사운드 편집">
          <div class="editor-target">
            <small>EDITING PAD</small>
            <strong id="editor-key">Q</strong>
            <span>길게 눌러 선택</span>
          </div>
          <div class="editor-control">
            <span><small>PITCH</small><b>피치</b></span>
            <button type="button" data-adjust="pitch-down" aria-label="피치 낮추기">−</button>
            <output id="pitch-value">0 ST</output>
            <button type="button" data-adjust="pitch-up" aria-label="피치 높이기">＋</button>
          </div>
          <div class="editor-control">
            <span><small>SPEED</small><b>속도</b></span>
            <button type="button" data-adjust="speed-down" aria-label="속도 느리게">−</button>
            <output id="speed-value">1.0×</output>
            <button type="button" data-adjust="speed-up" aria-label="속도 빠르게">＋</button>
          </div>
        </div>
        <div class="pads">
          ${PAD_KEYS.map((key, index) => {
            const info = padInfo[key]
            return `
              <button class="sample-pad has-sound" data-pad="${key}" type="button"
                style="--pad-color:${info.color};--pad-rgb:${info.rgb}" aria-label="${key.toUpperCase()} ${info.name} 패드">
                <span class="pad-number">0${index + 1}</span>
                <kbd>${key.toUpperCase()}</kbd>
                <strong>${info.name}</strong>
                <small data-source="${key}">BUILT-IN</small>
              </button>
            `
          }).join('')}
        </div>
        <div class="deck-footer">
          <span><i class="keyboard-dot"></i> Q W E · A S D · Z X C</span>
          <span>POLYPHONIC / ZERO LATENCY</span>
        </div>
      </section>

      <aside class="takes-panel studio-card">
        <div class="takes-head">
          <div class="card-label"><span>03</span> RECORDINGS</div>
          <div class="takes-actions">
            <button id="play-all" class="play-all" type="button"><i></i><span>전체 재생</span></button>
            <button id="new-recording" type="button">＋ 새 녹음</button>
          </div>
        </div>
        <div id="recording-list" class="recording-list"></div>
        <div class="takes-footer"><span id="take-count">0 TAKES</span><span>LOOP ENABLED</span></div>
      </aside>
    </div>
  `

  const padButtons = new Map<PadKey, HTMLButtonElement>()
  host.querySelectorAll<HTMLButtonElement>('.sample-pad').forEach((button) => {
    padButtons.set(button.dataset.pad as PadKey, button)
  })
  const sampleModeButton = host.querySelector<HTMLButtonElement>('#sample-mode')!
  const restoreSampleButton = host.querySelector<HTMLButtonElement>('#restore-sample')!
  const restoreSampleLabel = restoreSampleButton.querySelector<HTMLElement>('b')!
  const restoreSampleDescription = restoreSampleButton.querySelector<HTMLElement>('small')!
  const sampleGuide = host.querySelector<HTMLElement>('#sample-guide')!
  const performanceButton = host.querySelector<HTMLButtonElement>('#record-performance')!
  const performanceLabel = performanceButton.querySelector<HTMLElement>('b')!
  const newRecordingButton = host.querySelector<HTMLButtonElement>('#new-recording')!
  const playAllButton = host.querySelector<HTMLButtonElement>('#play-all')!
  const playAllLabel = playAllButton.querySelector<HTMLElement>('span')!
  const recordingList = host.querySelector<HTMLElement>('#recording-list')!
  const takeCount = host.querySelector<HTMLElement>('#take-count')!
  const audioState = host.querySelector<HTMLElement>('#audio-state')!
  const scope = host.querySelector<HTMLCanvasElement>('#sampler-scope')!
  const scopeContext = scope.getContext('2d')!
  const editorKey = host.querySelector<HTMLElement>('#editor-key')!
  const pitchValue = host.querySelector<HTMLOutputElement>('#pitch-value')!
  const speedValue = host.querySelector<HTMLOutputElement>('#speed-value')!
  const editorButtons = [...host.querySelectorAll<HTMLButtonElement>('[data-adjust]')]

  let audioContext: AudioContext | null = null
  let masterGain: GainNode | null = null
  let analyser: AnalyserNode | null = null
  let loadingStarted = false
  const buffers = new Map<PadKey, AudioBuffer>()
  const sourceLabels = new Map<PadKey, string>()
  const originalBuffers = new Map<PadKey, AudioBuffer>()
  const originalLabels = new Map<PadKey, string>()
  const microphonePads = new Set<PadKey>()
  const physicallyHeld = new Set<PadKey>()
  const padSettings = new Map<PadKey, PadSettings>(PAD_KEYS.map((key) => [key, { pitch: 0, speed: 1 }]))
  const longPressTimers = new Map<PadKey, number>()
  let editorPad: PadKey = 'q'

  let samplingMode: SamplingMode = 'off'
  let samplingKey: PadKey | null = null
  let mediaRecorder: MediaRecorder | null = null
  let microphoneStream: MediaStream | null = null
  let microphoneChunks: Blob[] = []
  let discardMicrophoneRecording = false

  const recordings: Recording[] = []
  let selectedRecordingId: string | null = null
  let isPerformanceRecording = false
  let performanceStart = 0
  let overdubRecordingId: string | null = null
  let currentLayer: LoopEvent[] = []

  const loopingRecordingIds = new Set<string>()
  let loopTimer: number | null = null
  const nextCycleTimes = new Map<string, number>()
  let playingAll = false
  let loopNodes = new Set<AudioBufferSourceNode>()
  let visualTimers: number[] = []

  function setGuide(message: string, state: 'normal' | 'armed' | 'recording' | 'error' = 'normal') {
    sampleGuide.textContent = message
    sampleGuide.dataset.state = state
  }

  function makeSynthBuffer(context: AudioContext, key: PadKey) {
    const sampleRate = context.sampleRate
    const duration = key === 'c' ? 1.2 : key === 'z' || key === 'x' ? 0.8 : 0.48
    const buffer = context.createBuffer(1, Math.floor(sampleRate * duration), sampleRate)
    const data = buffer.getChannelData(0)
    let phase = 0

    for (let index = 0; index < data.length; index += 1) {
      const time = index / sampleRate
      const progress = time / duration
      let value = 0
      if (key === 'q') {
        const frequency = 155 * Math.exp(-time * 18) + 42
        phase += (Math.PI * 2 * frequency) / sampleRate
        value = Math.sin(phase) * Math.exp(-time * 9)
      } else if (key === 'w') {
        value = ((Math.random() * 2 - 1) * 0.78 + Math.sin(time * Math.PI * 2 * 175) * 0.22) * Math.exp(-time * 13)
      } else if (key === 'e') {
        value = (Math.random() * 2 - 1) * Math.exp(-time * 32) * (index % 2 ? 1 : -0.55)
      } else if (key === 'a') {
        const frequency = 118 * Math.exp(-time * 6) + 62
        phase += (Math.PI * 2 * frequency) / sampleRate
        value = Math.sin(phase) * Math.exp(-time * 7)
      } else if (key === 's') {
        const burst = Math.max(0, 1 - ((time * 15) % 1) * 4)
        value = (Math.random() * 2 - 1) * burst * Math.exp(-time * 9)
      } else if (key === 'd') {
        value = (Math.sin(time * Math.PI * 2 * 460) * 0.55 + (Math.random() * 2 - 1) * 0.3) * Math.exp(-time * 19)
      } else if (key === 'z') {
        value = (Math.sin(time * Math.PI * 2 * 65.41) + Math.sin(time * Math.PI * 2 * 130.82) * 0.25) * Math.exp(-time * 3.5) * 0.72
      } else if (key === 'x') {
        value = (Math.sin(time * Math.PI * 2 * 261.63) + Math.sin(time * Math.PI * 2 * 523.25) * 0.22) * Math.exp(-time * 4) * 0.65
      } else {
        value = ([261.63, 329.63, 392].reduce((sum, note) => sum + Math.sin(time * Math.PI * 2 * note), 0) / 3) * Math.pow(1 - progress, 1.8) * 0.72
      }
      data[index] = value
    }
    return buffer
  }

  async function tryLoadPublicSample(context: AudioContext, key: PadKey) {
    for (const extension of ['wav', 'mp3']) {
      try {
        const response = await fetch(`/sounds/${key}.${extension}`)
        const type = response.headers.get('content-type') ?? ''
        if (!response.ok || type.includes('text/html')) continue
        const decoded = await context.decodeAudioData(await response.arrayBuffer())
        const sourceName = extension.toUpperCase()
        originalBuffers.set(key, decoded)
        originalLabels.set(key, sourceName)
        if (!microphonePads.has(key)) {
          buffers.set(key, decoded)
          sourceLabels.set(key, sourceName)
          const label = host.querySelector<HTMLElement>(`[data-source="${key}"]`)
          if (label) label.textContent = sourceName
        }
        return
      } catch {
        // Try the other supported extension, then retain the built-in sample.
      }
    }
  }

  async function ensureAudio() {
    if (!audioContext) {
      audioContext = new AudioContext({ latencyHint: 'interactive' })
      masterGain = audioContext.createGain()
      analyser = audioContext.createAnalyser()
      masterGain.gain.value = 0.82
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.74
      masterGain.connect(analyser)
      analyser.connect(audioContext.destination)
      PAD_KEYS.forEach((key) => {
        const builtIn = makeSynthBuffer(audioContext!, key)
        buffers.set(key, builtIn)
        sourceLabels.set(key, 'BUILT-IN')
        originalBuffers.set(key, builtIn)
        originalLabels.set(key, 'BUILT-IN')
      })
      audioState.innerHTML = '<i></i> AUDIO ON'
    }
    if (audioContext.state === 'suspended') await audioContext.resume()
    if (!loadingStarted) {
      loadingStarted = true
      void Promise.all(PAD_KEYS.map((key) => tryLoadPublicSample(audioContext!, key)))
    }
    return audioContext
  }

  function setPadActive(key: PadKey, active: boolean) {
    padButtons.get(key)?.classList.toggle('active', active)
  }

  function updateEditor() {
    const settings = padSettings.get(editorPad)!
    editorKey.textContent = editorPad.toUpperCase()
    editorKey.style.color = padInfo[editorPad].color
    pitchValue.textContent = `${settings.pitch > 0 ? '+' : ''}${settings.pitch} ST`
    speedValue.textContent = `${settings.speed.toFixed(1)}×`
    padButtons.forEach((button, key) => button.classList.toggle('editing', key === editorPad))
  }

  function selectEditorPad(key: PadKey) {
    editorPad = key
    updateEditor()
  }

  function startLongPress(key: PadKey) {
    if (samplingMode !== 'off') return
    window.clearTimeout(longPressTimers.get(key))
    const timer = window.setTimeout(() => {
      selectEditorPad(key)
      padButtons.get(key)?.classList.add('long-pressed')
      window.setTimeout(() => padButtons.get(key)?.classList.remove('long-pressed'), 320)
      longPressTimers.delete(key)
    }, 580)
    longPressTimers.set(key, timer)
  }

  function cancelLongPress(key: PadKey) {
    const timer = longPressTimers.get(key)
    if (timer !== undefined) window.clearTimeout(timer)
    longPressTimers.delete(key)
  }

  function schedulePad(key: PadKey, when?: number, showVisual = true) {
    if (!audioContext || !masterGain) return null
    const buffer = buffers.get(key)
    if (!buffer) return null
    const source = audioContext.createBufferSource()
    source.buffer = buffer
    const settings = padSettings.get(key)!
    source.playbackRate.value = settings.speed
    source.detune.value = settings.pitch * 100
    source.connect(masterGain)
    const startAt = when ?? audioContext.currentTime
    source.start(startAt)
    if (showVisual && when !== undefined) {
      const delay = Math.max(0, (startAt - audioContext.currentTime) * 1000)
      const timer = window.setTimeout(() => {
        setPadActive(key, true)
        window.setTimeout(() => {
          if (!physicallyHeld.has(key)) setPadActive(key, false)
        }, 115)
      }, delay)
      visualTimers.push(timer)
    }
    return source
  }

  function capturePerformanceEvent(key: PadKey) {
    if (!isPerformanceRecording || !audioContext) return
    let at = audioContext.currentTime - performanceStart
    if (overdubRecordingId) {
      const recording = recordings.find((item) => item.id === overdubRecordingId)
      if (recording) at %= recording.duration
    }
    currentLayer.push({ key, at: Math.max(0, at) })
  }

  async function playPad(key: PadKey) {
    await ensureAudio()
    schedulePad(key)
    capturePerformanceEvent(key)
  }

  function resetSamplingUi() {
    const finishedKey = samplingKey
    samplingMode = 'off'
    samplingKey = null
    sampleModeButton.classList.remove('active', 'recording')
    restoreSampleButton.classList.remove('active')
    restoreSampleLabel.textContent = '원음 복구'
    restoreSampleDescription.textContent = '녹음한 샘플 취소하기'
    padButtons.forEach((button) => button.classList.remove('sampling-target'))
    if (finishedKey && !physicallyHeld.has(finishedKey)) setPadActive(finishedKey, false)
  }

  async function startMicrophoneSample(key: PadKey) {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setGuide('이 브라우저에서는 마이크 녹음을 사용할 수 없어요.', 'error')
      resetSamplingUi()
      return
    }
    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const preferredType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type))
      mediaRecorder = preferredType
        ? new MediaRecorder(microphoneStream, { mimeType: preferredType })
        : new MediaRecorder(microphoneStream)
      microphoneChunks = []
      discardMicrophoneRecording = false
      mediaRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) microphoneChunks.push(event.data)
      })
      mediaRecorder.addEventListener('stop', () => {
        if (discardMicrophoneRecording) {
          cleanupMicrophoneSample()
          setGuide('샘플링 녹음을 취소했습니다.', 'normal')
        } else {
          void finishMicrophoneSample(key)
        }
      }, { once: true })
      mediaRecorder.start()
      samplingMode = 'recording'
      samplingKey = key
      sampleModeButton.classList.add('recording')
      restoreSampleLabel.textContent = '녹음 취소'
      restoreSampleDescription.textContent = '현재 녹음을 저장하지 않기'
      padButtons.get(key)?.classList.add('sampling-target')
      setGuide(`${key.toUpperCase()} 패드 녹음 중 · 같은 키를 다시 누르면 완료`, 'recording')
    } catch {
      cleanupMicrophoneSample()
      setGuide('마이크 권한이 필요합니다. 브라우저 설정을 확인해주세요.', 'error')
    }
  }

  async function finishMicrophoneSample(key: PadKey) {
    try {
      const context = await ensureAudio()
      const blob = new Blob(microphoneChunks, { type: mediaRecorder?.mimeType || 'audio/webm' })
      const decoded = await context.decodeAudioData(await blob.arrayBuffer())
      buffers.set(key, decoded)
      sourceLabels.set(key, 'MIC REC')
      microphonePads.add(key)
      const label = host.querySelector<HTMLElement>(`[data-source="${key}"]`)
      if (label) label.textContent = 'MIC REC'
      setGuide(`${key.toUpperCase()} 패드에 새 샘플이 설정되었습니다.`, 'normal')
    } catch {
      setGuide('샘플을 처리하지 못했습니다. 다시 녹음해주세요.', 'error')
    } finally {
      cleanupMicrophoneSample()
    }
  }

  function cleanupMicrophoneSample() {
    microphoneStream?.getTracks().forEach((track) => track.stop())
    microphoneStream = null
    mediaRecorder = null
    microphoneChunks = []
    discardMicrophoneRecording = false
    resetSamplingUi()
  }

  function stopMicrophoneSample() {
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop()
  }

  function cancelMicrophoneSample() {
    if (mediaRecorder?.state !== 'recording') return
    discardMicrophoneRecording = true
    mediaRecorder.stop()
  }

  async function restoreOriginalSample(key: PadKey) {
    const context = await ensureAudio()
    microphonePads.delete(key)
    await tryLoadPublicSample(context, key)
    const original = originalBuffers.get(key)
    const originalLabel = originalLabels.get(key) ?? 'BUILT-IN'
    if (original) buffers.set(key, original)
    sourceLabels.set(key, originalLabel)
    const label = host.querySelector<HTMLElement>(`[data-source="${key}"]`)
    if (label) label.textContent = originalLabel
    resetSamplingUi()
    setGuide(`${key.toUpperCase()} 패드를 ${originalLabel === 'BUILT-IN' ? '내장 사운드' : `원본 ${originalLabel} 파일`}로 복구했습니다.`, 'normal')
  }

  async function handlePadDown(key: PadKey) {
    if (physicallyHeld.has(key)) return
    physicallyHeld.add(key)
    setPadActive(key, true)
    if (samplingMode === 'armed') {
      await startMicrophoneSample(key)
      return
    }
    if (samplingMode === 'recording') {
      if (samplingKey === key) stopMicrophoneSample()
      return
    }
    if (samplingMode === 'restore') {
      await restoreOriginalSample(key)
      return
    }
    await playPad(key)
  }

  function handlePadUp(key: PadKey) {
    cancelLongPress(key)
    physicallyHeld.delete(key)
    if (samplingKey !== key) setPadActive(key, false)
  }

  function stopLoop() {
    if (loopTimer !== null) window.clearInterval(loopTimer)
    loopTimer = null
    loopNodes.forEach((source) => {
      try { source.stop() } catch { /* source may already have ended */ }
    })
    loopNodes = new Set()
    visualTimers.forEach((timer) => window.clearTimeout(timer))
    visualTimers = []
    loopingRecordingIds.clear()
    nextCycleTimes.clear()
    playingAll = false
    renderRecordings()
  }

  function queueLoopCycles(recording: Recording) {
    if (!audioContext || !loopingRecordingIds.has(recording.id)) return
    let nextCycleTime = nextCycleTimes.get(recording.id)
    if (nextCycleTime === undefined) return
    while (nextCycleTime < audioContext.currentTime + 0.25) {
      const cycleStart = nextCycleTime
      recording.events.forEach((event) => {
        const source = schedulePad(event.key, cycleStart + event.at)
        if (source) {
          loopNodes.add(source)
          source.addEventListener('ended', () => loopNodes.delete(source), { once: true })
        }
      })
      nextCycleTime += recording.duration
    }
    nextCycleTimes.set(recording.id, nextCycleTime)
  }

  async function startPlayback(items: Recording[], all = false) {
    const context = await ensureAudio()
    stopLoop()
    const firstCycle = context.currentTime + 0.06
    playingAll = all
    items.forEach((recording) => {
      loopingRecordingIds.add(recording.id)
      nextCycleTimes.set(recording.id, firstCycle)
      queueLoopCycles(recording)
    })
    loopTimer = window.setInterval(() => items.forEach((recording) => queueLoopCycles(recording)), 80)
    renderRecordings()
    return firstCycle
  }

  async function startLoop(recording: Recording) {
    selectedRecordingId = recording.id
    return startPlayback([recording])
  }

  function toggleAllPlayback() {
    if (playingAll) stopLoop()
    else if (recordings.length) void startPlayback(recordings, true)
  }

  async function startPerformanceRecording() {
    const context = await ensureAudio()
    isPerformanceRecording = true
    currentLayer = []
    overdubRecordingId = selectedRecordingId
    const selected = recordings.find((item) => item.id === selectedRecordingId)
    performanceStart = selected ? await startLoop(selected) : context.currentTime
    performanceButton.classList.add('recording')
    performanceLabel.textContent = selected ? '레이어 녹음 중' : '녹음 중'
    audioState.innerHTML = '<i></i> RECORDING'
    renderRecordings()
  }

  function stopPerformanceRecording() {
    if (!audioContext) return
    const elapsed = Math.max(0.8, audioContext.currentTime - performanceStart)
    const selected = recordings.find((item) => item.id === overdubRecordingId)
    if (selected) {
      if (currentLayer.length) {
        selected.events.push(...currentLayer)
        selected.events.sort((a, b) => a.at - b.at)
        selected.layers += 1
      }
    } else {
      const recording: Recording = {
        id: crypto.randomUUID(),
        name: `TAKE ${String(recordings.length + 1).padStart(2, '0')}`,
        duration: elapsed,
        events: [...currentLayer],
        layers: 1,
      }
      recordings.unshift(recording)
      selectedRecordingId = recording.id
    }
    isPerformanceRecording = false
    overdubRecordingId = null
    currentLayer = []
    performanceButton.classList.remove('recording')
    performanceLabel.textContent = '녹음 시작'
    audioState.innerHTML = '<i></i> AUDIO ON'
    stopLoop()
    renderRecordings()
  }

  function togglePerformanceRecording() {
    if (samplingMode === 'recording') return
    if (isPerformanceRecording) stopPerformanceRecording()
    else void startPerformanceRecording()
  }

  function renderRecordings() {
    takeCount.textContent = `${recordings.length} ${recordings.length === 1 ? 'TAKE' : 'TAKES'}`
    playAllButton.disabled = recordings.length === 0
    playAllButton.classList.toggle('playing', playingAll)
    playAllLabel.textContent = playingAll ? '전체 중지' : '전체 재생'
    if (!isPerformanceRecording) performanceLabel.textContent = selectedRecordingId ? '레이어 추가' : '녹음 시작'
    if (!recordings.length) {
      recordingList.innerHTML = `<div class="empty-takes"><span>◌</span><strong>아직 녹음본이 없어요</strong><p>SPACE BAR를 눌러<br>첫 번째 루프를 만들어보세요.</p></div>`
      return
    }
    recordingList.innerHTML = recordings.map((recording) => `
      <article class="take-item ${recording.id === selectedRecordingId ? 'selected' : ''} ${loopingRecordingIds.has(recording.id) ? 'playing' : ''}" data-take="${recording.id}">
        <button class="take-select" type="button" aria-label="${recording.name} 선택">
          <span class="take-index">${String(recordings.indexOf(recording) + 1).padStart(2, '0')}</span>
          <span><b>${recording.name}</b><small>${recording.duration.toFixed(1)} SEC · ${recording.events.length} HITS · ${recording.layers} LAYER</small></span>
        </button>
        <button class="take-layer" type="button" aria-label="${recording.name}에 레이어 추가">＋<span>LAYER</span></button>
        <button class="take-play" type="button" aria-label="${recording.name} 반복재생 ${loopingRecordingIds.has(recording.id) ? '중지' : '시작'}"><i></i></button>
      </article>
    `).join('')

    recordingList.querySelectorAll<HTMLElement>('.take-item').forEach((item) => {
      const id = item.dataset.take!
      const recording = recordings.find((entry) => entry.id === id)!
      item.querySelector<HTMLButtonElement>('.take-select')!.addEventListener('click', () => {
        selectedRecordingId = id
        renderRecordings()
      })
      item.querySelector<HTMLButtonElement>('.take-play')!.addEventListener('click', () => {
        if (loopingRecordingIds.has(id)) stopLoop()
        else void startLoop(recording)
      })
      item.querySelector<HTMLButtonElement>('.take-layer')!.addEventListener('click', () => {
        if (isPerformanceRecording) return
        selectedRecordingId = id
        void startPerformanceRecording()
      })
    })
  }

  sampleModeButton.addEventListener('click', () => {
    if (samplingMode === 'recording') return
    samplingMode = samplingMode === 'armed' ? 'off' : 'armed'
    restoreSampleButton.classList.remove('active')
    sampleModeButton.classList.toggle('active', samplingMode === 'armed')
    setGuide(
      samplingMode === 'armed' ? '샘플을 지정할 키를 눌러주세요.' : '버튼을 누른 뒤 원하는 키를 선택하세요.',
      samplingMode === 'armed' ? 'armed' : 'normal',
    )
  })
  restoreSampleButton.addEventListener('click', () => {
    if (samplingMode === 'recording') {
      cancelMicrophoneSample()
      return
    }
    samplingMode = samplingMode === 'restore' ? 'off' : 'restore'
    sampleModeButton.classList.remove('active')
    restoreSampleButton.classList.toggle('active', samplingMode === 'restore')
    setGuide(
      samplingMode === 'restore' ? '원래 사운드로 되돌릴 키를 눌러주세요.' : '버튼을 누른 뒤 원하는 키를 선택하세요.',
      samplingMode === 'restore' ? 'armed' : 'normal',
    )
  })
  performanceButton.addEventListener('click', togglePerformanceRecording)
  playAllButton.addEventListener('click', toggleAllPlayback)
  newRecordingButton.addEventListener('click', () => {
    if (isPerformanceRecording) stopPerformanceRecording()
    stopLoop()
    selectedRecordingId = null
    renderRecordings()
  })

  padButtons.forEach((button, key) => {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      startLongPress(key)
      void handlePadDown(key)
    })
    const release = () => handlePadUp(key)
    button.addEventListener('pointerup', release)
    button.addEventListener('pointerleave', release)
    button.addEventListener('pointercancel', release)
  })

  editorButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const settings = padSettings.get(editorPad)!
      if (button.dataset.adjust === 'pitch-down') settings.pitch = Math.max(-12, settings.pitch - 1)
      if (button.dataset.adjust === 'pitch-up') settings.pitch = Math.min(12, settings.pitch + 1)
      if (button.dataset.adjust === 'speed-down') settings.speed = Math.max(0.1, Math.round((settings.speed - 0.1) * 10) / 10)
      if (button.dataset.adjust === 'speed-up') settings.speed = Math.min(2, Math.round((settings.speed + 0.1) * 10) / 10)
      updateEditor()
    })
  })

  window.addEventListener('keydown', (event) => {
    if (!isActive()) return
    if (event.key === 'Escape' && samplingMode !== 'off') {
      event.preventDefault()
      if (samplingMode === 'recording') cancelMicrophoneSample()
      else {
        resetSamplingUi()
        setGuide('샘플링 선택을 취소했습니다.', 'normal')
      }
      return
    }
    if (event.code === 'Space') {
      event.preventDefault()
      if (!event.repeat) togglePerformanceRecording()
      return
    }
    const key = PAD_CODES[event.code]
    if (key) {
      event.preventDefault()
      if (!event.repeat) {
        startLongPress(key)
        void handlePadDown(key)
      }
    }
  })
  window.addEventListener('keyup', (event) => {
    const key = PAD_CODES[event.code]
    if (key) handlePadUp(key)
  })
  window.addEventListener('blur', () => {
    physicallyHeld.forEach((key) => setPadActive(key, false))
    longPressTimers.forEach((timer) => window.clearTimeout(timer))
    longPressTimers.clear()
    physicallyHeld.clear()
  })

  const waveform = new Uint8Array(128)
  let scopeFrameId = 0
  function drawScope() {
    if (!isActive()) {
      scopeFrameId = 0
      return
    }
    const ratio = Math.min(window.devicePixelRatio, 2)
    const width = Math.max(1, Math.floor(scope.clientWidth * ratio))
    const height = Math.max(1, Math.floor(scope.clientHeight * ratio))
    if (scope.width !== width || scope.height !== height) {
      scope.width = width
      scope.height = height
    }
    scopeContext.clearRect(0, 0, width, height)
    scopeContext.strokeStyle = 'rgba(152, 255, 217, .65)'
    scopeContext.lineWidth = ratio
    scopeContext.beginPath()
    if (analyser) analyser.getByteTimeDomainData(waveform)
    for (let index = 0; index < waveform.length; index += 1) {
      const x = (index / (waveform.length - 1)) * width
      const idleWave = 128 + Math.sin(index * 0.24) * 2
      const y = ((analyser ? waveform[index] : idleWave) / 255) * height
      if (index === 0) scopeContext.moveTo(x, y)
      else scopeContext.lineTo(x, y)
    }
    scopeContext.stroke()
    scopeFrameId = requestAnimationFrame(drawScope)
  }

  function activate() {
    if (!scopeFrameId) scopeFrameId = requestAnimationFrame(drawScope)
  }

  renderRecordings()
  updateEditor()
  return {
    activate,
    deactivate() {
      window.cancelAnimationFrame(scopeFrameId)
      scopeFrameId = 0
      if (isPerformanceRecording) stopPerformanceRecording()
      else stopLoop()
      if (mediaRecorder?.state === 'recording') mediaRecorder.stop()
      physicallyHeld.forEach((key) => setPadActive(key, false))
      longPressTimers.forEach((timer) => window.clearTimeout(timer))
      longPressTimers.clear()
      physicallyHeld.clear()
    },
  }
}
