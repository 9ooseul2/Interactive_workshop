import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { setupCapture } from './capture.ts'
import { setupLemonade } from './lemonade.ts'
import { setupSampler } from './sampler.ts'
import { setupWaterTouch } from './waterTouch.ts'
import { setupBalloon } from './balloon.ts'
import { setupHbd } from './hbd.ts'
import { setupGoodNight } from './goodNight.ts'
import { setupRubberHuman } from './rubberHuman.ts'
import { setupShampoo } from './shampoo.ts'
import { setupCirce } from './circe.ts'
import { setupFrenchFries } from './frenchFries.ts'
import { setupWhoAreYou } from './whoAreYou.ts'
import './style.css'

type GameState = 'idle' | 'descending' | 'closing' | 'rising' | 'toExit' | 'releasing' | 'returning'
type Toy = THREE.Group & { userData: { radius: number; won: boolean; restY: number } }

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <main class="game-shell">
    <header class="topbar">
      <nav class="example-tabs" aria-label="예제 선택">
        <button class="example-tab active" type="button" data-example="claw" aria-label="인형뽑기" aria-current="page"><span>01</span></button>
        <button class="example-tab" type="button" data-example="sampler" aria-label="샘플러"><span>02</span></button>
        <button class="example-tab" type="button" data-example="lemonade" aria-label="Lemonade"><span>03</span></button>
        <button class="example-tab" type="button" data-example="waterTouch" aria-label="WaterTouch"><span>04</span></button>
        <button class="example-tab" type="button" data-example="balloon" aria-label="Balloon"><span>05</span></button>
        <button class="example-tab" type="button" data-example="hbd" aria-label="HBD"><span>06</span></button>
        <button class="example-tab" type="button" data-example="goodNight" aria-label="GoodNight"><span>07</span></button>
        <button class="example-tab" type="button" data-example="rubberHuman" aria-label="고무 인간"><span>08</span></button>
        <button class="example-tab" type="button" data-example="shampoo" aria-label="Shampoo"><span>09</span></button>
        <button class="example-tab" type="button" data-example="circe" aria-label="키르케2"><span>10</span></button>
        <button class="example-tab" type="button" data-example="frenchFries" aria-label="FrenchFries"><span>11</span></button>
        <button class="example-tab" type="button" data-example="whoAreYou" aria-label="WhoAreYou"><span>12</span></button>
      </nav>
    </header>

    <section class="game-stage" aria-label="3D 인형뽑기 게임">
      <div id="scene" class="scene"></div>
      <div class="rotate-hint" aria-hidden="true"><span>↔</span> 화면을 드래그해 360° 둘러보기</div>
      <div class="stage-title" aria-hidden="true"><span>LUCK IS</span><strong>IN THE AIR</strong></div>

      <div class="instructions glass-panel">
        <p class="eyebrow">HOW TO PLAY</p>
        <h1>행운을<br><em>잡아보세요!</em></h1>
        <ol>
          <li><span>01</span><p><b>방향키</b>로 집게를<br>원하는 위치로 이동</p></li>
          <li><span>02</span><p><b>SPACE BAR</b>를 눌러<br>집게 내리기</p></li>
          <li><span>03</span><p>집게가 움직이는 동안<br>잠시 기다려주세요</p></li>
        </ol>
      </div>

      <div class="game-hud glass-panel">
        <div class="hud-state"><span id="state-dot" class="state-dot"></span><div><small>CLAW STATUS</small><strong id="status" aria-live="polite">준비 완료</strong></div></div>
        <div class="hud-count"><div><small>MY PRIZE</small><span>오늘의 행운</span></div><strong><span id="score">0</span><i>개</i></strong></div>
      </div>

      <div class="controls" aria-label="집게 조작부">
        <div class="direction-pad" id="direction-pad">
          <button class="dir up" data-key="ArrowUp" aria-label="집게 앞으로 이동"><span>앞</span><kbd>↑</kbd></button>
          <button class="dir left" data-key="ArrowLeft" aria-label="집게 왼쪽으로 이동"><span>좌</span><kbd>←</kbd></button>
          <div class="pad-center"><span></span></div>
          <button class="dir right" data-key="ArrowRight" aria-label="집게 오른쪽으로 이동"><span>우</span><kbd>→</kbd></button>
          <button class="dir down" data-key="ArrowDown" aria-label="집게 뒤로 이동"><span>뒤</span><kbd>↓</kbd></button>
        </div>
        <button id="grab-button" class="grab-button" aria-label="집게 내리기">
          <span class="button-glow"></span><span class="space-label">PRESS TO GRAB</span><strong>SPACE</strong><small>집게 내리기</small>
        </button>
      </div>

      <div class="lock-notice" id="lock-notice"><span class="spinner"></span><p><b>AUTO PLAY</b><br>집게가 자동으로 움직이고 있어요</p></div>
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
      <div class="prize-reveal" id="prize-reveal" aria-live="polite">
        <div class="reveal-ring"></div>
        <p>YOU GOT IT!</p>
        <strong>새로운 인형을 뽑았어요</strong>
      </div>
      <div class="floor-label" aria-hidden="true">CLAW CLUB ORIGINAL · 2026</div>
    </section>
    <section id="sampler-screen" class="sampler-screen" aria-label="키보드 샘플러"></section>
    <section id="lemonade-screen" class="lemonade-screen" aria-label="Lemonade 손 추적 게임"></section>
    <section id="water-touch-screen" class="water-touch-screen" aria-label="WaterTouch 손 추적 게임"></section>
    <section id="balloon-screen" class="balloon-screen" aria-label="Balloon 손 추적 게임"></section>
    <section id="hbd-screen" class="hbd-screen" aria-label="HBD 생일 촛불 인터랙션"></section>
    <section id="goodnight-screen" class="goodnight-screen" aria-label="GoodNight 잠자리 인터랙션"></section>
    <section id="rubber-human-screen" class="rubber-human-screen" aria-label="고무 인간 얼굴 늘리기 인터랙션"></section>
    <section id="shampoo-screen" class="shampoo-screen" aria-label="Shampoo 거품 놀이"></section>
    <section id="circe-screen" class="circe-screen" aria-label="키르케2 음식 핀치 인터랙션"></section>
    <section id="french-fries-screen" class="french-fries-screen" aria-label="FrenchFries 웹캠 AR 인터랙션"></section>
    <section id="who-are-you-screen" class="who-are-you-screen" aria-label="WhoAreYou 노크 외시경 인터랙션"></section>
  </main>
