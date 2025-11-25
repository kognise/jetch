import { useEffect, useMemo, useRef, useState } from 'react'
import './index.css'
import { produce } from 'immer'
import { nanoid } from 'nanoid'
import Photograph from './photograph/Photograph'
import { FaCat, FaEraser, FaPenFancy } from 'react-icons/fa6'
import SharingModal from './sharing/SharingModal'
import { createSnapshot, pointsToPath, type Point, type Action, useLocalState, type Brush, type CanvasPosition, exportAsPng, renderPath, renderActions, renderAction, kitty, kittySize } from './utils'
import type { IconType } from 'react-icons'

export default function App() {
    const containerRef = useRef<HTMLDivElement>(null)
    const staticCanvasRef = useRef<HTMLCanvasElement>(null)
    const activeCanvasRef = useRef<HTMLCanvasElement>(null)
    const inProgress = useRef(new Map<number, Point[]>())
    const redo = useRef<Action[]>([])
    const [sharingBlob, setSharingBlob] = useState<Blob | null>(null)
    
    const [brush, setBrush] = useLocalState<Brush>('brush', 'pen')
    const [penSize, setPenSize] = useLocalState<number>('pen-size', 5)
    const [eraserSize, setEraserSize] = useLocalState<number>('eraser-size', 8)
    const [position, setPosition] = useLocalState<CanvasPosition>('position', { x: 0, y: 0, zoom: 1 })
    const [history, setHistory] = useLocalState<Action[]>('history', [])
    
    const imageCache = useRef<Map<string, HTMLImageElement>>(new Map())
    const isFlattening = useRef(false)

    // Load snapshot images
    useEffect(() => {
        for (const action of history) {
            if (action.kind === 'snapshot' && !imageCache.current.has(action.id)) {
                const img = new Image()
                img.src = action.dataUrl
                img.onload = () => {
                    setResizeTrigger(n => n + 1)
                }
                imageCache.current.set(action.id, img)
            }
        }
    }, [history])

    // Flatten history
    useEffect(() => {
        const TARGET_LENGTH = 100
        // Use a buffer of 20 items to avoid frequent flattening operations
        if (history.length <= TARGET_LENGTH + 20 || isFlattening.current) return

        const flatten = async () => {
            isFlattening.current = true
            try {
                // Keep the last TARGET_LENGTH items active
                const splitIndex = history.length - TARGET_LENGTH
                const toFlatten = history.slice(0, splitIndex)
                
                const snapshot = await createSnapshot(toFlatten, nanoid(), imageCache.current)
                
                // Pre-load the new snapshot image
                const img = new Image()
                img.src = snapshot.dataUrl
                await new Promise<void>(resolve => {
                    img.onload = () => resolve()
                    img.onerror = () => resolve()
                })
                imageCache.current.set(snapshot.id, img)
                
                setHistory((prev) => {
                    // Abort if history has changed too much
                    if (prev.length < splitIndex) return prev
                    
                    // Replace the flattened items with the new snapshot
                    return [snapshot, ...prev.slice(splitIndex)]
                })
            } finally {
                isFlattening.current = false
            }
        }
        
        flatten()
    }, [history, setHistory])

    const activePointers = useRef(new Map<number, { clientX: number, clientY: number }>())
    const isGesturing = useRef(false)
    const gestureStart = useRef({
        zoom: 1,
        distance: 0,
        center: { clientX: 0, clientY: 0 },
        pan: { x: 0, y: 0 }
    })

    const size = brush === 'pen' ? penSize : eraserSize
    const setSize = brush === 'pen' ? setPenSize : setEraserSize
    const minSize = 2
    const maxSize = brush === 'pen' ? 30 : 80

    const cursor = useMemo(() => {
        if (brush === 'kitty') {
            return 'crosshair'
        } else {
            const actualSize = size * position.zoom
            const r = actualSize / 2
            const svgSize = Math.ceil(actualSize + 4)

            const svg = `
                <svg xmlns='http://www.w3.org/2000/svg' width='${svgSize}' height='${svgSize}'>
                    <circle
                        cx='${svgSize / 2}'
                        cy='${svgSize / 2}'
                        r='${r}'
                        stroke='black'
                        stroke-width='1.5'
                        fill='${brush === 'pen' ? 'blank' : 'white'}'
                    />
                </svg>
            `
        
            const encoded = encodeURIComponent(svg.replace(/[\r\n]+/g, '').trim())
            return `url("data:image/svg+xml;utf8,${encoded}") ${svgSize / 2} ${svgSize / 2}, auto`
        }
    }, [size, position.zoom, brush])

    function renderActiveStrokes() {
        const canvas = activeCanvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        const dpr = window.devicePixelRatio || 1
        
        // Reset transform and clear
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        
        // Apply transforms
        ctx.scale(dpr, dpr)
        ctx.translate(-position.x, -position.y)
        ctx.scale(position.zoom, position.zoom)

        // Draw in-progress
        if (inProgress.current.size > 0) {
            if (brush === 'kitty') {
                ctx.globalCompositeOperation = 'source-over'
                
                for (const points of inProgress.current.values()) {
                    const point = points[0]
                    if (!point) continue
                    ctx.drawImage(kitty, point.x - kittySize / 2, point.y - kittySize / 2, kittySize, kittySize)
                }

                return
            }

            const inProgressPaths = [...inProgress.current.values()].map(points => pointsToPath(points, size))
            
            if (brush === 'eraser') {
                // For erasing, we draw white on the active layer to simulate looking through to background
                ctx.fillStyle = 'white'
                ctx.globalCompositeOperation = 'source-over'
            } else {
                ctx.fillStyle = 'black'
                ctx.globalCompositeOperation = 'source-over'
            }
            
            for (const path of inProgressPaths) renderPath(ctx, path)
        }
    }

    useEffect(() => {
        function onWheel(event: WheelEvent) {
            event.preventDefault()
            setPosition(produce((draft) => {
                if (event.ctrlKey) {
                    const mouseXWorld = (event.clientX + draft.x) / draft.zoom
                    const mouseYWorld = (event.clientY + draft.y) / draft.zoom

                    const zoomChange = 1 - event.deltaY * 0.01
                    const newZoom = Math.max(Math.min(draft.zoom * zoomChange, 15), 0.05)
                    
                    draft.zoom = newZoom
                    draft.x = (mouseXWorld * newZoom) - event.clientX
                    draft.y = (mouseYWorld * newZoom) - event.clientY
                } else {
                    draft.x += event.deltaX
                    draft.y += event.deltaY
                }
            }))
        }

        function onKeyDown(event: KeyboardEvent) {
            if (event.target instanceof HTMLInputElement) return

            let shortcut: 'undo' | 'redo' | null = null
            if (event.ctrlKey || event.metaKey) {
                if (event.code === 'KeyZ') {
                    shortcut = event.shiftKey ? 'redo' : 'undo'
                } else if (event.code === 'KeyY') {
                    shortcut = 'redo'
                }
            }

            if (shortcut === 'undo') {
                event.preventDefault()
                setHistory((history) => {
                    if (history.length === 0) return history
                    redo.current.unshift(history.at(-1)!)
                    return history.slice(0, -1)
                })
            } else if (shortcut === 'redo') {
                event.preventDefault()
                if (redo.current.length > 0) {
                    setHistory((history) => [...history, redo.current.shift()!])
                }
            }
        }

        containerRef.current?.addEventListener('wheel', onWheel, { passive: false })
        window.addEventListener('keydown', onKeyDown)

        return () => {
            containerRef.current?.removeEventListener('wheel', onWheel)
            window.removeEventListener('keydown', onKeyDown)
        }
    }, [])

    const [resizeTrigger, setResizeTrigger] = useState(0)

    const prevHistoryRef = useRef<Action[]>([])
    const prevPositionRef = useRef<CanvasPosition>(position)
    const prevResizeTriggerRef = useRef<number>(0)

    useEffect(() => {
        const staticCanvas = staticCanvasRef.current
        const activeCanvas = activeCanvasRef.current
        const container = containerRef.current
        if (!staticCanvas || !activeCanvas || !container) return

        const updateSize = () => {
            const dpr = window.devicePixelRatio || 1
            const width = container.clientWidth
            const height = container.clientHeight
            
            staticCanvas.width = width * dpr
            staticCanvas.height = height * dpr
            staticCanvas.style.width = `${width}px`
            staticCanvas.style.height = `${height}px`
            
            activeCanvas.width = width * dpr
            activeCanvas.height = height * dpr
            activeCanvas.style.width = `${width}px`
            activeCanvas.style.height = `${height}px`

            setResizeTrigger((n) => n + 1)
        }
        
        updateSize()

        const observer = new ResizeObserver(updateSize)
        observer.observe(container)
        
        return () => observer.disconnect()
    }, [])

    useEffect(() => {
        console.log('History length:', history.length)
    }, [history.length])

    // Render static history
    useEffect(() => {
        const canvas = staticCanvasRef.current
        if (!canvas || !containerRef.current) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        // Use lower quality during gestures for performance
        const targetDpr = isGesturing.current ? 0.75 : (window.devicePixelRatio || 1)
        
        // Ensure canvas size matches target DPR
        const width = containerRef.current.clientWidth
        const height = containerRef.current.clientHeight
        const sizeChanged = canvas.width !== width * targetDpr || canvas.height !== height * targetDpr

        if (sizeChanged) {
            canvas.width = width * targetDpr
            canvas.height = height * targetDpr
            canvas.style.width = `${width}px`
            canvas.style.height = `${height}px`
        }

        const dpr = targetDpr
        
        const isResize = resizeTrigger !== prevResizeTriggerRef.current
        const posChanged = position.x !== prevPositionRef.current.x || 
                           position.y !== prevPositionRef.current.y || 
                           position.zoom !== prevPositionRef.current.zoom

        if (isResize || posChanged || sizeChanged) {
            // Full redraw

            ctx.setTransform(1, 0, 0, 1, 0, 0)
            ctx.clearRect(0, 0, canvas.width, canvas.height)
            ctx.scale(dpr, dpr)
            ctx.translate(-position.x, -position.y)
            ctx.scale(position.zoom, position.zoom)
            renderActions(ctx, history, imageCache.current)
        } else {
            // Check for incremental update
            const prev = prevHistoryRef.current
            const curr = history
            let match = true
            let i = 0
            
            // Find the first point of divergence
            for (; i < prev.length; i++) {
                if (i >= curr.length || prev[i] !== curr[i]) {
                    match = false
                    break
                }
            }

            if (match) {
                // Draw new items only
                ctx.setTransform(1, 0, 0, 1, 0, 0)
                ctx.scale(dpr, dpr)
                ctx.translate(-position.x, -position.y)
                ctx.scale(position.zoom, position.zoom)

                for (let j = i; j < curr.length; j++) {
                    const action = curr[j]!
                    renderAction(ctx, action, imageCache.current)
                }
            } else {
                // Full redraw
                ctx.setTransform(1, 0, 0, 1, 0, 0)
                ctx.clearRect(0, 0, canvas.width, canvas.height)
                ctx.scale(dpr, dpr)
                ctx.translate(-position.x, -position.y)
                ctx.scale(position.zoom, position.zoom)
                renderActions(ctx, history, imageCache.current)
            }
        }

        prevHistoryRef.current = history
        prevPositionRef.current = position
        prevResizeTriggerRef.current = resizeTrigger
        
    }, [history, position, resizeTrigger])

    // Re-render active strokes when view changes
    useEffect(() => {
        renderActiveStrokes()
    }, [position, size, brush, resizeTrigger])

    function commitStroke(pointerId: number) {
        if (brush === 'kitty') {
            const point = inProgress.current.get(pointerId)![0]
            if (!point) return

            redo.current = []
            setHistory(produce((draft) => {
                draft.push({
                    id: nanoid(),
                    kind: 'kitty',
                    x: point.x,
                    y: point.y,
                })
            }))
            inProgress.current.set(pointerId, [])

            return
        }

        const stroke = pointsToPath(inProgress.current.get(pointerId)!, size)
        redo.current = []
        setHistory(produce((draft) => {
            draft.push({
                id: nanoid(),
                kind: brush,
                path: stroke,
            })
        }))
        inProgress.current.set(pointerId, [])
    }

    return (
        <div>
            <div className='photograph-a'><Photograph /></div>
            <div className='photograph-b'><Photograph /></div>

            <div className='toolbar'>
                <div className='tools'>
                    <ToolbarButton
                        isActive={brush === 'pen'}
                        onActivate={() => {
                            // This will create duplicate history entries per stroke but this simplification
                            // is acceptable for now, since this is an edge case and drawing with multiple
                            // pointers isn't even a thing right now.
                            for (const pointerId of inProgress.current.keys()) commitStroke(pointerId)
                            renderActiveStrokes()
                            setBrush('pen')
                        }}
                        Icon={FaPenFancy}
                    />
                    <ToolbarButton
                        isActive={brush === 'eraser'}
                        onActivate={() => {
                            // See above.
                            for (const pointerId of inProgress.current.keys()) commitStroke(pointerId)
                            renderActiveStrokes()
                            setBrush('eraser')
                        }}
                        Icon={FaEraser}
                    />
                    <ToolbarButton
                        isActive={brush === 'kitty'}
                        onActivate={() => {
                            // See above.
                            for (const pointerId of inProgress.current.keys()) commitStroke(pointerId)
                            renderActiveStrokes()
                            setBrush('kitty')
                        }}
                        Icon={FaCat}
                    />

                    <div className='divider' />

                    <div className='size-container'>
                        <input
                            type='range'
                            min={minSize * 1000}
                            max={maxSize * 1000}
                            value={size * 1000}
                            disabled={brush === 'kitty'}
                            onChange={(event) => setSize(parseInt(event.target.value, 10) / 1000)}
                        />

                        <div className='preview-container' style={{
                            width: `${maxSize * position.zoom}px`,
                            height: `${maxSize * position.zoom}px`,
                            bottom: `-${maxSize * position.zoom + 35}px`,
                        }}>
                            <div className={`preview ${brush}`} style={{
                                width: `${size * position.zoom}px`,
                                height: `${size * position.zoom}px`,
                            }} />
                        </div>
                    </div>
                </div>
                <button onClick={async () => {
                    const blob = await exportAsPng(history)
                    setSharingBlob(blob)
                }}>
                    SHARE<span className='mobile-hidden'> WITH PEOPLE</span>
                </button>
            </div>

            <div
                ref={containerRef}
                onContextMenu={(event) => event.preventDefault()}
                onPointerDown={(event) => {
                    event.preventDefault()
                    containerRef.current?.setPointerCapture(event.pointerId)

                    activePointers.current.set(event.pointerId, {
                        clientX: event.clientX,
                        clientY: event.clientY,
                    })

                    if (activePointers.current.size === 2) {
                        // Start gesture
                        isGesturing.current = true
                        inProgress.current.clear() // Cancel any drawing
                        renderActiveStrokes()

                        const pointers = [...activePointers.current.values()]
                        const p1 = pointers[0]!
                        const p2 = pointers[1]!
                        const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY)
                        const center = {
                            clientX: (p1.clientX + p2.clientX) / 2,
                            clientY: (p1.clientY + p2.clientY) / 2,
                        }

                        gestureStart.current = {
                            zoom: position.zoom,
                            distance: dist,
                            center,
                            pan: { x: position.x, y: position.y },
                        }
                    } else if (!isGesturing.current) {
                        inProgress.current.set(event.pointerId, [
                            {
                                x: (event.clientX + position.x) / position.zoom,
                                y: (event.clientY + position.y) / position.zoom,
                                pressure: event.pressure,
                            },
                        ])
                        renderActiveStrokes()
                    }
                }}
                onPointerMove={(event) => {
                    activePointers.current.set(event.pointerId, {
                        clientX: event.clientX,
                        clientY: event.clientY,
                    })

                    if (isGesturing.current && activePointers.current.size === 2) {
                        const pointers = [...activePointers.current.values()]
                        const p1 = pointers[0]!
                        const p2 = pointers[1]!
                        const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY)
                        const center = {
                            clientX: (p1.clientX + p2.clientX) / 2,
                            clientY: (p1.clientY + p2.clientY) / 2,
                        }

                        const start = gestureStart.current
                        const scale = dist / start.distance
                        const newZoom = Math.max(Math.min(start.zoom * scale, 15), 0.05)

                        const worldX = (start.center.clientX + start.pan.x) / start.zoom
                        const worldY = (start.center.clientY + start.pan.y) / start.zoom

                        // New top-left position:
                        const newX = (worldX * newZoom) - center.clientX
                        const newY = (worldY * newZoom) - center.clientY

                        setPosition({
                            zoom: newZoom,
                            x: newX,
                            y: newY,
                        })
                        return
                    }

                    const line = inProgress.current.get(event.pointerId)
                    if (!line) return

                    line.push({
                        x: (event.clientX + position.x) / position.zoom,
                        y: (event.clientY + position.y) / position.zoom,
                        pressure: event.pressure,
                    })
                    
                    renderActiveStrokes()
                }}
                onPointerUp={(event) => {
                    containerRef.current?.releasePointerCapture(event.pointerId)
                    activePointers.current.delete(event.pointerId)
                    
                    if (activePointers.current.size < 2) {
                        if (isGesturing.current) {
                            isGesturing.current = false
                            setResizeTrigger((n) => n + 1)
                        }
                    }

                    if (inProgress.current.has(event.pointerId)) {
                        commitStroke(event.pointerId)
                        inProgress.current.delete(event.pointerId)
                        renderActiveStrokes()
                    }
                }}
                onPointerCancel={(event) => {
                    containerRef.current?.releasePointerCapture(event.pointerId)
                    activePointers.current.delete(event.pointerId)
                    
                    if (activePointers.current.size < 2) {
                        if (isGesturing.current) {
                            isGesturing.current = false
                            setResizeTrigger((n) => n + 1)
                        }
                    }

                    inProgress.current.delete(event.pointerId)
                    renderActiveStrokes()
                }}
                className='container'
                style={{ cursor }}
            >
                <canvas ref={staticCanvasRef} />
                <canvas ref={activeCanvasRef} />
            </div>

            {sharingBlob && <SharingModal pngBlob={sharingBlob} onClose={() => setSharingBlob(null)} />}
        </div>
    )
}


