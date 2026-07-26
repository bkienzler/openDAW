import css from "./SampleEditDialog.sass?inline"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {Arrays, clamp, DefaultObservableValue, int, isDefined, Lifecycle, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {NoteLifeCycle, PlayfieldDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {AudioFileBox, PlayfieldSampleBox} from "@opendaw/studio-boxes"
import {CanvasPainter} from "@opendaw/studio-core"
import {PeaksPainter} from "@opendaw/lib-fusion"
import {MidiKeys} from "@opendaw/lib-dsp"
import {SampleSelector} from "@/ui/devices/SampleSelector"
import {SlotUtils} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotUtils"

const className = Html.adoptStyleSheet(css, "SampleEditDialog")

const HIT_PX = 8
const MIN_VIEW_RANGE = 0.001
const ZOOM_FACTOR = 0.8
const SNAP_PX = 12
const FLAG_H_PX = 12
const FLAG_W_PX = 8

export type ChopBoundary = {end: number, start: number}
export type LoadedSample = {uuid: UUID.Bytes, name: string, endInSeconds: number}

type EditMode = "edit" | "chop"
type ChopPhase =
    | {readonly tag: "idle"}
    | {readonly tag: "recording", readonly padSemitone: int, readonly segmentStart: number}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: PlayfieldDeviceBoxAdapter
    octave: DefaultObservableValue<int>
    currentSample: DefaultObservableValue<Option<LoadedSample>>
    trimStart: DefaultObservableValue<number>
    trimEnd: DefaultObservableValue<number>
    markers: DefaultObservableValue<ReadonlyArray<ChopBoundary>>
    onClose: () => void
}

export const SampleEditDialog = ({lifecycle, service, adapter, octave, currentSample, trimStart, trimEnd, markers, onClose}: Construct) => {
    const {project} = service
    const {editing, engine} = project
    const editMode = new DefaultObservableValue<EditMode>("edit")
    const focusedSemitone = new DefaultObservableValue<Option<int>>(Option.None)
    const viewStart = new DefaultObservableValue(0.0)
    const viewEnd = new DefaultObservableValue(1.0)
    const playheadPos = new DefaultObservableValue(-1.0)
    const chopPhase = new DefaultObservableValue<ChopPhase>({tag: "idle"})
    const streamTerminator = new Terminator()
    const syncTerminator = new Terminator()
    let focusPadSubscription: Terminable = Terminable.Empty
    let playNoteLifetime: Terminable = Terminable.Empty
    type PadSlice = {padIndex: int, start: number, end: number}
    const padSlices = new DefaultObservableValue<ReadonlyArray<PadSlice>>([])
    const canvas: HTMLCanvasElement = <canvas/>
    const fileLabel: HTMLElement = <div className="file-label">Drop sample here or click Browse</div>
    const browseButton: HTMLButtonElement = <button className="browse-btn">Browse…</button>
    const closeButton: HTMLButtonElement = <button className="close-btn">✕</button>
    const playPauseButton: HTMLButtonElement = <button className="play-pause-btn">▶</button>
    const octaveDecButton: HTMLButtonElement = <button className="octave-btn">−</button>
    const octaveIncButton: HTMLButtonElement = <button className="octave-btn">+</button>
    const octaveLabel: HTMLSpanElement = <span/>
    const editModeButton: HTMLButtonElement = <button className="mode-btn active">Edit</button>
    const chopModeButton: HTMLButtonElement = <button className="mode-btn">Chop</button>
    const toSamplePos = (canvasX: number): number => {
        const {left, width} = canvas.getBoundingClientRect()
        return viewStart.getValue() + clamp((canvasX - left) / width, 0.0, 1.0) * (viewEnd.getValue() - viewStart.getValue())
    }
    const toCanvasX = (samplePos: number, width: number): number =>
        (samplePos - viewStart.getValue()) / (viewEnd.getValue() - viewStart.getValue()) * width
    const paintWaveform = ({context, width, height}: CanvasPainter): void => {
        context.clearRect(0, 0, width, height)
        currentSample.getValue().ifSome(({uuid}) => {
            service.sampleManager.getOrCreate(uuid).peaks.ifSome(peaks => {
                const {numFrames, numChannels} = peaks
                const wd = width * devicePixelRatio
                const hd = height * devicePixelRatio
                const s0 = trimStart.getValue()
                const s1 = trimEnd.getValue()
                const vs = viewStart.getValue()
                const ve = viewEnd.getValue()
                const viewRange = ve - vs
                const toPx = (p: number): number => (p - vs) / viewRange * wd
                const toFrame = (p: number): number => p * numFrames
                const drawRange = (a: number, b: number): void => {
                    const ca = Math.max(a, vs)
                    const cb = Math.min(b, ve)
                    if (ca >= cb) {return}
                    const rowHeight = hd / numChannels
                    for (let ch = 0; ch < numChannels; ch++) {
                        peaksLayout.u0 = toFrame(ca); peaksLayout.u1 = toFrame(cb)
                        peaksLayout.x0 = toPx(ca); peaksLayout.x1 = toPx(cb)
                        peaksLayout.y0 = rowHeight * ch; peaksLayout.y1 = rowHeight * (ch + 1)
                        PeaksPainter.renderPixelStrips(context, peaks, ch, peaksLayout)
                    }
                }
                context.fillStyle = "hsl(220, 80%, 70%)"
                drawRange(s0, s1)
                if (s0 > 0) {
                    context.globalAlpha = 0.25
                    drawRange(0, s0)
                    context.globalAlpha = 1.0
                }
                if (s1 < 1) {
                    context.globalAlpha = 0.25
                    drawRange(s1, 1)
                    context.globalAlpha = 1.0
                }
                context.fillStyle = "rgba(255,255,255,0.9)"
                const x0 = toPx(s0)
                const x1 = toPx(s1)
                if (x0 >= 0 && x0 <= wd) {context.fillRect(Math.round(x0), 0, 2, hd)}
                if (x1 >= 0 && x1 <= wd) {context.fillRect(Math.round(x1) - 1, 0, 2, hd)}
                const dpr = devicePixelRatio
                const fw = FLAG_W_PX * dpr
                const fh = FLAG_H_PX * dpr
                if (editMode.getValue() === "chop") {
                    for (const {end, start} of markers.getValue()) {
                        const xe = Math.round(toPx(end))
                        const xs = Math.round(toPx(start))
                        const isLinked = Math.abs(xs - xe) < SNAP_PX * dpr
                        context.fillStyle = "#ffcc00"
                        if (!isLinked && xs > xe && xe < wd && xs > 0) {
                            context.fillStyle = "rgba(255,200,0,0.08)"
                            context.fillRect(xe + 1, 0, xs - xe - 1, hd)
                            context.fillStyle = "#ffcc00"
                        }
                        if (xe >= -fw && xe <= wd + fw) {
                            context.fillRect(xe, 0, 1, hd)
                            context.beginPath()
                            context.moveTo(xe, 0); context.lineTo(xe - fw, 0); context.lineTo(xe, fh)
                            context.closePath(); context.fill()
                            if (isLinked) {
                                context.beginPath()
                                context.moveTo(xe, 0); context.lineTo(xe + fw, 0); context.lineTo(xe, fh)
                                context.closePath(); context.fill()
                            }
                        }
                        if (!isLinked && xs >= -fw && xs <= wd + fw) {
                            context.fillRect(xs, 0, 1, hd)
                            context.beginPath()
                            context.moveTo(xs, 0); context.lineTo(xs + fw, 0); context.lineTo(xs, fh)
                            context.closePath(); context.fill()
                        }
                    }
                    context.font = `${Math.round(9 * dpr)}px sans-serif`
                    context.textBaseline = "top"
                    for (const {padIndex, start} of padSlices.getValue()) {
                        const lx = toPx(start)
                        if (lx + 2 >= 0 && lx < wd) {
                            context.fillStyle = "rgba(255,255,255,0.35)"
                            context.fillText(MidiKeys.toFullString(padIndex), lx + 3 * dpr, 2 * dpr)
                        }
                    }
                }
                const ph = playheadPos.getValue()
                if (ph >= 0) {
                    const phx = toPx(ph)
                    if (phx >= 0 && phx <= wd) {
                        context.fillStyle = "#00ffcc"
                        context.fillRect(Math.round(phx), 0, 2, hd)
                    }
                }
            })
        })
    }
    const waveformPainter = new CanvasPainter(canvas, paintWaveform)
    const sampleSelector = new SampleSelector(service, {
        isAttached: (): boolean => adapter.box.isAttached(),
        hasSample: (): boolean => currentSample.getValue().nonEmpty(),
        replace: (replacement: Option<AudioFileBox>): void => {
            currentSample.setValue(replacement.map(box => ({
                uuid: box.address.uuid,
                name: box.fileName.getValue(),
                endInSeconds: box.endInSeconds.getValue()
            })))
            trimStart.setValue(0.0)
            trimEnd.setValue(1.0)
            markers.setValue([])
            viewStart.setValue(0.0)
            viewEnd.setValue(1.0)
        }
    })
    const nearestTrimHandle = (clientX: number): Option<{dir: "start" | "end", offset: number}> => {
        const {left, width} = canvas.getBoundingClientRect()
        const s0px = toCanvasX(trimStart.getValue(), width) + left
        const s1px = toCanvasX(trimEnd.getValue(), width) + left
        const dl = clientX - s0px
        const dr = clientX - s1px
        const distL = Math.abs(dl)
        const distR = Math.abs(dr)
        if (distL <= HIT_PX && distL <= distR) {return Option.wrap({dir: "start", offset: dl})}
        if (distR <= HIT_PX) {return Option.wrap({dir: "end", offset: dr})}
        return Option.None
    }
    type BoundaryHit = {index: int, part: "main" | "end" | "start"}
    const findBoundaryHit = (clientX: number, clientY: number): Option<BoundaryHit> => {
        const {left, top, width} = canvas.getBoundingClientRect()
        const viewRange = viewEnd.getValue() - viewStart.getValue()
        const pos = toSamplePos(clientX)
        const threshold = HIT_PX / width * viewRange
        const snapThreshold = SNAP_PX / width * viewRange
        const inFlagZone = (clientY - top) < FLAG_H_PX
        const currentMarkers = markers.getValue()
        let bestIndex = -1
        let bestDist = threshold
        let bestPart: "main" | "end" | "start" = "main"
        for (let i = 0; i < currentMarkers.length; i++) {
            const {end, start} = currentMarkers[i]
            const isLinked = Math.abs(start - end) < snapThreshold
            const distE = Math.abs(end - pos)
            const distS = Math.abs(start - pos)
            if (inFlagZone) {
                if (isLinked) {
                    const dist = Math.min(distE, distS)
                    if (dist < bestDist) {
                        bestDist = dist
                        bestIndex = i
                        bestPart = clientX < left + toCanvasX(end, width) ? "end" : "start"
                    }
                } else {
                    if (distE < bestDist) {bestDist = distE; bestIndex = i; bestPart = "end"}
                    if (distS < bestDist) {bestDist = distS; bestIndex = i; bestPart = "start"}
                }
            } else {
                const dist = Math.min(distE, distS)
                if (dist < bestDist) {bestDist = dist; bestIndex = i; bestPart = "main"}
            }
        }
        if (bestIndex === -1) {return Option.None}
        return Option.wrap({index: bestIndex, part: bestPart})
    }
    const makeTrimDrag = (dir: "start" | "end", offset: number): Dragging.Process => ({
        update: (dragEvent: Dragging.Event): void => {
            const {left, width} = canvas.getBoundingClientRect()
            const ratio = clamp((dragEvent.clientX - offset - left) / width, 0.0, 1.0)
            const samplePos = viewStart.getValue() + ratio * (viewEnd.getValue() - viewStart.getValue())
            if (dir === "start") {trimStart.setValue(Math.min(samplePos, trimEnd.getValue()))}
            else {trimEnd.setValue(Math.max(samplePos, trimStart.getValue()))}
        },
        cancel: (): void => {},
        approve: (): void => {}
    })
    const makeBoundaryDrag = (index: int, part: "main" | "end" | "start"): Dragging.Process => ({
        update: (dragEvent: Dragging.Event): void => {
            const pos = clamp(toSamplePos(dragEvent.clientX), 0.0, 1.0)
            const arr = markers.getValue().map(b => ({...b}))
            const b = arr[index]
            if (part === "main") {
                b.end = pos; b.start = pos
            } else if (part === "end") {
                b.end = pos
                const {width} = canvas.getBoundingClientRect()
                const snapThreshold = SNAP_PX / width * (viewEnd.getValue() - viewStart.getValue())
                if (Math.abs(b.end - b.start) < snapThreshold) {b.end = b.start}
            } else {
                b.start = pos
                const {width} = canvas.getBoundingClientRect()
                const snapThreshold = SNAP_PX / width * (viewEnd.getValue() - viewStart.getValue())
                if (Math.abs(b.end - b.start) < snapThreshold) {b.start = b.end}
            }
            markers.setValue(arr)
        },
        cancel: (): void => {},
        approve: (): void => {}
    })
    const makeNewBoundaryDrag = (clickX: number): Dragging.Process => {
        const newPos = clamp(toSamplePos(clickX), 0.0, 1.0)
        const withNew = [...markers.getValue(), {end: newPos, start: newPos}]
        const newIdx = withNew.length - 1
        markers.setValue(withNew)
        return {
            update: (dragEvent: Dragging.Event): void => {
                const pos = clamp(toSamplePos(dragEvent.clientX), 0.0, 1.0)
                const arr = markers.getValue().map(b => ({...b}))
                arr[newIdx] = {end: pos, start: pos}
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
    const syncPadMarkers = (): void => {
        currentSample.getValue().ifSome(({uuid}) => {
            const matchingPads = adapter.samples.adapters()
                .filter(pad => pad.file().mapOr(f => UUID.equals(f.box.address.uuid, uuid), false))
                .slice()
                .sort((padA, padB) => padA.namedParameter.sampleStart.getValue() - padB.namedParameter.sampleStart.getValue())
            if (matchingPads.length === 0) {padSlices.setValue([]); return}
            const newSlices = matchingPads.map(pad => ({
                padIndex: pad.indexField.getValue(),
                start: pad.namedParameter.sampleStart.getValue(),
                end: pad.namedParameter.sampleEnd.getValue()
            }))
            padSlices.setValue(newSlices)
            trimStart.setValue(newSlices[0].start)
            trimEnd.setValue(newSlices[newSlices.length - 1].end)
            markers.setValue(newSlices.length > 1
                ? newSlices.slice(0, -1).map((slice, i) => ({end: slice.end, start: newSlices[i + 1].start}))
                : [])
        })
    }
    const syncAndSubscribe = (uuid: UUID.Bytes): void => {
        streamTerminator.terminate()
        syncTerminator.terminate()
        playheadPos.setValue(-1.0)
        syncPadMarkers()
        const matchingPads = adapter.samples.adapters()
            .filter(pad => pad.file().mapOr(f => UUID.equals(f.box.address.uuid, uuid), false))
        for (const pad of matchingPads) {
            let numFrames = 0
            pad.file().ifSome(file => file.data.ifSome(d => {numFrames = d.numberOfFrames}))
            syncTerminator.own(Terminable.many(
                pad.namedParameter.sampleStart.subscribe(() => syncPadMarkers()),
                pad.namedParameter.sampleEnd.subscribe(() => syncPadMarkers())
            ))
            streamTerminator.own(
                service.project.liveStreamReceiver.subscribeFloats(pad.address, array => {
                    if (numFrames <= 0) {pad.file().ifSome(file => file.data.ifSome(d => {numFrames = d.numberOfFrames}))}
                    if (array.length === 0 || array[0] === -1) {playheadPos.setValue(-1.0); return}
                    playheadPos.setValue(array[0] / numFrames)
                })
            )
        }
    }
    const focusPad = (semitone: int): void => {
        focusPadSubscription.terminate()
        syncTerminator.terminate()
        const padIndex = octave.getValue() * 12 + semitone
        adapter.samples.getAdapterByIndex(padIndex).ifSome(pad => {
            focusedSemitone.setValue(Option.wrap(semitone))
            const s = pad.namedParameter.sampleStart.getValue()
            const e = pad.namedParameter.sampleEnd.getValue()
            trimStart.setValue(s)
            trimEnd.setValue(e)
            viewStart.setValue(s)
            viewEnd.setValue(e)
            focusPadSubscription = Terminable.many(
                trimStart.subscribe(() => {
                    editing.modify(() => {
                        pad.box.sampleStart.setValue(trimStart.getValue())
                        pad.box.sampleEnd.setValue(trimEnd.getValue())
                    })
                }),
                trimEnd.subscribe(() => {
                    editing.modify(() => {
                        pad.box.sampleStart.setValue(trimStart.getValue())
                        pad.box.sampleEnd.setValue(trimEnd.getValue())
                    })
                })
            )
        })
    }
    const unfocusPad = (): void => {
        focusPadSubscription.terminate()
        focusedSemitone.setValue(Option.None)
        trimStart.setValue(0.0)
        trimEnd.setValue(1.0)
        viewStart.setValue(0.0)
        viewEnd.setValue(1.0)
        currentSample.getValue().ifSome(({uuid}) => syncAndSubscribe(uuid))
    }
    const ensurePad = (semitone: int, start: number, end: number): void => {
        const padIndex = octave.getValue() * 12 + semitone
        editing.modify(() => {
            currentSample.getValue().ifSome(({uuid, name, endInSeconds}) => {
                const audioFileBox = project.boxGraph.findBox<AudioFileBox>(uuid)
                    .unwrapOrElse(() => AudioFileBox.create(project.boxGraph, uuid, box => {
                        box.fileName.setValue(name)
                        box.endInSeconds.setValue(endInSeconds)
                    }))
                const existingOpt = adapter.samples.getAdapterByIndex(padIndex)
                existingOpt.ifSome(existing => {
                    existing.box.file.refer(audioFileBox)
                    existing.box.sampleStart.setValue(start)
                    existing.box.sampleEnd.setValue(end)
                })
                if (existingOpt.isEmpty()) {
                    PlayfieldSampleBox.create(project.boxGraph, UUID.generate(), box => {
                        box.file.refer(audioFileBox)
                        box.device.refer(adapter.box.samples)
                        box.index.setValue(padIndex)
                        box.sampleStart.setValue(start)
                        box.sampleEnd.setValue(end)
                    })
                }
            })
        })
    }
    const subscribePlayheadFor = (semitone: int): void => {
        streamTerminator.terminate()
        playheadPos.setValue(-1.0)
        const padIndex = octave.getValue() * 12 + semitone
        adapter.samples.getAdapterByIndex(padIndex).ifSome(pad => {
            let numFrames = 0
            pad.file().ifSome(file => file.data.ifSome(d => {numFrames = d.numberOfFrames}))
            streamTerminator.own(
                service.project.liveStreamReceiver.subscribeFloats(pad.address, array => {
                    if (numFrames <= 0) {pad.file().ifSome(file => file.data.ifSome(d => {numFrames = d.numberOfFrames}))}
                    if (array.length === 0 || array[0] === -1) {playheadPos.setValue(-1.0); return}
                    playheadPos.setValue(array[0] / numFrames)
                })
            )
        })
    }
    const startPlayingPad = (semitone: int): void => {
        playNoteLifetime.terminate()
        const padIndex = octave.getValue() * 12 + semitone
        adapter.samples.getAdapterByIndex(padIndex).ifSome(pad => {
            playNoteLifetime = NoteLifeCycle.start(
                signal => engine.noteSignal(signal),
                adapter.audioUnitBoxAdapter().uuid,
                pad.indexField.getValue()
            )
        })
    }
    const finishChop = (): void => {
        playNoteLifetime.terminate()
        playheadPos.setValue(-1.0)
        chopPhase.setValue({tag: "idle"})
        markers.setValue([])
        currentSample.getValue().ifSome(({uuid}) => syncAndSubscribe(uuid))
    }
    const handleChopPad = (semitone: int): void => {
        const phase = chopPhase.getValue()
        if (phase.tag === "idle") {
            if (semitone !== 0) {return}
            syncTerminator.terminate()
            ensurePad(0, trimStart.getValue(), trimEnd.getValue())
            subscribePlayheadFor(0)
            startPlayingPad(0)
            chopPhase.setValue({tag: "recording", padSemitone: 0, segmentStart: trimStart.getValue()})
            return
        }
        if (phase.tag !== "recording") {return}
        if (semitone === 0) {
            ensurePad(phase.padSemitone, phase.segmentStart, trimEnd.getValue())
            finishChop()
            return
        }
        const nextSemitone = phase.padSemitone + 1
        if (semitone !== nextSemitone || nextSemitone > 11) {return}
        const chopPos = playheadPos.getValue() >= 0 ? playheadPos.getValue() : trimEnd.getValue()
        ensurePad(phase.padSemitone, phase.segmentStart, chopPos)
        ensurePad(nextSemitone, chopPos, trimEnd.getValue())
        subscribePlayheadFor(nextSemitone)
        startPlayingPad(nextSemitone)
        chopPhase.setValue({tag: "recording", padSemitone: nextSemitone, segmentStart: chopPos})
    }
    const padLabels: ReadonlyArray<HTMLSpanElement> = Arrays.create(() => <span/>, 12)
    const padElements: ReadonlyArray<HTMLElement> = Arrays.create(semitone => {
        const padEl: HTMLElement = <div className="dialog-pad" style={{
            gridRow: String(3 - Math.floor(semitone / 4)),
            gridColumn: String(semitone % 4 + 1)
        }}>{padLabels[semitone]}</div>
        padEl.style.setProperty("--pad-color", SlotUtils.color(semitone))
        lifecycle.own(Events.subscribe(padEl, "pointerdown", (event: PointerEvent) => {
            event.stopPropagation()
            if (editMode.getValue() === "edit") {focusPad(semitone)}
            else {handleChopPad(semitone)}
        }))
        return padEl
    }, 12)
    const updatePadGrid = (): void => {
        const phase = chopPhase.getValue()
        const focused = focusedSemitone.getValue()
        const mode = editMode.getValue()
        for (let s = 0; s < 12; s++) {
            const padEl = padElements[s]
            const padIndex = octave.getValue() * 12 + s
            const padOpt = adapter.samples.getAdapterByIndex(padIndex)
            const hasSample = padOpt.mapOr(pad => pad.file().nonEmpty(), false)
            padEl.classList.toggle("has-sample", hasSample)
            padEl.classList.remove("focused", "recording", "done")
            if (mode === "edit") {
                padEl.classList.toggle("focused", focused.mapOr(f => f === s, false))
            } else if (phase.tag === "recording") {
                if (s < phase.padSemitone) {padEl.classList.add("done")}
                else if (s === phase.padSemitone) {padEl.classList.add("recording")}
            }
            padLabels[s].textContent = padOpt.match({
                none: () => MidiKeys.toFullString(padIndex),
                some: pad => pad.file().mapOr(f => f.box.fileName.getValue(), MidiKeys.toFullString(padIndex))
            })
        }
    }
    const switchMode = (mode: EditMode): void => {
        if (editMode.getValue() === "chop") {
            const phase = chopPhase.getValue()
            if (phase.tag === "recording") {
                ensurePad(phase.padSemitone, phase.segmentStart, trimEnd.getValue())
                finishChop()
            }
        }
        unfocusPad()
        editMode.setValue(mode)
        editModeButton.classList.toggle("active", mode === "edit")
        chopModeButton.classList.toggle("active", mode === "chop")
    }
    let loaderSubscription: Terminable = Terminable.Empty
    lifecycle.ownAll(
        waveformPainter,
        sampleSelector.configureDrop(canvas),
        sampleSelector.configureBrowseClick(browseButton),
        currentSample.catchupAndSubscribe(owner => {
            loaderSubscription.terminate()
            let sample = owner.getValue()
            if (sample.isEmpty()) {
                const firstPad = adapter.samples.adapters().find(pad => pad.file().nonEmpty())
                if (isDefined(firstPad)) {
                    firstPad.file().ifSome(file => {
                        const detected: LoadedSample = {
                            uuid: file.box.address.uuid,
                            name: file.box.fileName.getValue(),
                            endInSeconds: file.box.endInSeconds.getValue()
                        }
                        currentSample.setValue(Option.wrap(detected))
                        sample = Option.wrap(detected)
                    })
                }
            }
            sample.ifSome(({uuid, name}) => {
                fileLabel.textContent = name
                const loader = service.sampleManager.getOrCreate(uuid)
                loaderSubscription = loader.subscribe(state => {
                    if (state.type === "loaded") {waveformPainter.requestUpdate()}
                })
                if (loader.peaks.nonEmpty()) {requestAnimationFrame(() => waveformPainter.requestUpdate())}
                syncAndSubscribe(uuid)
            })
            if (sample.isEmpty()) {
                fileLabel.textContent = "Drop sample here or click Browse"
                streamTerminator.terminate()
                syncTerminator.terminate()
                padSlices.setValue([])
            }
        }),
        trimStart.subscribe(waveformPainter.requestUpdate),
        trimEnd.subscribe(waveformPainter.requestUpdate),
        markers.subscribe(waveformPainter.requestUpdate),
        viewStart.subscribe(waveformPainter.requestUpdate),
        viewEnd.subscribe(waveformPainter.requestUpdate),
        playheadPos.subscribe(waveformPainter.requestUpdate),
        padSlices.subscribe(waveformPainter.requestUpdate),
        editMode.subscribe(waveformPainter.requestUpdate),
        chopPhase.subscribe(updatePadGrid),
        focusedSemitone.subscribe(updatePadGrid),
        editMode.subscribe(updatePadGrid),
        octave.subscribe(() => {unfocusPad(); updatePadGrid()}),
        adapter.samples.catchupAndSubscribe({onAdd: updatePadGrid, onRemove: updatePadGrid, onReorder: updatePadGrid}),
        playheadPos.subscribe(() => {playPauseButton.textContent = playheadPos.getValue() >= 0 ? "⏸" : "▶"}),
        Events.subscribe(editModeButton, "click", () => switchMode("edit")),
        Events.subscribe(chopModeButton, "click", () => switchMode("chop")),
        Events.subscribe(octaveDecButton, "click", () => octave.setValue(Math.max(0, octave.getValue() - 1))),
        Events.subscribe(octaveIncButton, "click", () => octave.setValue(Math.min(10, octave.getValue() + 1))),
        octave.catchupAndSubscribe(() => {octaveLabel.textContent = `Oct ${octave.getValue()}`}),
        Events.subscribe(playPauseButton, "click", () => {
            if (playheadPos.getValue() >= 0) {
                playNoteLifetime.terminate()
                return
            }
            if (editMode.getValue() === "edit") {
                focusedSemitone.getValue().ifSome(semitone => startPlayingPad(semitone))
            } else {
                startPlayingPad(0)
            }
        }),
        Events.subscribe(window, "keydown", (event: KeyboardEvent) => {
            if (event.code === "Escape") {playNoteLifetime.terminate()}
        }, {capture: true}),
        Events.subscribe(closeButton, "click", onClose),
        Events.subscribe(canvas, "wheel", (event: WheelEvent) => {
            event.preventDefault()
            const {left, width} = canvas.getBoundingClientRect()
            const vs = viewStart.getValue()
            const ve = viewEnd.getValue()
            const viewRange = ve - vs
            if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
                const delta = (event.deltaX !== 0 ? event.deltaX : event.deltaY) / width * viewRange
                const newStart = clamp(vs + delta, 0.0, 1.0 - viewRange)
                viewStart.setValue(newStart)
                viewEnd.setValue(newStart + viewRange)
            } else {
                const factor = event.deltaY > 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR
                const pivot = vs + clamp((event.clientX - left) / width, 0.0, 1.0) * viewRange
                let newStart = pivot - (pivot - vs) * factor
                let newEnd = pivot + (ve - pivot) * factor
                if (newEnd - newStart < MIN_VIEW_RANGE) {return}
                newStart = Math.max(0, newStart)
                newEnd = Math.min(1, newEnd)
                viewStart.setValue(newStart)
                viewEnd.setValue(newEnd)
            }
        }, {passive: false}),
        Events.subscribe(canvas, "dblclick", () => {viewStart.setValue(0.0); viewEnd.setValue(1.0)}),
        Events.subscribe(canvas, "contextmenu", (event: MouseEvent) => {
            event.preventDefault()
            if (editMode.getValue() !== "chop") {return}
            findBoundaryHit(event.clientX, event.clientY).ifSome(({index}) => {
                const remaining = [...markers.getValue()]
                remaining.splice(index, 1)
                markers.setValue(remaining)
            })
        }),
        Dragging.attach(canvas, (pointerEvent: PointerEvent) => {
            if (editMode.getValue() === "edit") {
                return nearestTrimHandle(pointerEvent.clientX).match({
                    some: ({dir, offset}) => Option.wrap(makeTrimDrag(dir, offset)),
                    none: () => Option.None
                })
            }
            return nearestTrimHandle(pointerEvent.clientX).match({
                some: ({dir, offset}) => Option.wrap(makeTrimDrag(dir, offset)),
                none: () => findBoundaryHit(pointerEvent.clientX, pointerEvent.clientY).match({
                    some: ({index, part}) => Option.wrap(makeBoundaryDrag(index, part)),
                    none: () => Option.wrap(makeNewBoundaryDrag(pointerEvent.clientX))
                })
            })
        }),
        {terminate: (): void => {
            loaderSubscription.terminate()
            streamTerminator.terminate()
            syncTerminator.terminate()
            focusPadSubscription.terminate()
            playNoteLifetime.terminate()
        }}
    )
    return (
        <div className={className}>
            <div className="waveform-area">{canvas}</div>
            <div className="toolbar">
                {playPauseButton}
                <div className="mode-tabs">{editModeButton}{chopModeButton}</div>
                <div className="octave-control">{octaveDecButton}{octaveLabel}{octaveIncButton}</div>
                {fileLabel}
                {browseButton}
                {closeButton}
            </div>
            <div className="pad-grid">{padElements}</div>
        </div>
    )
}

const peaksLayout: PeaksPainter.Layout = {u0: 0.0, u1: 0.0, x0: 0.0, x1: 0.0, v0: +1.1, v1: -1.1, y0: 0.0, y1: 0.0}