`

const sceneHost = document.querySelector<HTMLDivElement>('#scene')!
const statusEl = document.querySelector<HTMLElement>('#status')!
const stateDot = document.querySelector<HTMLElement>('#state-dot')!
const scoreEl = document.querySelector<HTMLElement>('#score')!
const grabButton = document.querySelector<HTMLButtonElement>('#grab-button')!
const lockNotice = document.querySelector<HTMLElement>('#lock-notice')!
const toast = document.querySelector<HTMLElement>('#toast')!
const prizeRevealEl = document.querySelector<HTMLElement>('#prize-reveal')!
const directionButtons = [...document.querySelectorAll<HTMLButtonElement>('.dir')]
const gameStage = document.querySelector<HTMLElement>('.game-stage')!
const samplerScreen = document.querySelector<HTMLElement>('#sampler-screen')!
const lemonadeScreen = document.querySelector<HTMLElement>('#lemonade-screen')!
const waterTouchScreen = document.querySelector<HTMLElement>('#water-touch-screen')!
const balloonScreen = document.querySelector<HTMLElement>('#balloon-screen')!
const hbdScreen = document.querySelector<HTMLElement>('#hbd-screen')!
const goodNightScreen = document.querySelector<HTMLElement>('#goodnight-screen')!
const rubberHumanScreen = document.querySelector<HTMLElement>('#rubber-human-screen')!
const shampooScreen = document.querySelector<HTMLElement>('#shampoo-screen')!
const circeScreen = document.querySelector<HTMLElement>('#circe-screen')!
const frenchFriesScreen = document.querySelector<HTMLElement>('#french-fries-screen')!
const whoAreYouScreen = document.querySelector<HTMLElement>('#who-are-you-screen')!
const exampleTabs = [...document.querySelectorAll<HTMLButtonElement>('.example-tab')]
type ExampleName = 'claw' | 'sampler' | 'lemonade' | 'waterTouch' | 'balloon' | 'hbd' | 'goodNight' | 'rubberHuman' | 'shampoo' | 'circe' | 'frenchFries' | 'whoAreYou'
let activeExample: ExampleName = 'claw'

const samplerController = setupSampler(samplerScreen, () => activeExample === 'sampler')
const lemonadeController = setupLemonade(lemonadeScreen, () => activeExample === 'lemonade')
const waterTouchController = setupWaterTouch(waterTouchScreen, () => activeExample === 'waterTouch')
const balloonController = setupBalloon(balloonScreen, () => activeExample === 'balloon')
const hbdController = setupHbd(hbdScreen, () => activeExample === 'hbd')
const goodNightController = setupGoodNight(goodNightScreen, () => activeExample === 'goodNight')
const rubberHumanController = setupRubberHuman(rubberHumanScreen, () => activeExample === 'rubberHuman')
const shampooController = setupShampoo(shampooScreen, () => activeExample === 'shampoo')
const circeController = setupCirce(circeScreen, () => activeExample === 'circe')
const frenchFriesController = setupFrenchFries(frenchFriesScreen, () => activeExample === 'frenchFries')
const whoAreYouController = setupWhoAreYou(whoAreYouScreen, () => activeExample === 'whoAreYou')
if (import.meta.hot) import.meta.hot.dispose(() => shampooController.dispose())
setupCapture()

exampleTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const next = tab.dataset.example as ExampleName
    activeExample = next
    gameStage.classList.toggle('example-hidden', next !== 'claw')
    samplerScreen.classList.toggle('active', next === 'sampler')
    lemonadeScreen.classList.toggle('active', next === 'lemonade')
    waterTouchScreen.classList.toggle('active', next === 'waterTouch')
    balloonScreen.classList.toggle('active', next === 'balloon')
    hbdScreen.classList.toggle('active', next === 'hbd')
    goodNightScreen.classList.toggle('active', next === 'goodNight')
    rubberHumanScreen.classList.toggle('active', next === 'rubberHuman')
    shampooScreen.classList.toggle('active', next === 'shampoo')
    circeScreen.classList.toggle('active', next === 'circe')
    frenchFriesScreen.classList.toggle('active', next === 'frenchFries')
    whoAreYouScreen.classList.toggle('active', next === 'whoAreYou')
    document.body.classList.toggle('sampler-active', next === 'sampler')
    document.body.classList.toggle('hbd-active', next === 'hbd')
    document.body.classList.toggle('goodnight-active', next === 'goodNight')
    exampleTabs.forEach((item) => {
      const selected = item === tab
      item.classList.toggle('active', selected)
      if (selected) item.setAttribute('aria-current', 'page')
      else item.removeAttribute('aria-current')
    })
    const titles: Record<ExampleName, string> = {
      claw: 'Claw Club — 3D 인형뽑기',
      sampler: 'Claw Club — 키보드 샘플러',
      lemonade: 'Claw Club — Lemonade',
      waterTouch: 'Claw Club — WaterTouch',
      balloon: 'Claw Club — Balloon',
      hbd: 'HBD — Make a Wish',
      goodNight: 'GoodNight — Interactive Sleep',
      rubberHuman: '고무 인간 — Rubber Human',
      shampoo: 'Shampoo — A Little Foam',
      circe: '키르케2 — The Feast of Circe',
      frenchFries: 'FrenchFries — Pinch, Bite, Whiskers',
      whoAreYou: 'WhoAreYou — Knock, Then Look',
    }
    document.title = titles[next]
    heldKeys.clear()
    if (next === 'sampler') samplerController.activate()
    else samplerController.deactivate()
    if (next === 'lemonade') void lemonadeController.activate()
    else lemonadeController.deactivate()
    if (next === 'waterTouch') void waterTouchController.activate()
    else waterTouchController.deactivate()
    if (next === 'balloon') void balloonController.activate()
    else balloonController.deactivate()
    if (next === 'hbd') void hbdController.activate()
    else hbdController.deactivate()
    if (next === 'goodNight') void goodNightController.activate()
    else goodNightController.deactivate()
    if (next === 'rubberHuman') void rubberHumanController.activate()
    else rubberHumanController.deactivate()
    if (next === 'shampoo') void shampooController.activate()
    else shampooController.deactivate()
    if (next === 'circe') void circeController.activate()
    else circeController.deactivate()
    if (next === 'frenchFries') void frenchFriesController.activate()
    else frenchFriesController.deactivate()
    if (next === 'whoAreYou') void whoAreYouController.activate()
    else whoAreYouController.deactivate()
    if (next === 'claw') resumeClawLoop()
    else pauseClawLoop()
    if (next === 'claw') {
      resize()
    }
  })
})

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0d1715)
scene.fog = new THREE.Fog(0x0d1715, 16, 28)

const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)
camera.position.set(0, 3.15, 17.8)
camera.lookAt(0, 2.25, 0)
scene.add(camera)

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.12
sceneHost.append(renderer.domElement)

const orbit = new OrbitControls(camera, renderer.domElement)
orbit.target.set(0, 2.2, 0)
orbit.enableDamping = true
orbit.dampingFactor = 0.075
orbit.enablePan = false
orbit.minDistance = 13.5
orbit.maxDistance = 21
orbit.minPolarAngle = Math.PI * 0.24
orbit.maxPolarAngle = Math.PI * 0.56
orbit.rotateSpeed = 0.65
orbit.zoomSpeed = 0.7

scene.add(new THREE.HemisphereLight(0xd9fff4, 0x12201c, 2.2))
const keyLight = new THREE.DirectionalLight(0xfff1d8, 4.5)
keyLight.position.set(5, 10, 7)
keyLight.castShadow = true
keyLight.shadow.mapSize.set(1024, 1024)
keyLight.shadow.camera.left = -8
keyLight.shadow.camera.right = 8
keyLight.shadow.camera.top = 9
keyLight.shadow.camera.bottom = -3
scene.add(keyLight)
const mintLight = new THREE.PointLight(0x62ffca, 15, 11, 2)
mintLight.position.set(-3.5, 5.5, 2.5)
scene.add(mintLight)
const amberLight = new THREE.PointLight(0xffad5c, 9, 8, 2)
amberLight.position.set(3.8, 2.2, 3.5)
scene.add(amberLight)

const machine = new THREE.Group()
scene.add(machine)

const cream = new THREE.MeshStandardMaterial({ color: 0xe7ddca, roughness: 0.42, metalness: 0.25 })
const dark = new THREE.MeshStandardMaterial({ color: 0x18211e, roughness: 0.7, metalness: 0.25 })
const black = new THREE.MeshStandardMaterial({ color: 0x0a0d0c, roughness: 0.35, metalness: 0.75 })
const mint = new THREE.MeshStandardMaterial({ color: 0x8dffd5, emissive: 0x246b55, emissiveIntensity: 1.25 })
const glass = new THREE.MeshPhysicalMaterial({ color: 0xd9fff7, transparent: true, opacity: 0.11, roughness: 0.08, transmission: 0.65, depthWrite: false })

function box(size: [number, number, number], position: [number, number, number], material: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material)
  mesh.position.set(...position)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

// Full lower cabinet, glass showcase and illuminated frame.
machine.add(box([7.8, 2.5, 5.9], [0, -0.86, 0], dark))
machine.add(box([7.8, 0.16, 5.9], [0, 0.42, 0], cream))
machine.add(box([7.8, 0.18, 5.9], [0, -2.14, 0], cream))

// The front is assembled around a real center opening instead of covering it.
machine.add(box([2.85, 2.25, 0.38], [-2.48, -0.87, 2.94], cream))
machine.add(box([2.85, 2.25, 0.38], [2.48, -0.87, 2.94], cream))
machine.add(box([2.12, 0.48, 0.38], [0, 0.015, 2.94], cream))
machine.add(box([2.12, 0.42, 0.38], [0, -1.79, 2.94], cream))
machine.add(box([1.9, 1.25, 0.18], [0, -0.94, 3.04], black))

const hatchFloor = box([1.75, 0.12, 1.25], [0, -1.56, 3.38], dark)
hatchFloor.rotation.x = -0.08
machine.add(hatchFloor)
machine.add(box([0.12, 1.24, 1.1], [-0.9, -0.96, 3.34], cream))
machine.add(box([0.12, 1.24, 1.1], [0.9, -0.96, 3.34], cream))
const posts: [number, number, number][] = [[-3.72, 3.5, -2.72], [3.72, 3.5, -2.72], [-3.72, 3.5, 2.72], [3.72, 3.5, 2.72]]
posts.forEach((position) => machine.add(box([0.24, 6.35, 0.24], position, cream)))
machine.add(box([7.72, 0.34, 0.34], [0, 6.7, 2.72], cream))
machine.add(box([7.72, 0.34, 0.34], [0, 6.7, -2.72], cream))
machine.add(box([0.34, 0.34, 5.5], [-3.72, 6.7, 0], cream))
machine.add(box([0.34, 0.34, 5.5], [3.72, 6.7, 0], cream))
machine.add(box([7.2, 5.95, 0.04], [0, 3.55, -2.77], glass))
machine.add(box([0.04, 5.95, 5.25], [-3.77, 3.55, 0], glass))
machine.add(box([0.04, 5.95, 5.25], [3.77, 3.55, 0], glass))
machine.add(box([7.35, 0.055, 0.08], [0, 6.42, 2.61], mint))
machine.add(box([0.08, 5.75, 0.06], [-3.55, 3.5, 2.61], mint))
machine.add(box([0.08, 5.75, 0.06], [3.55, 3.5, 2.61], mint))

const chute = new THREE.Group()
chute.position.set(0, 0.48, 1.95)
chute.add(box([1.55, 0.12, 1.25], [0, 0, 0], black))
chute.add(box([1.68, 0.045, 1.36], [0, 0.04, 0], mint))
machine.add(chute)
machine.add(box([6.8, 0.1, 0.13], [0, 6.22, -1.9], black))
machine.add(box([6.8, 0.1, 0.13], [0, 6.22, 1.9], black))

type PlushKind = 'bear' | 'bunny' | 'cat'
type PlushPose = [x: number, y: number, z: number, rx: number, ry: number, rz: number, scale: number]

function createPlush(kind: PlushKind, color: number, accent: number, pose: PlushPose): Toy {
  const toy = new THREE.Group() as Toy
  const fur = new THREE.MeshStandardMaterial({ color, roughness: 0.94 })
  const accentMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.94 })
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x161a18, roughness: 0.5 })
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.44, 0.55, 8, 18), fur)
  body.position.y = 0.72
  body.castShadow = true
  toy.add(body)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.51, 24, 20), fur)
  head.position.set(0, 1.43, 0.03)
  head.scale.set(1, 0.92, 0.9)
  head.castShadow = true
  toy.add(head)
  for (const side of [-1, 1]) {
    let ear: THREE.Mesh
    if (kind === 'bunny') {
      ear = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.43, 7, 12), fur)
      ear.position.set(side * 0.27, 1.98, 0)
      ear.rotation.z = side * -0.13
    } else if (kind === 'cat') {
      ear = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.46, 4), fur)
      ear.position.set(side * 0.34, 1.78, 0)
      ear.rotation.y = Math.PI / 4
    } else {
      ear = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), fur)
      ear.position.set(side * 0.39, 1.75, 0)
    }
    ear.castShadow = true
    toy.add(ear)
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), eyeMat)
    eye.position.set(side * 0.17, 1.5, 0.45)
    toy.add(eye)
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.36, 6, 12), fur)
    arm.position.set(side * 0.5, 0.84, 0)
    arm.rotation.z = side * -0.42
    arm.castShadow = true
    toy.add(arm)
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 12), fur)
    foot.position.set(side * 0.27, 0.18, 0.18)
    foot.scale.set(1, 0.75, 1.25)
    foot.castShadow = true
    toy.add(foot)
  }
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), accentMat)
  muzzle.position.set(0, 1.34, 0.46)
  muzzle.scale.set(1.1, 0.76, 0.55)
  toy.add(muzzle)
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), eyeMat)
  nose.position.set(0, 1.41, 0.57)
  nose.scale.set(1.2, 0.8, 0.65)
  toy.add(nose)
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.3, 18, 14), accentMat)
  belly.position.set(0, 0.72, 0.35)
  belly.scale.set(0.9, 1.2, 0.35)
  toy.add(belly)
  if (kind === 'cat') {
    const tail = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.07, 8, 18, Math.PI * 1.25), fur)
    tail.position.set(-0.38, 0.63, -0.18)
    tail.rotation.set(Math.PI / 2, 0, 0.35)
    toy.add(tail)
  }

  const [x, y, z, rx, ry, rz, size] = pose
  toy.position.set(x, y, z)
  toy.rotation.set(rx, ry, rz)
  toy.scale.setScalar(size)
  toy.userData = { radius: 0.62 * size, won: false, restY: y }
  return toy
}

const toys: Toy[] = [
  createPlush('bear', 0xf2b4a0, 0xffe1cf, [-2.75, .58, -2.05, .1, .35, -.18, .83]),
  createPlush('bunny', 0xaedac8, 0xe5fff2, [-1.55, .77, -2.12, .66, -.25, -.28, .72]),
  createPlush('cat', 0xe9ca69, 0xffedb2, [-.25, .6, -2.05, .12, .2, .15, .91]),
  createPlush('bear', 0xc1b6e7, 0xeee9ff, [1.2, .82, -2.0, .74, -.45, .25, .76]),
  createPlush('bunny', 0xec8fa9, 0xffd8e1, [2.65, .62, -1.98, -.12, .7, -.15, .88]),

  createPlush('cat', 0x93b8d8, 0xe5f1ff, [-3.0, .82, -1.0, -.55, .5, .6, .74]),
  createPlush('bear', 0xe9aa72, 0xffd6ad, [-1.9, .59, -.85, .05, -.1, .2, 1.02]),
  createPlush('bunny', 0x9fcf9d, 0xe8f6ca, [-.55, .9, -.95, .82, 1.1, -.2, .68]),
  createPlush('cat', 0xe7a4bf, 0xffdfeb, [.65, .61, -.95, -.08, -.6, -.2, .94]),
  createPlush('bear', 0xb8a27e, 0xead9bd, [2.0, .81, -.86, -.68, .32, -.35, .78]),
  createPlush('bunny', 0x91c9bc, 0xdcfff3, [3.05, .6, -.75, .08, -.7, .18, .82]),

  createPlush('bear', 0xd99d87, 0xffded0, [-2.65, .63, .25, -.08, -.5, .16, .96]),
  createPlush('cat', 0xb0a5dc, 0xeae5ff, [-1.35, .86, .08, .72, .9, .3, .7]),
  createPlush('bunny', 0xedcf6f, 0xffefaf, [-.15, .62, .2, .1, -.2, -.15, .9]),
  createPlush('bear', 0xa5c9e4, 0xe2f3ff, [1.25, .9, .15, -.82, .7, .2, .72]),
  createPlush('cat', 0xe18aa5, 0xffd9e4, [2.55, .61, .35, .06, -.6, -.18, .92]),

  createPlush('bunny', 0xd8b88a, 0xffe6bd, [-3.0, .84, 1.25, .62, .25, -.45, .7]),
  createPlush('cat', 0x94c9a6, 0xdfffe7, [-1.75, .62, 1.28, -.12, -.9, .18, .88]),
  createPlush('bear', 0xe49b7d, 0xffd7c4, [-.55, .84, 1.22, -.68, .4, .38, .74]),
  createPlush('bunny', 0x9aaada, 0xe0e6ff, [.8, .63, 1.08, .05, .8, -.2, .84]),
  createPlush('cat', 0xe1bd67, 0xffe9a8, [2.15, .84, 1.22, .75, -.4, -.25, .7]),
  createPlush('bear', 0xc998ad, 0xf4d7df, [3.05, .62, 1.15, -.04, .45, .14, .79]),
]
toys.forEach((toy) => machine.add(toy))

const claw = new THREE.Group()
machine.add(claw)
claw.add(box([1.22, 0.26, 0.92], [0, 6.18, 0], black))
claw.add(box([0.62, 0.07, 0.95], [0, 6.02, 0], mint))
const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 3, 10), black)
claw.add(cable)
const clawHead = new THREE.Group()
claw.add(clawHead)
const hub = new THREE.Mesh(new THREE.SphereGeometry(0.32, 20, 16), cream)
hub.scale.y = 0.72
hub.castShadow = true
clawHead.add(hub)
const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.25, 0.34, 16), black)
collar.position.y = 0.25
clawHead.add(collar)
type ClawFinger = {
  root: THREE.Group
  upper: THREE.Mesh
  lower: THREE.Mesh
  knuckle: THREE.Mesh
  tip: THREE.Mesh
}

const fingers: ClawFinger[] = []
const linkGeometry = new THREE.CylinderGeometry(0.065, 0.082, 1, 14)
const jointGeometry = new THREE.SphereGeometry(0.105, 14, 10)
for (let index = 0; index < 3; index += 1) {
  const root = new THREE.Group()
  root.rotation.y = (Math.PI * 2 * index) / 3
  const upper = new THREE.Mesh(linkGeometry, cream)
  upper.castShadow = true
  root.add(upper)
  const lower = new THREE.Mesh(linkGeometry, cream)
  lower.castShadow = true
  root.add(lower)
  const knuckle = new THREE.Mesh(jointGeometry, black)
  root.add(knuckle)
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.095, 14, 10), cream)
  tip.scale.set(1, 1.35, 1)
  tip.castShadow = true
  root.add(tip)
  clawHead.add(root)
  fingers.push({ root, upper, lower, knuckle, tip })
}

const HOME_HEIGHT = 5.92
const LOW_HEIGHT = 2.55
const EXIT_POSITION = new THREE.Vector2(0, 1.95)
let clawHeight = HOME_HEIGHT
let clawOpen = 1

const yAxis = new THREE.Vector3(0, 1, 0)
const linkDirection = new THREE.Vector3()
function placeLink(mesh: THREE.Mesh, start: THREE.Vector3, end: THREE.Vector3) {
  linkDirection.subVectors(end, start)
  const length = linkDirection.length()
  mesh.position.copy(start).add(end).multiplyScalar(0.5)
  mesh.quaternion.setFromUnitVectors(yAxis, linkDirection.normalize())
  mesh.scale.set(1, length, 1)
}

function updateClawGeometry() {
  clawHead.position.y = clawHeight
  const cableLength = 6.04 - clawHeight
  cable.scale.y = Math.max(cableLength, 0.08)
  cable.position.y = clawHeight + cableLength / 2
  const shoulder = new THREE.Vector3(0.24, -0.08, 0)
  const elbow = new THREE.Vector3(
    THREE.MathUtils.lerp(0.43, 0.82, clawOpen),
    THREE.MathUtils.lerp(-0.63, -0.5, clawOpen),
    0,
  )
  const tipPosition = new THREE.Vector3(
    THREE.MathUtils.lerp(0.17, 0.92, clawOpen),
    THREE.MathUtils.lerp(-1.18, -1.13, clawOpen),
    0,
  )
  fingers.forEach(({ upper, lower, knuckle, tip }) => {
    placeLink(upper, shoulder, elbow)
    placeLink(lower, elbow, tipPosition)
    knuckle.position.copy(elbow)
    tip.position.copy(tipPosition)
  })
}
updateClawGeometry()

const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x8dffd5, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
const marker = new THREE.Mesh(new THREE.RingGeometry(0.33, 0.48, 32), markerMaterial)
marker.rotation.x = -Math.PI / 2
marker.position.y = 0.51
machine.add(marker)

let gameState: GameState = 'idle'
let stateStarted = performance.now()
let transitionStart = new THREE.Vector3()
let targetToy: Toy | null = null
let heldToy: Toy | null = null
let fallingToy: Toy | null = null
let fallingVelocity = 0
let unstableDropAt = 2
let prizeToy: Toy | null = null
let prizeDelivered = false
let revealToy: THREE.Group | null = null
let score = 0
const heldKeys = new Set<string>()
const stateCopy: Record<GameState, string> = {
  idle: '준비 완료', descending: '집게 내리는 중', closing: '인형 잡는 중', rising: '집게 올리는 중',
  toExit: '출구로 이동 중', releasing: '결과 확인 중', returning: '처음 위치로 복귀 중',
}

function setState(next: GameState, now = performance.now()) {
  gameState = next
  stateStarted = now
  statusEl.textContent = stateCopy[next]
  const locked = next !== 'idle'
  document.body.classList.toggle('is-locked', locked)
  stateDot.classList.toggle('busy', locked)
  lockNotice.classList.toggle('visible', locked)
  grabButton.disabled = locked
  directionButtons.forEach((button) => { button.disabled = locked })
  if (locked) heldKeys.clear()
}

function easeInOut(value: number) {
  return value < 0.5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2
}

function nearestToy() {
  let nearest: Toy | null = null
  let nearestDistance = Infinity
  for (const toy of toys) {
    if (toy.userData.won || toy === fallingToy) continue
    const distance = Math.hypot(toy.position.x - claw.position.x, toy.position.z - claw.position.z)
    if (distance < nearestDistance) { nearest = toy; nearestDistance = distance }
  }
  return { toy: nearest, distance: nearestDistance }
}

function showToast(message: string, success = false) {
  toast.textContent = message
  toast.classList.toggle('success', success)
  toast.classList.add('visible')
  window.setTimeout(() => toast.classList.remove('visible'), 2200)
}

function showPrizeReveal(toy: Toy) {
  if (revealToy) camera.remove(revealToy)
  revealToy = toy.clone(true)
  const originalScale = Math.max(toy.userData.radius / 0.62, 0.1)
  revealToy.position.set(0, -1.05, -5.2)
  revealToy.rotation.set(0, 0, 0)
  revealToy.scale.setScalar(1.05 / originalScale)
  camera.add(revealToy)
  prizeRevealEl.classList.add('visible')

  window.setTimeout(() => {
    if (revealToy) camera.remove(revealToy)
    revealToy = null
    prizeRevealEl.classList.remove('visible')
  }, 2000)
}

function startGrab() {
  if (gameState !== 'idle') return
  const nearest = nearestToy()
  targetToy = nearest.distance < 1.08 ? nearest.toy : null
  transitionStart.set(claw.position.x, clawHeight, claw.position.z)
  unstableDropAt = 2
  prizeToy = null
  prizeDelivered = false
  setState('descending')
}

function attachCandidate() {
  if (!targetToy) return
  const distance = Math.hypot(targetToy.position.x - claw.position.x, targetToy.position.z - claw.position.z)
  const grabChance = THREE.MathUtils.clamp(0.91 - distance * 0.48, 0.36, 0.88)
  if (Math.random() < grabChance) {
    heldToy = targetToy
    fallingToy = null
    const stableChance = THREE.MathUtils.clamp(0.82 - distance * 0.52, 0.2, 0.78)
    if (Math.random() > stableChance) unstableDropAt = THREE.MathUtils.randFloat(0.28, 0.76)
  }
}

function dropHeldToy() {
  if (!heldToy) return
  fallingToy = heldToy
  heldToy = null
  fallingVelocity = 0.2
  fallingToy.rotation.x = THREE.MathUtils.randFloat(-0.2, 0.2)
  showToast('앗, 인형이 미끄러졌어요!')
}

function deliverPrize(now: number) {
  if (!prizeToy || prizeDelivered) return
  const elapsed = (now - stateStarted) / 1000
  if (elapsed < 0.78) {
    const fallProgress = Math.max(0, Math.min((elapsed - 0.25) / 0.53, 1))
    prizeToy.position.set(0, THREE.MathUtils.lerp(clawHeight - 1.78, 0.12, easeInOut(fallProgress)), 1.95)
    prizeToy.rotation.x += 0.035
  } else if (elapsed < 1.15) {
    const hatchProgress = (elapsed - 0.78) / 0.37
    prizeToy.position.set(0, THREE.MathUtils.lerp(-0.48, -1.28, easeInOut(hatchProgress)), 3.22)
    prizeToy.rotation.z += 0.045
  } else {
    prizeDelivered = true
    showPrizeReveal(prizeToy)
    prizeToy.visible = false
    score += 1
    scoreEl.textContent = String(score)
    showToast('축하해요! 인형을 뽑았어요 ✦', true)
  }
}

function updateState(now: number) {
  const elapsed = (now - stateStarted) / 1000
  if (gameState === 'descending') {
    const progress = Math.min(elapsed / 1.45, 1)
    clawHeight = THREE.MathUtils.lerp(HOME_HEIGHT, LOW_HEIGHT, easeInOut(progress))
    if (progress >= 1) setState('closing', now)
  } else if (gameState === 'closing') {
    const progress = Math.min(elapsed / 0.85, 1)
    clawOpen = 1 - easeInOut(progress)
    if (progress >= 1) { attachCandidate(); setState('rising', now) }
  } else if (gameState === 'rising') {
    const progress = Math.min(elapsed / 1.55, 1)
    clawHeight = THREE.MathUtils.lerp(LOW_HEIGHT, HOME_HEIGHT, easeInOut(progress))
    if (heldToy) {
      heldToy.position.set(claw.position.x, clawHeight - 1.78, claw.position.z)
      heldToy.rotation.y += 0.018
      heldToy.rotation.z = Math.sin(elapsed * 7) * 0.08
      if (progress > unstableDropAt) dropHeldToy()
    }
    if (progress >= 1) { transitionStart.set(claw.position.x, clawHeight, claw.position.z); setState('toExit', now) }
  } else if (gameState === 'toExit') {
    const progress = Math.min(elapsed / 1.65, 1)
    const eased = easeInOut(progress)
    claw.position.x = THREE.MathUtils.lerp(transitionStart.x, EXIT_POSITION.x, eased)
    claw.position.z = THREE.MathUtils.lerp(transitionStart.z, EXIT_POSITION.y, eased)
    if (heldToy) {
      heldToy.position.set(claw.position.x, clawHeight - 1.78, claw.position.z)
      heldToy.rotation.z = Math.sin(elapsed * 6) * 0.06
    }
    if (progress >= 1) setState('releasing', now)
  } else if (gameState === 'releasing') {
    clawOpen = easeInOut(Math.min(elapsed / 0.7, 1))
    if (heldToy && elapsed > 0.24) {
      prizeToy = heldToy
      prizeToy.userData.won = true
      heldToy = null
    }
    deliverPrize(now)
    if (elapsed >= 1.75) {
      if (!prizeToy) showToast(targetToy ? '조금만 더 정확히 노려보세요!' : '인형 가까이에서 내려보세요!')
      transitionStart.set(claw.position.x, clawHeight, claw.position.z)
      setState('returning', now)
    }
  } else if (gameState === 'returning') {
    const progress = Math.min(elapsed / 1.45, 1)
    const eased = easeInOut(progress)
    claw.position.x = THREE.MathUtils.lerp(transitionStart.x, 0, eased)
    claw.position.z = THREE.MathUtils.lerp(transitionStart.z, 0, eased)
    if (progress >= 1) { targetToy = null; setState('idle', now) }
  }
}

function updateLooseToy(delta: number) {
  if (!fallingToy) return
  fallingVelocity -= 6.4 * delta
  fallingToy.position.y += fallingVelocity * delta
  fallingToy.rotation.x += delta * 1.8
  fallingToy.rotation.z += delta * 1.1
  if (fallingToy.position.y <= fallingToy.userData.restY) {
    fallingToy.userData.restY = THREE.MathUtils.randFloat(0.56, 0.72)
    fallingToy.position.y = fallingToy.userData.restY
    fallingToy.rotation.x = THREE.MathUtils.randFloat(-0.45, 0.45)
    fallingToy.rotation.z = THREE.MathUtils.randFloat(-0.35, 0.35)
    fallingToy = null
  }
}

function updateMovement(delta: number) {
  if (gameState !== 'idle') return
  let x = Number(heldKeys.has('ArrowRight')) - Number(heldKeys.has('ArrowLeft'))
  let z = Number(heldKeys.has('ArrowUp')) - Number(heldKeys.has('ArrowDown'))
  if (x && z) { x *= Math.SQRT1_2; z *= Math.SQRT1_2 }
  claw.position.x = THREE.MathUtils.clamp(claw.position.x + x * 2.35 * delta, -3, 3)
  claw.position.z = THREE.MathUtils.clamp(claw.position.z + z * 2.35 * delta, -2.05, 1.85)
}

window.addEventListener('keydown', (event) => {
  if (activeExample !== 'claw') return
  if (event.code === 'Space' || event.key.startsWith('Arrow')) event.preventDefault()
  if (event.code === 'Space') { if (!event.repeat) startGrab(); return }
  if (event.key.startsWith('Arrow') && gameState === 'idle') heldKeys.add(event.key)
})
window.addEventListener('keyup', (event) => {
  if (activeExample === 'claw') heldKeys.delete(event.key)
})
window.addEventListener('blur', () => heldKeys.clear())
grabButton.addEventListener('click', startGrab)
directionButtons.forEach((button) => {
  const key = button.dataset.key!
  const start = (event: Event) => { event.preventDefault(); if (gameState === 'idle') heldKeys.add(key) }
  const stop = () => heldKeys.delete(key)
  button.addEventListener('pointerdown', start)
  button.addEventListener('pointerup', stop)
  button.addEventListener('pointerleave', stop)
  button.addEventListener('pointercancel', stop)
})

function resize() {
  const width = sceneHost.clientWidth
  const height = sceneHost.clientHeight
  renderer.setSize(width, height, false)
  camera.aspect = width / Math.max(height, 1)
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)
resize()

const clock = new THREE.Clock()
let clawFrameId = 0
let clawLoopActive = false
let clawPausedAt = performance.now()

function pauseClawLoop() {
  if (!clawLoopActive) return
  clawLoopActive = false
  clawPausedAt = performance.now()
  window.cancelAnimationFrame(clawFrameId)
  clawFrameId = 0
}

function resumeClawLoop() {
  if (clawLoopActive) return
  const now = performance.now()
  if (gameState !== 'idle') stateStarted += now - clawPausedAt
  clock.getDelta()
  clawLoopActive = true
  clawFrameId = requestAnimationFrame(animate)
}

function animate(now: number) {
  if (!clawLoopActive) return
  const delta = Math.min(clock.getDelta(), 0.05)
  updateMovement(delta)
  updateState(now)
  updateLooseToy(delta)
  marker.position.x = claw.position.x
  marker.position.z = claw.position.z
  marker.rotation.z -= delta * 0.7
  markerMaterial.opacity = gameState === 'idle' ? 0.36 + Math.sin(now * 0.004) * 0.14 : 0.08
  updateClawGeometry()
  orbit.update()
  if (revealToy) revealToy.rotation.y += delta * 0.85
  renderer.render(scene, camera)
  clawFrameId = requestAnimationFrame(animate)
}

setState('idle')
resumeClawLoop()