interface ToolbarButtonProps {
    isActive: boolean
    onActivate: () => void
    Icon: IconType
}

function ToolbarButton({ isActive, onActivate, Icon }: ToolbarButtonProps) {
    const [pressedPointers, setPressedPointers] = useState(0)
    const isPressed = pressedPointers > 0

    return (
        <button
            className={`${isActive ? 'active' : ''} ${isPressed ? 'pressed' : ''}`}
            onPointerDown={(event) => {
                setPressedPointers(pressedPointers + 1)
                
                function onPointerUp(newEvent: PointerEvent) {
                    if (newEvent.pointerId === event.pointerId) {
                        setPressedPointers((pressedPointers) => pressedPointers - 1)
                        window.removeEventListener('pointerup', onPointerUp)
                        window.removeEventListener('pointercancel', onPointerUp)

                        if (newEvent.target === event.target
                            && document.elementFromPoint(newEvent.clientX, newEvent.clientY) === event.target) {
                            // This will lead to double activation, but that's fine for toolbar icons.
                            onActivate()
                        }
                    }
                }
                function onPointerCancel(newEvent: PointerEvent) {
                    if (newEvent.pointerId === event.pointerId) {
                        setPressedPointers((pressedPointers) => pressedPointers - 1)
                        window.removeEventListener('pointerup', onPointerUp)
                        window.removeEventListener('pointercancel', onPointerCancel)
                    }
                }

                window.addEventListener('pointerup', onPointerUp)
                window.addEventListener('pointercancel', onPointerCancel)
            }}
            onClick={() => onActivate()}
        >
            <Icon />
        </button>
    )
}