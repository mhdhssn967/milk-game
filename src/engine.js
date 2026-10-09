// Milk physics + rendering engine (plain canvas 2D, no dependencies)
import cowSound from './cow.mp3'
import milkSound from './milkintoglass.mp3'

const W = 600, H = 800
const G = 2400          // px/s^2
const DT = 1 / 120
const V0 = 170          // initial stream speed (px/s)
const QMIN = 0.012      // below this flow rate the stream breaks into drips
const DRIP = 0.0011     // volume of one drip (fraction of bottle)
const LMAX = 1.03       // surface-tension dome: how far above the rim milk may bulge
const TABLE = 770

const B = { left: 220, right: 380, rim: 500, floor: 770, wall: 7, N: 48 }
B.h = B.floor - B.rim
B.w = B.right - B.left
B.col = B.w / B.N
const TEAT_X = 300

const rand = (a, b) => a + Math.random() * (b - a)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

// flow envelope: quick ramp up, rhythmic squeeze pulses, long viscous taper into drips
function env(t, T) {
  return smooth(0, 0.3, t) * Math.pow(1 - smooth(T * 0.45, T, t), 1.4) * (1 + 0.16 * Math.sin(t * 20))
}

export class MilkEngine {
  constructor(canvas, onEvent) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.onEvent = onEvent || (() => {})
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2)
    canvas.width = W * dpr
    canvas.height = H * dpr
    this.dpr = dpr
    this.enabled = true
    this.hover = false
    this.t = 0
    this.acc = 0
    this.last = 0
    this.raf = 0
    this.makeScenery()
    this.reset()
  }

  makeScenery() {
    const rows = []
    for (let i = 0; i < 260; i++) {
      rows.push({ x: Math.random(), y: Math.random(), len: rand(10, 34), a: rand(-0.5, 0.5), s: Math.random() })
    }
    this.straw = rows
    this.motes = Array.from({ length: 36 }, () => ({ x: rand(0, W), y: rand(0, H), r: rand(0.6, 2), sp: rand(4, 14), ph: rand(0, 6) }))
    this.wood = Array.from({ length: 40 }, () => ({ x: rand(0, W), y: rand(0, 1), len: rand(40, 160) }))
  }

  reset() {
    const n = B.N
    this.L = 0
    this.h = new Float32Array(n)
    this.v = new Float32Array(n)
    this.surf = new Float32Array(n).fill(B.floor)
    this.parts = []
    this.drops = []
    this.foam = []
    this.riv = []
    this.puddle = [0, 0]
    this.phase = 'idle'
    this.flow = null
    this.spilled = false
    this.spillBuf = 0
    this.spillSide = 0
    this.spillSwitch = 0
    this.settle = 0
    this.sq = 0
    this.moo = 0
    this.angry = 0
    this.angerLevel = 0
    this.mooText = 'Moooo!'
    this.prev = null
    this.dripAcc = 0
    this.mooSound = new Audio(cowSound)
    this.milkAudio = new Audio(milkSound)
    this.milkAudio.loop = true
    this.playedMoo = false
    this.tailKick = 0
    this.blink = 0
    this.nextBlink = 2
    this.enabled = true
    this.updateSurf()
  }

  start() {
    const loop = (ms) => {
      const dt = Math.min(0.05, (ms - (this.last || ms)) / 1000)
      this.last = ms
      this.acc += dt
      while (this.acc >= DT) { this.step(DT); this.acc -= DT }
      this.render()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop() { cancelAnimationFrame(this.raf) }

  hit(x, y) { return x > 150 && x < 450 && y > 0 && y < 400 }

  startSqueeze() {
    if (this.phase !== 'idle') return false
    if (!this.enabled) return false
    this.phase = 'flowing'
    this.flowTime = 0
    this.moo = 1.3
    this.mooText = pick(['Moooo!', 'Mooo~', 'Mmmoo!'])
    this.prev = null
    this.dripAcc = 0
    this.playedMoo = false
    this.tailKick = 1
    
    this.milkAudio.currentTime = 0
    this.milkAudio.play().catch(() => {})
    
    this.onEvent({ type: 'start' })
    return true
  }

  stopSqueeze() {
    if (this.phase === 'flowing') {
      this.phase = 'settling'
      this.settle = 0
      this.milkAudio.pause()
    }
  }

  // ---------- physics ----------
  teatY() { 
    const sq = this.sq
    const breath = this.phase === 'idle' ? Math.sin(this.t * 3) * 0.03 : 0
    const sqY = 1 - 0.15 * sq - breath
    const teatLen = 42 + sq * 15 + 6
    return (80 + teatLen) * 2.5 * sqY 
  }

  step(dt) {
    this.t += dt
    this.stepFlow(dt)
    this.stepParts(dt)
    this.stepDrops(dt)
    this.stepRiv(dt)
    this.stepWaves()
    if (this.L > LMAX) {
      this.spillBuf += this.L - LMAX
      this.L = LMAX
      this.spilled = true
    }
    this.stepSpill(dt)
    this.updateSurf()
    for (const f of this.foam) { f.age += dt; f.x = clamp(f.x + f.vx * dt, B.left + 4, B.right - 4) }
    this.foam = this.foam.filter((f) => f.age < f.life)

    const target = this.phase === 'flowing' ? 1 : 0
    this.sq += (target - this.sq) * Math.min(1, dt * 10)
    
    let targetAnger = this.phase === 'flowing' ? this.flowTime / 1.5 : 0
    if (this.angry > 0) {
      targetAnger = 1
      this.angry -= dt
    }
    this.angerLevel += (targetAnger - this.angerLevel) * Math.min(1, dt * 5)
    
    this.moo = Math.max(0, this.moo - dt)
    this.tailKick *= Math.pow(0.4, dt)
    this.nextBlink -= dt
    if (this.nextBlink < 0) { this.blink = 0.16; this.nextBlink = rand(2, 5) }
    this.blink = Math.max(0, this.blink - dt)

    if (this.phase === 'settling') {
      const quiet = !this.parts.length && !this.drops.length && !this.riv.length && this.spillBuf <= 0
      this.settle = quiet ? this.settle + dt : 0
      if (this.settle > (this.spilled ? 1.3 : 0.9)) {
        this.phase = this.spilled ? 'over' : 'idle'
        this.onEvent({ type: 'end', spilled: this.spilled })
      }
    }
  }

  stepFlow(dt) {
    if (this.phase !== 'flowing') return
    this.flowTime += dt
    
    if (this.flowTime >= 0.5 && !this.playedMoo) {
      this.playedMoo = true
      this.mooSound.currentTime = 0
      this.mooSound.play().catch(() => {})
    }
    
    if (this.flowTime >= 1.5) {
      this.angry = 1.2
      this.stopSqueeze()
      return
    }

    const q = 0.18 * (1 + 0.1 * Math.sin(this.flowTime * 20))
    const ty = this.teatY()
    if (q > QMIN) {
      const w0 = 2 + 42 * Math.sqrt(q)
      const p = { x: TEAT_X + Math.sin(this.flowTime * 13) * 0.7, y: ty, vy: V0, vx: Math.sin(this.flowTime * 9) * 4, w0, v0: V0, vol: q * dt, drop: false, prev: this.prev }
      this.parts.push(p)
      this.prev = p
    } else {
      this.prev = null
      this.dripAcc += q * dt
      if (this.dripAcc >= DRIP) {
        this.dripAcc -= DRIP
        this.parts.push({ x: TEAT_X, y: ty + 6, vy: 40, vx: 0, r: 3.6, vol: DRIP, drop: true, prev: null })
      }
    }
  }

  stepParts(dt) {
    const keep = []
    for (const p of this.parts) {
      p.vy += G * dt
      p.y += p.vy * dt
      p.x += p.vx * dt
      const sy = this.surfY(p.x)
      if (p.y >= sy) { this.land(p); continue }
      keep.push(p)
    }
    this.parts = keep
  }

  land(p) {
    this.L += p.vol
    const w = p.drop ? p.r * 2 : p.w0 * Math.sqrt(p.v0 / Math.max(p.vy, 1))
    this.impulse(p.x, w * (p.drop ? 0.06 : 0.028))
    const ps = p.drop ? 0.9 : clamp(w * 0.02, 0, 0.18)
    if (Math.random() < ps) this.splash(p.x, this.surfY(p.x), p.drop ? 2 : 1, p.vy)
    if (Math.random() < (p.drop ? 0.9 : 0.3) && this.foam.length < 180) {
      this.foam.push({ x: clamp(p.x + rand(-8, 8), B.left + 4, B.right - 4), age: 0, life: rand(2, 5), r: rand(1.2, 3.4), vx: rand(-4, 4) })
    }
  }

  splash(x, y, n, vy) {
    if (this.drops.length > 260) return
    for (let i = 0; i < n; i++) {
      this.drops.push({ x, y: y - 1, vx: rand(-1, 1) * 110, vy: -rand(120, 300) * (0.6 + vy / 1500), r: rand(0.9, 2.4) })
    }
  }

  stepDrops(dt) {
    const keep = []
    for (const d of this.drops) {
      d.vy += G * dt
      d.x += d.vx * dt
      d.y += d.vy * dt
      if (d.y > B.rim && d.y < B.floor) {
        if (d.x < B.left + 2) { d.x = B.left + 2; d.vx = Math.abs(d.vx) * 0.3 }
        if (d.x > B.right - 2) { d.x = B.right - 2; d.vx = -Math.abs(d.vx) * 0.3 }
      }
      const inside = d.x > B.left && d.x < B.right
      if (inside && d.y >= this.surfY(d.x)) {
        this.L += 0.00004
        this.impulse(d.x, d.r * 0.05)
        continue
      }
      if (d.y > TABLE) continue
      keep.push(d)
    }
    this.drops = keep
  }

  stepSpill(dt) {
    if (this.spillBuf <= 0) return
    this.spillSwitch -= dt
    if (this.spillSwitch <= 0) { this.spillSide = Math.random() < 0.5 ? 0 : 1; this.spillSwitch = rand(0.5, 1.3) }
    let n = 0
    while (this.spillBuf > 0 && n < 4) {
      const vol = Math.min(this.spillBuf, 0.0007)
      this.spillBuf -= vol
      n++
      const s = this.spillSide
      const dir = s === 0 ? -1 : 1
      this.riv.push({
        s, x: s === 0 ? 264 : 336, y: B.rim - 6, vx: dir * rand(40, 90), vy: -rand(30, 70),
        vt: rand(260, 380), arc: true, vol,
      })
    }
  }

  stepRiv(dt) {
    const keep = []
    for (const r of this.riv) {
      const wx = r.s === 0 ? B.left - B.wall - 2 : B.right + B.wall + 2
      if (r.arc) {
        r.vy += G * dt
        r.x += r.vx * dt
        r.y += r.vy * dt
        if (r.y > B.rim + 6 && ((r.s === 0 && r.x <= 264) || (r.s === 1 && r.x >= 336))) { r.arc = false; r.vy = Math.max(r.vy, 120) }
      } else {
        r.vy = Math.min(r.vy + 900 * dt, r.vt)
        r.y += r.vy * dt
        r.x += (wx - r.x) * Math.min(1, dt * 10)
      }
      if (r.y >= B.floor - 2) { this.puddle[r.s] += r.vol; continue }
      keep.push(r)
    }
    this.riv = keep
  }

  // 1D height-field wave equation with damping (milk is a bit more viscous than water)
  stepWaves() {
    const { h, v } = this
    const n = B.N
    for (let i = 0; i < n; i++) {
      const l = h[i > 0 ? i - 1 : i]
      const r = h[i < n - 1 ? i + 1 : i]
      v[i] += (l + r - 2 * h[i]) * 0.26 - h[i] * 0.003
    }
    let mean = 0
    for (let i = 0; i < n; i++) {
      v[i] *= 0.989
      h[i] = clamp(h[i] + v[i], -14, 14)
      mean += h[i]
    }
    mean /= n
    for (let i = 0; i < n; i++) h[i] -= mean * 0.02
  }

  impulse(x, F) {
    const c = Math.round((x - B.left) / B.col - 0.5)
    for (let k = -3; k <= 3; k++) {
      const i = c + k
      if (i < 0 || i >= B.N) continue
      this.v[i] -= F * Math.exp(-(k * k) / 2.2)
    }
  }

  updateSurf() {
    const n = B.N
    const base = B.floor - Math.min(this.L, 1) * B.h
    const dome = Math.max(0, this.L - 1) * B.h
    for (let i = 0; i < n; i++) {
      const men = 3 * Math.exp(-Math.min(i, n - 1 - i) / 1.2)
      const d = dome * Math.pow(Math.sin((Math.PI * (i + 0.5)) / n), 0.6)
      this.surf[i] = base + this.h[i] - men - d
    }
  }

  surfY(x) {
    const f = clamp((x - B.left) / B.col - 0.5, 0, B.N - 1)
    const i = Math.floor(f)
    const j = Math.min(B.N - 1, i + 1)
    const u = f - i
    return this.surf[i] * (1 - u) + this.surf[j] * u
  }

  // ---------- rendering ----------
  render() {
    const c = this.ctx
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    c.clearRect(0, 0, W, H)
    this.drawBackground(c)
    this.drawCow(c)
    this.drawTable(c)
    this.drawPuddles(c)
    this.drawBottle(c)
    this.drawRivulets(c)
    this.drawHint(c)
    this.drawAngerBar(c)
    this.drawVignette(c)
  }

  drawBackground(c) {
    const g = c.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, '#3b1d25')
    g.addColorStop(1, '#5d2c2c')
    c.fillStyle = g
    c.fillRect(0, 0, W, H)
    for (let x = 0; x < W; x += 62) {
      c.fillStyle = 'rgba(0,0,0,0.22)'
      c.fillRect(x, 0, 3, H)
      c.fillStyle = 'rgba(255,200,160,0.05)'
      c.fillRect(x + 3, 0, 2, H)
    }
    const r = c.createRadialGradient(600, 440, 20, 600, 440, 400)
    r.addColorStop(0, 'rgba(255,214,150,0.30)')
    r.addColorStop(1, 'rgba(255,214,150,0)')
    c.fillStyle = r
    c.fillRect(0, 0, W, H)
    // dust motes drifting in the light
    for (const m of this.motes) {
      const x = (m.x + Math.sin(this.t * 0.4 + m.ph) * 20) % W
      const y = (m.y - this.t * m.sp + H * 10) % H
      c.fillStyle = `rgba(255,236,200,${0.15 + 0.15 * Math.sin(this.t + m.ph)})`
      c.beginPath(); c.arc(x, y, m.r, 0, 6.3); c.fill()
    }
  }

  drawHay(c) {
    const stack = (x0, x1) => {
      c.save()
      c.beginPath(); c.rect(x0, 470, x1 - x0, TABLE - 470); c.clip()
      for (let r = 0; r < 4; r++) {
        const y = 470 + r * 68
        const off = r % 2 ? 55 : 0
        for (let x = x0 - off; x < x1; x += 110) {
          const g = c.createLinearGradient(0, y, 0, y + 68)
          g.addColorStop(0, '#efc965'); g.addColorStop(1, '#c4962f')
          c.fillStyle = g
          c.beginPath(); c.roundRect(x + 2, y + 2, 106, 64, 8); c.fill()
          c.strokeStyle = 'rgba(120,80,20,0.55)'; c.lineWidth = 2; c.stroke()
          c.strokeStyle = '#6b4a22'; c.lineWidth = 3
          c.beginPath(); c.moveTo(x + 30, y + 2); c.lineTo(x + 30, y + 66); c.moveTo(x + 80, y + 2); c.lineTo(x + 80, y + 66); c.stroke()
          for (const s of this.straw.slice(0, 30)) {
            c.strokeStyle = s.s > 0.5 ? 'rgba(255,230,140,0.7)' : 'rgba(140,95,30,0.5)'
            c.lineWidth = 1.2
            const sx = x + 4 + s.x * 100, sy = y + 4 + s.y * 58
            c.beginPath(); c.moveTo(sx, sy); c.lineTo(sx + Math.cos(s.a) * s.len * 0.6, sy + Math.sin(s.a) * 5); c.stroke()
          }
        }
      }
      c.restore()
    }
    stack(210, 430)
    stack(690, 940)
  }

  drawCow(c) {
    const sq = this.sq
    
    if (this.moo > 0) {
      const a = Math.min(1, this.moo * 2)
      c.save(); c.globalAlpha = a
      c.translate(300, 20)
      c.fillStyle = '#fff'
      c.beginPath(); c.roundRect(-80, 0, 160, 50, 24); c.fill()
      c.beginPath(); c.moveTo(-10, 48); c.lineTo(0, 76); c.lineTo(20, 48); c.fill()
      c.fillStyle = '#3b1d25'; c.font = '700 26px Fredoka, "Trebuchet MS", sans-serif'; c.textAlign = 'center'
      c.fillText(this.mooText, 0, 34)
      c.restore()
    }

    // udder zoomed in
    const breath = this.phase === 'idle' ? Math.sin(this.t * 3) * 0.03 : 0
    const sqX = 1 + 0.1 * sq + breath
    const sqY = 1 - 0.15 * sq - breath
    const shakeX = this.angry > 0 ? Math.sin(this.t * 60) * 12 * this.angry : 0
    c.save(); c.translate(300 + shakeX, 0); c.scale(2.5 * sqX, 2.5 * sqY)
    
    c.lineJoin = 'round'
    
    const lerp = (a, b, t) => a + (b - a) * t
    const lerpC = (r1, g1, b1, r2, g2, b2, t) => `rgb(${lerp(r1,r2,t)|0},${lerp(g1,g2,t)|0},${lerp(b1,b2,t)|0})`
    const anger = this.angerLevel
    const teatCol = lerpC(244, 154, 180, 255, 68, 68, anger)
    const bodyCol = lerpC(255, 179, 198, 255, 34, 34, anger)
    
    const drawUdder = () => {
      const teat = (x, len, rot) => { 
        c.save()
        c.translate(x, 80)
        c.rotate(rot)
        
        c.beginPath()
        c.moveTo(-14, 0)
        c.lineTo(-10, len)
        c.quadraticCurveTo(0, len + 8, 10, len)
        c.lineTo(14, 0)
        c.closePath()
        
        c.fillStyle = teatCol
        c.fill()
        c.lineWidth = 4
        c.strokeStyle = '#2b1d24'
        c.stroke()
        
        c.fillStyle = 'rgba(255,255,255,0.4)'
        c.beginPath(); c.ellipse(-4, len/2, 3, len/3, 0, 0, 6.3); c.fill()
        c.restore()
      }
      
      const teatLen = 42 + sq * 15
      teat(-45, teatLen - 4, 0.2 - sq * 0.1)
      teat(45, teatLen - 4, -0.2 + sq * 0.1)
      teat(0, teatLen + 6, 0)
      
      c.beginPath()
      c.moveTo(-85, -20)
      c.bezierCurveTo(-100, 50, -80, 100, -30, 110)
      c.bezierCurveTo(-10, 115, 10, 115, 30, 110)
      c.bezierCurveTo(80, 100, 100, 50, 85, -20)
      c.closePath()
      
      c.fillStyle = bodyCol
      c.fill()
      
      c.lineWidth = 5
      c.strokeStyle = '#2b1d24'
      c.stroke()
      
      c.save()
      c.clip()
      c.fillStyle = 'rgba(0,0,0,0.12)'
      c.beginPath()
      c.moveTo(-100, 55)
      c.quadraticCurveTo(0, 140, 100, 55)
      c.lineTo(100, 150)
      c.lineTo(-100, 150)
      c.fill()
      c.restore()
      
      c.fillStyle = 'rgba(255,255,255,0.5)'
      c.beginPath(); c.ellipse(-40, 40, 16, 26, 0.4, 0, 6.3); c.fill()
      c.beginPath(); c.ellipse(-24, 20, 6, 6, 0, 0, 6.3); c.fill()
    }
    
    drawUdder()

    if (this.phase === 'flowing') { c.fillStyle = '#7b2c45'; c.beginPath(); c.ellipse(0, 139, 3, 1.6, 0, 0, 6.3); c.fill() }
    c.restore()
  }

  drawTable(c) {
    const g = c.createLinearGradient(0, TABLE, 0, H)
    g.addColorStop(0, '#c58a52'); g.addColorStop(0.4, '#a9703d'); g.addColorStop(1, '#6d4224')
    c.fillStyle = g
    c.fillRect(0, TABLE, W, H - TABLE)
    c.fillStyle = 'rgba(255,230,190,0.35)'
    c.fillRect(0, TABLE, W, 3)
    c.fillStyle = 'rgba(0,0,0,0.25)'
    c.fillRect(0, TABLE + 30, W, 3)
    c.strokeStyle = 'rgba(70,35,15,0.25)'; c.lineWidth = 1.5
    for (const w of this.wood) {
      const y = TABLE + 4 + w.y * 24
      c.beginPath(); c.moveTo(w.x, y); c.lineTo(w.x + w.len, y + Math.sin(w.x) * 1.5); c.stroke()
    }
    for (let y = TABLE + 36; y < H; y += 24) { c.strokeStyle = 'rgba(60,30,12,0.3)'; c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke() }
  }

  drawPuddles(c) {
    this.puddle.forEach((P, s) => {
      if (P <= 0) return
      const rx = Math.min(230, 8 + 330 * Math.sqrt(P))
      const ry = rx * 0.12 + 3
      const cx = s === 0 ? B.left - B.wall - 4 - rx * 0.3 : B.right + B.wall + 4 + rx * 0.3
      const cy = B.floor - 2
      c.beginPath()
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2
        const k = 1 + 0.05 * Math.sin(a * 3 + this.t * 1.3) + 0.03 * Math.sin(a * 5 - this.t)
        const x = cx + Math.cos(a) * rx * k, y = cy + Math.sin(a) * ry * k
        i ? c.lineTo(x, y) : c.moveTo(x, y)
      }
      c.closePath()
      const g = c.createRadialGradient(cx, cy, 2, cx, cy, rx)
      g.addColorStop(0, '#fffdf8'); g.addColorStop(1, '#ece8de')
      c.fillStyle = g; c.fill()
      c.strokeStyle = 'rgba(210,205,190,0.9)'; c.lineWidth = 1.5; c.stroke()
      c.fillStyle = 'rgba(255,255,255,0.8)'
      c.beginPath(); c.ellipse(cx - rx * 0.3, cy - ry * 0.3, rx * 0.25, ry * 0.18, 0, 0, 6.3); c.fill()
    })
  }

  bottlePath(c, w) {
    const neckL = 264 - w, neckR = 336 + w
    const bodyL = B.left - w, bodyR = B.right + w
    const rimY = B.rim, neckBaseY = B.rim + 40, shoulderY = B.rim + 120, floorY = B.floor
    const r = 18 + w

    c.moveTo(neckL, rimY)
    c.lineTo(neckL, neckBaseY)
    c.bezierCurveTo(neckL, neckBaseY + 40, bodyL, shoulderY - 40, bodyL, shoulderY)
    c.lineTo(bodyL, floorY - r)
    c.quadraticCurveTo(bodyL, floorY, bodyL + r, floorY)
    c.lineTo(bodyR - r, floorY)
    c.quadraticCurveTo(bodyR, floorY, bodyR, floorY - r)
    c.lineTo(bodyR, shoulderY)
    c.bezierCurveTo(bodyR, shoulderY - 40, neckR, neckBaseY + 40, neckR, neckBaseY)
    c.lineTo(neckR, rimY)
  }

  bottleClip(c) {
    c.beginPath()
    this.bottlePath(c, 0)
    c.lineTo(336, B.rim - 20)
    c.lineTo(264, B.rim - 20)
    c.closePath()
  }

  drawBottle(c) {
    const n = B.N
    // contact shadow
    c.fillStyle = 'rgba(0,0,0,0.35)'
    c.beginPath(); c.ellipse(300, B.floor, 100, 9, 0, 0, 6.3); c.fill()
    // back glass tint
    c.beginPath(); this.bottlePath(c, 0); c.closePath()
    c.fillStyle = 'rgba(190,225,255,0.08)'; c.fill()
    c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 3; c.stroke()

    // milk
    if (this.L > 0.0005) {
      c.save(); this.bottleClip(c); c.clip()
      const base = B.floor - Math.min(this.L, 1) * B.h
      const mg = c.createLinearGradient(0, base - 6, 0, B.floor)
      mg.addColorStop(0, '#ffffff'); mg.addColorStop(0.05, '#fffdf4'); mg.addColorStop(1, '#efebe2')
      c.fillStyle = mg
      c.beginPath()
      c.moveTo(B.left - 2, this.surf[0])
      for (let i = 0; i < n; i++) c.lineTo(B.left + (i + 0.5) * B.col, this.surf[i])
      c.lineTo(B.right + 2, this.surf[n - 1]); c.lineTo(B.right + 2, B.floor + 4); c.lineTo(B.left - 2, B.floor + 4)
      c.closePath(); c.fill()
      const hg = c.createLinearGradient(B.left, 0, B.right, 0)
      hg.addColorStop(0, 'rgba(60,50,40,0.14)'); hg.addColorStop(0.25, 'rgba(60,50,40,0)'); hg.addColorStop(0.8, 'rgba(60,50,40,0)'); hg.addColorStop(1, 'rgba(60,50,40,0.12)')
      c.fillStyle = hg; c.fillRect(B.left, B.rim - 16, B.w, B.h + 16)
      // surface line
      c.lineJoin = 'round'
      c.beginPath(); c.moveTo(B.left, this.surf[0])
      for (let i = 0; i < n; i++) c.lineTo(B.left + (i + 0.5) * B.col, this.surf[i])
      c.lineTo(B.right, this.surf[n - 1])
      c.strokeStyle = 'rgba(205,198,180,0.6)'; c.lineWidth = 3; c.stroke()
      c.strokeStyle = 'rgba(255,255,255,0.98)'; c.lineWidth = 1.8; c.stroke()
      // foam
      for (const f of this.foam) {
        const a = Math.min(1, (f.life - f.age) * 1.2)
        const y = this.surfY(f.x)
        c.globalAlpha = a * 0.95
        c.fillStyle = '#ffffff'; c.strokeStyle = 'rgba(205,215,230,0.9)'; c.lineWidth = 0.8
        c.beginPath(); c.arc(f.x, y - f.r * 0.4, f.r, 0, 6.3); c.fill(); c.stroke()
      }
      c.globalAlpha = 1
      c.restore()
    }

    this.drawStream(c)

    // front glass
    c.fillStyle = 'rgba(190,225,245,0.15)'
    c.beginPath()
    this.bottlePath(c, B.wall)
    c.lineTo(336, B.rim)
    c.lineTo(264, B.rim)
    c.closePath()
    c.fill()

    c.strokeStyle = 'rgba(235,248,255,0.65)'; c.lineWidth = 3
    c.beginPath(); this.bottlePath(c, B.wall); c.stroke()
    
    // lip
    c.fillStyle = 'rgba(215,240,255,0.5)'; c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = 1.5
    c.beginPath(); c.roundRect(264 - 12, B.rim - 6, 72 + 24, 10, 5); c.fill(); c.stroke()
    // highlights
    const hl = c.createLinearGradient(0, B.rim, 0, B.floor)
    hl.addColorStop(0, 'rgba(255,255,255,0.65)'); hl.addColorStop(1, 'rgba(255,255,255,0.08)')
    c.fillStyle = hl
    c.beginPath(); c.roundRect(B.left + 10, B.rim + 130, 8, B.h - 180, 4); c.fill()
    c.fillStyle = 'rgba(255,255,255,0.25)'
    c.beginPath(); c.roundRect(B.right - 14, B.rim + 150, 4, B.h - 220, 2); c.fill()
    c.fillStyle = 'rgba(255,255,255,0.45)'
    c.beginPath(); c.roundRect(264 + 6, B.rim + 10, 4, 30, 2); c.fill()
    // graduation ticks + etched label
    c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = 1.5
    for (let k = 1; k <= 3; k++) {
      const y = B.floor - (k / 4.5) * B.h
      c.beginPath(); c.moveTo(B.right - (k % 2 ? 14 : 22), y); c.lineTo(B.right, y); c.stroke()
    }
    c.fillStyle = 'rgba(255,255,255,0.28)'; c.font = '600 15px Fredoka, "Trebuchet MS", sans-serif'; c.textAlign = 'center'
    c.fillText('FRESH MILK', 300, B.floor - 24)
    c.textAlign = 'start'

    // splash droplets (outside clip so they can fly over the rim)
    for (const d of this.drops) this.drawBlob(c, d.x, d.y, d.r, d.r * (1 + clamp(Math.abs(d.vy) / 1800, 0, 0.6)))
  }

  drawBlob(c, x, y, rx, ry) {
    c.fillStyle = '#fffdf8'; c.strokeStyle = 'rgba(190,205,225,0.8)'; c.lineWidth = 0.7
    c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 6.3); c.fill(); c.stroke()
  }

  drawStream(c) {
    let chain = []
    const flush = () => {
      if (chain.length) this.drawChain(c, chain)
      chain = []
    }
    for (const p of this.parts) {
      if (p.drop) { flush(); this.drawBlob(c, p.x, p.y, p.r, p.r * (1 + clamp(p.vy / 1600, 0, 0.7))); continue }
      if (chain.length && p.prev !== chain[chain.length - 1]) flush()
      chain.push(p)
    }
    flush()
  }

  drawChain(c, chain) {
    const width = (p) => p.w0 * Math.sqrt(p.v0 / Math.max(p.vy, 1)) // continuity: faster -> thinner
    const pts = chain.map((p) => ({ x: p.x, y: p.y, w: width(p) }))
    const low = pts[0]
    const surf = this.surfY(low.x)
    if (surf - low.y < 16) pts.unshift({ x: low.x, y: surf, w: low.w })
    const newest = chain[chain.length - 1]
    const attached = this.phase === 'flowing' && newest === this.prev
    if (attached) pts.push({ x: TEAT_X, y: this.teatY() - 4, w: pts[pts.length - 1].w + 3 })
    if (pts.length < 2) { this.drawBlob(c, pts[0].x, pts[0].y, pts[0].w / 2, pts[0].w / 2); return }
    c.beginPath()
    c.moveTo(pts[0].x - pts[0].w / 2, pts[0].y)
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x - pts[i].w / 2, pts[i].y)
    for (let i = pts.length - 1; i >= 0; i--) c.lineTo(pts[i].x + pts[i].w / 2, pts[i].y)
    c.closePath()
    c.fillStyle = '#fffdf6'; c.fill()
    c.strokeStyle = 'rgba(190,205,225,0.85)'; c.lineWidth = 0.8; c.stroke()
    // rounded ends if floating in air
    if (surf - low.y >= 16) { c.beginPath(); c.arc(low.x, low.y, low.w / 2, 0, 6.3); c.fillStyle = '#fffdf6'; c.fill() }
    if (!attached) { const t = pts[pts.length - 1]; c.beginPath(); c.arc(t.x, t.y, t.w / 2, 0, 6.3); c.fill() }
    // specular streak
    c.strokeStyle = 'rgba(255,255,255,0.95)'; c.lineWidth = 1.2
    c.beginPath()
    for (let i = 0; i < pts.length; i++) {
      const x = pts[i].x - pts[i].w * 0.18, y = pts[i].y
      i ? c.lineTo(x, y) : c.moveTo(x, y)
    }
    c.stroke()
  }

  drawRivulets(c) {
    for (const r of this.riv) {
      this.drawBlob(c, r.x, r.y, 3, 3.6)
    }
    // thin film left on the glass
    c.fillStyle = '#fffdf6'
    for (const r of this.riv) { c.beginPath(); c.arc(r.x, r.y, 2.4, 0, 6.3); c.fill() }
  }

  drawHint(c) {
    // Hint removed
  }

  drawAngerBar(c) {
    if (this.angerLevel <= 0.01) return
    c.save()
    c.translate(30, H / 2 - 140)
    
    // background
    c.fillStyle = 'rgba(0,0,0,0.4)'
    c.beginPath(); c.roundRect(0, 0, 20, 200, 10); c.fill()
    
    // bar
    const barH = this.angerLevel * 192
    const r = 255
    const g = Math.floor(255 * (1 - this.angerLevel))
    c.fillStyle = `rgb(${r},${g},0)`
    c.beginPath(); c.roundRect(4, 200 - 4 - barH, 12, barH, 6); c.fill()
    
    // icon
    if (this.angerLevel > 0.8) {
      c.fillStyle = '#ff4444'
      c.font = '24px Arial'
      c.fillText('⚠️', -6, -10 + Math.sin(this.t * 30) * 3)
    }
    c.restore()
  }

  drawVignette(c) {
    const g = c.createRadialGradient(W / 2, H / 2, 280, W / 2, H / 2, 720)
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.45)')
    c.fillStyle = g; c.fillRect(0, 0, W, H)
  }
}

export const LOGICAL = { W, H }
