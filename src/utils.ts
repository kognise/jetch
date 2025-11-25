import getStroke from 'perfect-freehand'
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import kittyPath from './kitty.png'

export const kitty = new Image()
kitty.src = kittyPath
await new Promise<void>((resolve, reject) => {
    kitty.onload = () => resolve()
    kitty.onerror = () => reject()
})
export const kittySize = 50

export interface Point {
    x: number
    y: number
    pressure?: number
}

export interface StrokeAction {
    id: string
    kind: 'pen' | 'eraser'
    path: [number, number][]
}

export interface KittyAction {
    id: string
    kind: 'kitty'
    x: number
    y: number
}

export interface SnapshotAction {
    id: string
    kind: 'snapshot'
    dataUrl: string
    x: number
    y: number
    width: number
    height: number
}

export type Action = StrokeAction | SnapshotAction | KittyAction

export function pointsToPath(points: Point[], size: number): [number, number][] {
    if (points.length === 0) return []
    if (points.length === 1) {
        return getStroke(points, {
            size,
            thinning: 0,
            streamline: 1,
            smoothing: 1,
        }) satisfies number[][] as [number, number][]
    }
    return getStroke(points, {
        size,
        thinning: 0.25,
        streamline: 0.5,
        smoothing: 0.5,
    }) satisfies number[][] as [number, number][]
}

export function renderPath(ctx: CanvasRenderingContext2D, points: [number, number][]) {
    if (points.length < 2) return

    ctx.beginPath()
    const p0 = points[0]!
    ctx.moveTo(p0[0], p0[1])
    
    for (let i = 0; i < points.length - 1; i++) {
        const [x0, y0] = points[i]!
        const [x1, y1] = points[i+1]!
        const midX = (x0 + x1) / 2
        const midY = (y0 + y1) / 2
        ctx.quadraticCurveTo(x0, y0, midX, midY)
    }
    
    ctx.closePath()
    ctx.fill()
}

export async function createSnapshot(
    actions: Action[],
    id: string,
    imageCache?: Map<string, HTMLImageElement>,
    scale: number = 2
): Promise<SnapshotAction> {
    const bounds = getHistoryBounds(actions)
    const width = Math.ceil(bounds.maxX - bounds.minX)
    const height = Math.ceil(bounds.maxY - bounds.minY)
    
    // Handle empty case
    if (width <= 0 || height <= 0) {
        return {
            id,
            kind: 'snapshot',
            dataUrl: '',
            x: 0,
            y: 0,
            width: 0,
            height: 0
        }
    }

    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const ctx = canvas.getContext('2d')!
    
    ctx.scale(scale, scale)
    ctx.translate(-bounds.minX, -bounds.minY)
    
    // Load images if needed
    const tempCache = new Map(imageCache) // Copy existing cache
    await Promise.all(actions.map(action => {
        if (action.kind === 'snapshot' && !tempCache.has(action.id)) {
            return new Promise<void>((resolve) => {
                const img = new Image()
                img.onload = () => {
                    tempCache.set(action.id, img)
                    resolve()
                }
                img.onerror = () => resolve() // Skip failed
                img.src = action.dataUrl
            })
        }
    }))

    renderActions(ctx, actions, tempCache)
    
    return {
        id,
        kind: 'snapshot',
        dataUrl: canvas.toDataURL(),
        x: bounds.minX,
        y: bounds.minY,
        width,
        height
    }
}

export function renderAction(
    ctx: CanvasRenderingContext2D,
    action: Action,
    imageCache?: Map<string, HTMLImageElement>,
) {
    if (action.kind === 'snapshot') {
        ctx.globalCompositeOperation = 'source-over'
        const img = imageCache?.get(action.id)
        if (img && img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, action.x, action.y, action.width, action.height)
        }
    } else if (action.kind === 'kitty') {
        ctx.globalCompositeOperation = 'source-over'
        ctx.drawImage(kitty, action.x - kittySize / 2, action.y - kittySize / 2, kittySize, kittySize)
    } else {
        ctx.fillStyle = 'black'
        ctx.globalCompositeOperation = action.kind === 'eraser' ? 'destination-out' : 'source-over'
        renderPath(ctx, action.path)
    }
}

export function renderActions(
    ctx: CanvasRenderingContext2D,
    history: Action[],
    imageCache?: Map<string, HTMLImageElement>
) {
    for (const action of history) renderAction(ctx, action, imageCache)
}

export function pathToSvgD(points: [number, number][]): string {
    if (points.length === 0) return ''

    return points
        .reduce(
            (acc, [x0, y0], i, arr) => {
                if (i === arr.length - 1) return acc
                const [x1, y1] = arr[i + 1]!
                return acc.concat(` ${x0},${y0} ${(x0 + x1) / 2},${(y0 + y1) / 2}`)
            },
            ['M ', `${points[0]![0]},${points[0]![1]}`, ' Q']
        )
        .concat('Z')
        .join('')
}

