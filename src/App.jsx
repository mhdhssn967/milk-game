import { useEffect, useRef, useState } from 'react'
import { MilkEngine, LOGICAL } from './engine'
import { io } from 'socket.io-client'
import './App.css'

let socket = null

export default function App() {
  const canvasRef = useRef(null)
  const engRef = useRef(null)
  
  const [appState, setAppState] = useState('menu') // 'menu', 'lobby', 'game'
  const [modalState, setModalState] = useState('none')
  const [roomId, setRoomId] = useState('')
  const [joinInput, setJoinInput] = useState('')
  const [playerName, setPlayerName] = useState('')
  const [players, setPlayers] = useState([])
  const [playerNames, setPlayerNames] = useState({})
  const [myId, setMyId] = useState('')
  const [isHost, setIsHost] = useState(false)
  const [turnIndex, setTurnIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [loser, setLoser] = useState(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [bannerKey, setBannerKey] = useState(0)

  // Socket init
  useEffect(() => {
    socket = io('https://server-vlef.onrender.com')
    
    socket.on('connect', () => {
      setMyId(socket.id)
    })

    socket.on('milkRoomCreated', (id) => {
      setRoomId(id)
      setIsHost(true)
      setAppState('lobby')
      setErrorMsg('')
    })

    socket.on('milkJoined', (id) => {
      setRoomId(id)
      setIsHost(false)
      setAppState('lobby')
      setErrorMsg('')
    })

    socket.on('milkPlayersUpdate', (data) => {
      if (Array.isArray(data)) {
        // Fallback for old server payload
        setPlayers(data)
        setPlayerNames({})
      } else {
        setPlayers(data?.players || [])
        setPlayerNames(data?.names || {})
      }
    })

    socket.on('milkError', (msg) => {
      setErrorMsg(msg)
    })

    socket.on('milkGameStarted', (data) => {
      setTurnIndex(data.turn)
      setPlayers(data.players)
      setAppState('game')
      setLoser(null)
      setBusy(false)
      if (engRef.current) engRef.current.reset()
    })

    socket.on('milkAction', (action) => {
      if (engRef.current) {
        if (action === 'startSqueeze') engRef.current.startSqueeze(true)
        if (action === 'stopSqueeze') engRef.current.stopSqueeze(true)
      }
    })

    socket.on('milkNewTurn', (turn) => {
      setTurnIndex(turn)
      setBusy(false)
      setBannerKey((k) => k + 1)
    })

    socket.on('milkGameOver', (data) => {
      setLoser(data.loser)
      setBusy(false)
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  // Use refs for state accessed inside engine callback
  const stateRef = useRef({ players, turnIndex, myId, roomId })
  const didMyTurnRef = useRef(false)
  useEffect(() => {
    stateRef.current = { players, turnIndex, myId, roomId }
  }, [players, turnIndex, myId, roomId])

  // Engine init
  useEffect(() => {
    if (appState !== 'game') return
    const e = new MilkEngine(canvasRef.current, (ev) => {
      if (ev.type === 'start') {
        setBusy(true)
      }
      if (ev.type === 'end') {
        setBusy(false)
        const s = stateRef.current
        if (s.players[s.turnIndex] === s.myId && didMyTurnRef.current) {
          didMyTurnRef.current = false
          socket.emit('milkTurnEnded', { roomId: s.roomId, spilled: ev.spilled })
        }
      }
    })
    e.start()
    engRef.current = e
    return () => {
      e.stop()
      engRef.current = null
    }
  }, [appState])

  const createRoom = () => socket.emit('milkCreateRoom', playerName)
  const joinRoom = () => {
    if (joinInput.length === 5) socket.emit('milkJoinRoom', { roomId: joinInput, name: playerName })
  }
  const startGame = () => socket.emit('milkStartGame', roomId)

  const isMyTurn = () => players[turnIndex] === myId

  const press = () => {
    if (loser !== null || !isMyTurn()) return
    if (engRef.current?.startSqueeze()) {
      didMyTurnRef.current = true
      socket.emit('milkAction', { roomId, action: 'startSqueeze' })
    }
  }
  
  const release = () => {
    if (!isMyTurn()) return
    engRef.current?.stopSqueeze()
    socket.emit('milkAction', { roomId, action: 'stopSqueeze' })
  }

  const toLogical = (ev) => {
    const r = canvasRef.current.getBoundingClientRect()
    return [((ev.clientX - r.left) / r.width) * LOGICAL.W, ((ev.clientY - r.top) / r.height) * LOGICAL.H]
  }

  const onDown = (ev) => {
    const [x, y] = toLogical(ev)
    if (engRef.current.hit(x, y)) press()
  }
  const onMove = (ev) => {
    if (!engRef.current) return
    const [x, y] = toLogical(ev)
    const h = engRef.current.hit(x, y)
    engRef.current.hover = h
    canvasRef.current.style.cursor = (h && !busy && loser === null && isMyTurn()) ? 'pointer' : 'default'
  }
  const onUp = () => release()

  useEffect(() => {
    const kd = (e) => { if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) { e.preventDefault(); press() } }
    const ku = (e) => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); release() } }
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku) }
  })

  if (appState === 'menu') {
    return (
      <div className="menu-screen" style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'100vh',gap:'20px',color:'white',background:'transparent'}}>
        <h1 style={{fontSize:'4rem', flex:'none', marginBottom:'40px', lineHeight:'1.1'}}>Don't Spill<br/>the Milk!</h1>
        
        {modalState === 'none' && (
          <div style={{display:'flex', flexDirection:'column', gap: '20px', width: '240px'}}>
            <button onClick={() => setModalState('create_name')} style={{padding:'15px',fontSize:'1.5rem',borderRadius:'16px',background:'#ff6b6b',border:'none',color:'white',cursor:'pointer',boxShadow:'0 4px 0 #c44545', width: '100%'}}>Create Room</button>
            <button onClick={() => setModalState('join_name')} style={{padding:'15px',fontSize:'1.5rem',borderRadius:'16px',background:'#a9703d',border:'none',color:'white',cursor:'pointer',boxShadow:'0 4px 0 #6d4224', width: '100%'}}>Join Room</button>
          </div>
        )}

        {(modalState === 'create_name' || modalState === 'join_name') && (
          <div style={{display:'flex', flexDirection:'column', gap: '15px', alignItems:'center'}}>
            <h2 style={{margin:0}}>Enter your name</h2>
            <input value={playerName} onChange={e=>setPlayerName(e.target.value)} placeholder="Your Name" style={{padding:'15px',fontSize:'1.2rem',borderRadius:'12px',border:'none',textAlign:'center',width:'240px',color:'#3b1d25',fontWeight:'bold'}} />
            <div style={{display:'flex', gap:'10px', width:'240px'}}>
               <button onClick={() => {setModalState('none'); setErrorMsg('')}} style={{flex:1, padding:'12px 10px',fontSize:'1.1rem',borderRadius:'12px',background:'#665',border:'none',color:'white',cursor:'pointer',boxShadow:'0 4px 0 #443'}}>Back</button>
               <button onClick={() => modalState === 'create_name' ? createRoom() : setModalState('join_code')} disabled={!playerName} style={{flex:1, padding:'12px 10px',fontSize:'1.1rem',borderRadius:'12px',background:'#ff6b6b',border:'none',color:'white',cursor:'pointer',boxShadow:'0 4px 0 #c44545'}}>Next</button>
            </div>
          </div>
        )}

        {modalState === 'join_code' && (
          <div style={{display:'flex', flexDirection:'column', gap: '15px', alignItems:'center'}}>
            <h2 style={{margin:0}}>Enter room code</h2>
            <input value={joinInput} onChange={e=>setJoinInput(e.target.value)} placeholder="5-DIGIT CODE" maxLength={5} style={{padding:'15px',fontSize:'1.2rem',borderRadius:'12px',border:'none',textAlign:'center',width:'240px',color:'#3b1d25',fontWeight:'bold'}} />
            <div style={{display:'flex', gap:'10px', width:'240px'}}>
               <button onClick={() => {setModalState('join_name'); setErrorMsg('')}} style={{flex:1, padding:'12px 10px',fontSize:'1.1rem',borderRadius:'12px',background:'#665',border:'none',color:'white',cursor:'pointer',boxShadow:'0 4px 0 #443'}}>Back</button>
               <button onClick={joinRoom} disabled={joinInput.length !== 5} style={{flex:1, padding:'12px 10px',fontSize:'1.1rem',borderRadius:'12px',background:'#a9703d',border:'none',color:'white',cursor:'pointer',boxShadow:'0 4px 0 #6d4224'}}>Join</button>
            </div>
          </div>
        )}

        {errorMsg && <div style={{color:'#ff6b6b',marginTop:'20px',fontSize:'1.2rem',fontWeight:'bold',background:'rgba(255,0,0,0.2)',padding:'10px',borderRadius:'8px'}}>{errorMsg}</div>}
      </div>
    )
  }

  if (appState === 'lobby') {
    return (
      <div className="lobby-screen" style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'100vh',gap:'20px',color:'white',background:'#2b1d24'}}>
        <h2 style={{fontSize:'2rem'}}>Room Code: <span style={{color:'#ffb3c6',letterSpacing:'3px'}}>{roomId}</span></h2>
        <h3>Players ({players.length}/5)</h3>
        <ul style={{listStyle:'none',padding:0,display:'flex',flexDirection:'column',gap:'10px',fontSize:'1.2rem'}}>
          {players.map((p) => (
            <li key={p} style={{background:'rgba(255,255,255,0.1)',padding:'10px 20px',borderRadius:'8px'}}>
              {playerNames[p]} {p === myId ? '(You)' : ''}
            </li>
          ))}
        </ul>
        {isHost ? (
          <button onClick={startGame} disabled={players.length < 2} style={{padding:'15px 30px',fontSize:'1.2rem',borderRadius:'8px',background:players.length>=2?'#ff6b6b':'#555',border:'none',color:'white',cursor:'pointer',marginTop:'20px'}}>
            Start Game
          </button>
        ) : (
          <div style={{marginTop:'20px',color:'#ffb3c6'}}>Waiting for host to start...</div>
        )}
      </div>
    )
  }

  const PlayerHeader = () => (
    <div style={{display:'flex',gap:'10px',flexWrap:'wrap',justifyContent:'center',width:'100%',maxWidth:'600px',marginBottom:'15px'}}>
      {players.map((p, i) => {
        const isTurn = turnIndex === i
        const isLoser = loser === i
        const isMe = p === myId
        return (
          <div key={p} style={{padding:'8px 12px',background:isLoser?'#ff4444':isTurn?'#ff6b6b':'rgba(255,255,255,0.1)',borderRadius:'8px',color:'white',border:isMe?'2px solid white':'2px solid transparent',opacity:loser!==null&&!isLoser?0.5:1}}>
            {playerNames[p]} {isMe?'(You)':''}
            {isTurn && loser === null && <div style={{fontSize:'0.8rem',marginTop:'4px'}}>{busy?'Milking...':'Current Turn'}</div>}
            {isLoser && <div style={{fontSize:'0.8rem',marginTop:'4px'}}>Spilled it!</div>}
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="app">
      <PlayerHeader />
      <div className="stage">
        <canvas ref={canvasRef} onContextMenu={e => e.preventDefault()} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onPointerCancel={onUp} />
        {loser === null && isMyTurn() && <div key={bannerKey} className="banner" style={{background:'#33ff57',color:'black'}}>Your turn!</div>}
        {loser === null && !isMyTurn() && <div key={bannerKey} className="banner">{playerNames[players[turnIndex]]}'s turn</div>}
        {loser !== null && (
          <div className="overlay">
            <div className="result">
              <div className="big">💥 {playerNames[players[loser]]} spilled the milk!</div>
              {isHost ? <button onClick={startGame} style={{marginTop:'20px'}}>Play Again</button> : <div style={{marginTop:'20px'}}>Waiting for host...</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
