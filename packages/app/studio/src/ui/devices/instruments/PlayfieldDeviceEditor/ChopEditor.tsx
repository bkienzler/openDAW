import css from "./ChopEditor.sass?inline"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {clamp, DefaultObservableValue, int, Lifecycle, Option, Terminable, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {AudioFileBoxAdapter, PlayfieldDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {AudioFileBox, PlayfieldSampleBox} from "@opendaw/studio-boxes"
import {CanvasPainter} from "@opendaw/studio-core"
import {PeaksPainter} from "@opendaw/lib-fusion"
import {SampleSelector} from "@/ui/devices/SampleSelector"

const className = Html.adoptStyleSheet(css, "ChopEditor")

const HIT_PX = 8

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: PlayfieldDeviceBoxAdapter
    octave: DefaultObservableValue<int>
}

export const ChopEditor = ({lifecycle, service, adapter, octave}: Construct) => {
    const {project} = service
    const {editing, boxAdapters} = project
    const currentFile = new DefaultObservableValue<Option<AudioFileBox>>(Option.None)
    const trimStart = new DefaultObservableValue(0.0)
    const trimEnd = new DefaultObservableValue(1.0)
    const markers = new DefaultObservableValue<ReadonlyArray<number>>([])
    const canvas: HTMLCanvasElement = <canvas/>
    const fileLabel: HTMLElement = <div className="file-label">Drop sample here or click Browse</div>
    const applyButton: HTMLButtonElement = <button className="apply-btn" disabled>Apply to Pads</button>
    const browseButton: HTMLButtonElement = <button className="browse-btn">Browse…</button>
    const getFileAdapter = (): Option<AudioFileBoxAdapter> =>
        currentFile.getValue().map(box => boxAdapters.adapterFor(box, AudioFileBoxAdapter))
    const paintWaveform = ({context, width, height}: CanvasPainter): void => {
        context.clearRect(0, 0, width, height)
        getFileAdapter().ifSome(fileAdapter => fileAdapter.getOrCreateLoader().peaks.ifSome(peaks => {
            const {numFrames, numChannels} = peaks
            const wd = width * devicePixelRatio
            const hd = height * devicePixelRatio
            const s0 = trimStart.getValue()
            const s1 = trimEnd.getValue()
            const x0 = s0 * wd
            const x1 = s1 * wd
            const u0 = s0 * numFrames
            const u1 = s1 * numFrames
            const rowHeight = hd / numChannels
            context.fillStyle = "hsl(220, 80%, 70%)"
            for (let channelIndex = 0; channelIndex < numChannels; channelIndex++) {
                peaksLayout.u0 = u0; peaksLayout.u1 = u1
                peaksLayout.x0 = x0; peaksLayout.x1 = x1
                peaksLayout.y0 = rowHeight * channelIndex; peaksLayout.y1 = rowHeight * (channelIndex + 1)
                PeaksPainter.renderPixelStrips(context, peaks, channelIndex, peaksLayout)
            }
            if (u0 > 0) {
                context.globalAlpha = 0.25
                for (let channelIndex = 0; channelIndex < numChannels; channelIndex++) {
                    peaksLayout.u0 = 0; peaksLayout.u1 = u0
                    peaksLayout.x0 = 0; peaksLayout.x1 = x0
                    peaksLayout.y0 = rowHeight * channelIndex; peaksLayout.y1 = rowHeight * (channelIndex + 1)
                    PeaksPainter.renderPixelStrips(context, peaks, channelIndex, peaksLayout)
                }
                context.globalAlpha = 1.0
            }
            if (u1 < numFrames) {
                context.globalAlpha = 0.25
                for (let channelIndex = 0; channelIndex < numChannels; channelIndex++) {
                    peaksLayout.u0 = u1; peaksLayout.u1 = numFrames
                    peaksLayout.x0 = x1; peaksLayout.x1 = wd
                    peaksLayout.y0 = rowHeight * channelIndex; peaksLayout.y1 = rowHeight * (channelIndex + 1)
                    PeaksPainter.renderPixelStrips(context, peaks, channelIndex, peaksLayout)
                }
                context.globalAlpha = 1.0
            }
            context.fillStyle = "rgba(255,255,255,0.9)"
            context.fillRect(Math.round(x0), 0, 2, hd)
            context.fillRect(Math.round(x1) - 1, 0, 2, hd)
            context.fillStyle = "#ffcc00"
            for (const markerPos of markers.getValue()) {
                context.fillRect(Math.round(markerPos * wd), 0, 1, hd)
            }
        }))
    }
    const waveformPainter = new CanvasPainter(canvas, paintWaveform)
    const sampleSelector = new SampleSelector(service, {
        isAttached: (): boolean => adapter.box.isAttached(),
        hasSample: (): boolean => currentFile.getValue().nonEmpty(),
        replace: (replacement: Option<AudioFileBox>): void => {
            currentFile.setValue(replacement)
            trimStart.setValue(0.0)
            trimEnd.setValue(1.0)
            markers.setValue([])
        }
    })
    const nearestTrimHandle = (clientX: number): Option<{dir: "start" | "end", offset: number}> => {
        const {left, width} = canvas.getBoundingClientRect()
        const dl = clientX - (left + trimStart.getValue() * width)
        const dr = clientX - (left + trimEnd.getValue() * width)
        const distL = Math.abs(dl)
        const distR = Math.abs(dr)
        if (distL <= HIT_PX && distL <= distR) {return Option.wrap({dir: "start", offset: dl})}
        if (distR <= HIT_PX) {return Option.wrap({dir: "end", offset: dr})}
        return Option.None
    }
    const nearestMarkerIndex = (clientX: number): number => {
        const {left, width} = canvas.getBoundingClientRect()
        const threshold = HIT_PX / width
        const pos = (clientX - left) / width
        const currentMarkers = markers.getValue()
        let bestIndex = -1
        let bestDist = threshold
        for (let markerIndex = 0; markerIndex < currentMarkers.length; markerIndex++) {
            const dist = Math.abs(currentMarkers[markerIndex] - pos)
            if (dist < bestDist) {bestDist = dist; bestIndex = markerIndex}
        }
        return bestIndex
    }
    const makeTrimDrag = (dir: "start" | "end", offset: number): Dragging.Process => ({
        update: (dragEvent: Dragging.Event): void => {
            const {left, width} = canvas.getBoundingClientRect()
            const ratio = clamp((dragEvent.clientX - offset - left) / width, 0.0, 1.0)
            if (dir === "start") {trimStart.setValue(Math.min(ratio, trimEnd.getValue()))}
            else {trimEnd.setValue(Math.max(ratio, trimStart.getValue()))}
        },
        cancel: (): void => {},
        approve: (): void => {}
    })
    const makeMarkerDrag = (markerIdx: int): Dragging.Process => ({
        update: (dragEvent: Dragging.Event): void => {
            const {left, width} = canvas.getBoundingClientRect()
            const pos = clamp((dragEvent.clientX - left) / width, 0.0, 1.0)
            const arr = [...markers.getValue()]
            arr[markerIdx] = pos
            markers.setValue(arr)
        },
        cancel: (): void => {},
        approve: (): void => {}
    })
    const makeNewMarkerDrag = (clickX: number): Dragging.Process => {
        const {left, width} = canvas.getBoundingClientRect()
        const newPos = clamp((clickX - left) / width, 0.0, 1.0)
        const withNew = [...markers.getValue(), newPos]
        const newIdx = withNew.length - 1
        markers.setValue(withNew)
        return {
            update: (dragEvent: Dragging.Event): void => {
                const {left: dragLeft, width: dragWidth} = canvas.getBoundingClientRect()
                const pos = clamp((dragEvent.clientX - dragLeft) / dragWidth, 0.0, 1.0)
                const arr = [...markers.getValue()]
                arr[newIdx] = pos
                markers.setValue(arr)
            },
            cancel: (): void => {
                const remaining = [...markers.getValue()]
                remaining.splice(newIdx, 1)
                markers.setValue(remaining)
            },
            approve: (): void => {}
        }
    }
    const applyToPads = (): void => {
        currentFile.getValue().ifSome(audioFileBox => {
            const s0 = trimStart.getValue()
            const s1 = trimEnd.getValue()
            const sorted = [...markers.getValue()].sort((posA, posB) => posA - posB).filter(pos => pos > s0 && pos < s1)
            const boundaries = [s0, ...sorted, s1]
            editing.modify(() => {
                for (let sliceIndex = 0; sliceIndex < boundaries.length - 1; sliceIndex++) {
                    const padIndex = octave.getValue() * 12 + sliceIndex
                    if (padIndex > 127) {break}
                    const sliceStart = boundaries[sliceIndex]
                    const sliceEnd = boundaries[sliceIndex + 1]
                    const existingOpt = adapter.samples.getAdapterByIndex(padIndex)
                    existingOpt.ifSome(existing => {
                        existing.box.file.refer(audioFileBox)
                        existing.box.sampleStart.setValue(sliceStart)
                        existing.box.sampleEnd.setValue(sliceEnd)
                    })
                    if (existingOpt.isEmpty()) {
                        PlayfieldSampleBox.create(project.boxGraph, UUID.generate(), box => {
                            box.file.refer(audioFileBox)
                            box.device.refer(adapter.box.samples)
                            box.index.setValue(padIndex)
                            box.sampleStart.setValue(sliceStart)
                            box.sampleEnd.setValue(sliceEnd)
                        })
                    }
                }
            })
        })
    }
    let loaderSubscription: Terminable = Terminable.Empty
    lifecycle.ownAll(
        waveformPainter,
        sampleSelector.configureDrop(canvas),
        sampleSelector.configureBrowseClick(browseButton),
        currentFile.catchupAndSubscribe(owner => {
            loaderSubscription.terminate()
            const file = owner.getValue()
            const hasFile = file.nonEmpty()
            applyButton.disabled = !hasFile
            file.ifSome(box => {fileLabel.textContent = box.fileName.getValue()})
            if (!hasFile) {fileLabel.textContent = "Drop sample here or click Browse"}
            getFileAdapter().ifSome(fileAdapter => {
                loaderSubscription = fileAdapter.getOrCreateLoader().subscribe(state => {
                    if (state.type === "loaded") {waveformPainter.requestUpdate()}
                })
            })
        }),
        trimStart.subscribe(waveformPainter.requestUpdate),
        trimEnd.subscribe(waveformPainter.requestUpdate),
        markers.subscribe(waveformPainter.requestUpdate),
        Events.subscribe(applyButton, "click", applyToPads),
        Events.subscribe(canvas, "contextmenu", (event: MouseEvent) => {
            event.preventDefault()
            const markerIdx = nearestMarkerIndex(event.clientX)
            if (markerIdx !== -1) {
                const remaining = [...markers.getValue()]
                remaining.splice(markerIdx, 1)
                markers.setValue(remaining)
            }
        }),
        Dragging.attach(canvas, (pointerEvent: PointerEvent) => {
            return nearestTrimHandle(pointerEvent.clientX).match({
                some: ({dir, offset}) => Option.wrap(makeTrimDrag(dir, offset)),
                none: () => {
                    const markerIdx = nearestMarkerIndex(pointerEvent.clientX)
                    if (markerIdx !== -1) {return Option.wrap(makeMarkerDrag(markerIdx))}
                    return Option.wrap(makeNewMarkerDrag(pointerEvent.clientX))
                }
            })
        }),
        {terminate: (): void => {loaderSubscription.terminate()}}
    )
    return (
        <div className={className}>
            <div className="waveform-area">
                {canvas}
            </div>
            <div className="toolbar">
                {fileLabel}
                {browseButton}
                {applyButton}
            </div>
        </div>
    )
}

const peaksLayout: PeaksPainter.Layout = {u0: 0.0, u1: 0.0, x0: 0.0, x1: 0.0, v0: +1.1, v1: -1.1, y0: 0.0, y1: 0.0}