export function getBounds(points: [number, number][]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of points) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
    }
    return { minX, minY, maxX, maxY }
}

export function getActionBounds(action: Action) {
    if (action.kind === 'snapshot') {
        return {
            minX: action.x,
            minY: action.y,
            maxX: action.x + action.width,
            maxY: action.y + action.height
        }
    }
    if (action.kind === 'kitty') {
        return {
            minX: action.x - kittySize / 2,
            minY: action.y - kittySize / 2,
            maxX: action.x + kittySize / 2,
            maxY: action.y + kittySize / 2
        }
    }
    return getBounds(action.path)
}

export function getHistoryBounds(history: Action[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let hasContent = false

    for (const action of history) {
        // Erasers don't expand bounds, but snapshots and pens do
        if (action.kind !== 'eraser') {
            const b = getActionBounds(action)
            if (b.minX < minX) minX = b.minX
            if (b.minY < minY) minY = b.minY
            if (b.maxX > maxX) maxX = b.maxX
            if (b.maxY > maxY) maxY = b.maxY
            hasContent = true
        }
    }

    if (!hasContent) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    }

    return { minX, minY, maxX, maxY }
}

export async function exportAsPng(history: Action[]): Promise<Blob> {
    const { minX, minY, maxX, maxY } = getHistoryBounds(history)
    
    const padding = 20
    const width = Math.ceil(maxX - minX + padding * 2)
    const height = Math.ceil(maxY - minY + padding * 2)
    
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    
    // Translate to center the content with padding
    ctx.translate(-minX + padding, -minY + padding)
    
    // Ensure all snapshot images are loaded for export
    const imageCache = new Map<string, HTMLImageElement>()
    await Promise.all(history.map((action) => {
        if (action.kind === 'snapshot') {
            return new Promise<void>((resolve) => {
                const img = new Image()
                img.onload = () => {
                    imageCache.set(action.id, img)
                    resolve()
                }
                img.onerror = () => resolve() // Skip failed
                img.src = action.dataUrl
            })
        }
    }))

    renderActions(ctx, history, imageCache)
    
    const imageData = ctx.getImageData(0, 0, width, height)
    const data = imageData.data
    
    // Crop transparent pixels
    let cMinX = width
    let cMinY = height
    let cMaxX = 0
    let cMaxY = 0
    let found = false

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const alpha = data[(y * width + x) * 4 + 3]!
            if (alpha > 0) {
                if (x < cMinX) cMinX = x
                if (x > cMaxX) cMaxX = x
                if (y < cMinY) cMinY = y
                if (y > cMaxY) cMaxY = y
                found = true
            }
        }
    }

    const cropWidth = found ? cMaxX - cMinX + 1 : 0
    const cropHeight = found ? cMaxY - cMinY + 1 : 0

    const MAX_DIMENSION = 2000
    const scale = Math.min(4, MAX_DIMENSION / cropWidth, MAX_DIMENSION / cropHeight)
    const finalWidth = Math.floor(cropWidth * scale)
    const finalHeight = Math.floor(cropHeight * scale)

    const outputCanvas = document.createElement('canvas')
    outputCanvas.width = finalWidth + padding * 2
    outputCanvas.height = finalHeight + padding * 2
    const outCtx = outputCanvas.getContext('2d')!

    outCtx.fillStyle = '#ffffff'
    outCtx.fillRect(0, 0, outputCanvas.width, outputCanvas.height)

    if (found) {
        const contentCanvas = document.createElement('canvas')
        contentCanvas.width = finalWidth
        contentCanvas.height = finalHeight
        const contentCtx = contentCanvas.getContext('2d')!
        
        contentCtx.scale(scale, scale)
        contentCtx.translate(-(cMinX + minX - padding), -(cMinY + minY - padding))
        
        renderActions(contentCtx, history, imageCache)
        
        outCtx.drawImage(contentCanvas, padding, padding)
    }
    
    return new Promise<Blob>((resolve, reject) => {
        outputCanvas.toBlob((canvasBlob) => {
            if (canvasBlob) {
                resolve(canvasBlob)
            } else {
                reject(new Error('Canvas to Blob failed'))
            }
        })
    })
}

export interface CanvasPosition {
    zoom: number
    x: number
    y: number
}

export type Brush = 'pen' | 'eraser' | 'kitty'

export function useLocalState<Type>(
    key: string,
    defaultValue: Type
): [Type, Dispatch<SetStateAction<Type>>] {
    const [state, setState] = useState<Type>(() => {
        const stored = localStorage.getItem(key)
        if (stored !== null) return JSON.parse(stored)
        return defaultValue
    })

    useEffect(() => {
        localStorage.setItem(key, JSON.stringify(state))
    }, [state])

    return [state, setState]
}

export function useBlobjectUrl(blob: Blob): string | null {
    const [url, setUrl] = useState<string | null>(null)
    useEffect(() => {
        const objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
        return () => {
            URL.revokeObjectURL(objectUrl)
        }
    }, [blob])
    return url
}