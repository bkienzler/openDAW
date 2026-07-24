import css from "./PlayfieldDeviceEditor.sass?inline"
import {DefaultObservableValue, Lifecycle, Option, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {DeviceHost, InstrumentFactories, PlayfieldDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {MenuItem} from "@opendaw/studio-core"
import {SlotGrid} from "@/ui/devices/instruments/PlayfieldDeviceEditor/SlotGrid"
import {ChopEditor, LoadedSample} from "@/ui/devices/instruments/PlayfieldDeviceEditor/ChopEditor"
import {StudioService} from "@/service/StudioService"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: PlayfieldDeviceBoxAdapter
    deviceHost: DeviceHost
}

const controlsWrapperClass = Html.adoptStyleSheet(css, "PlayfieldDeviceEditor")

export const PlayfieldDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const octave = new DefaultObservableValue(5) // TODO bind to PlayfieldDeviceBoxAdapter
    const chopMode = new DefaultObservableValue(false)
    const currentSample = new DefaultObservableValue<Option<LoadedSample>>(Option.None)
    const chopTrimStart = new DefaultObservableValue(0.0)
    const chopTrimEnd = new DefaultObservableValue(1.0)
    const chopMarkers = new DefaultObservableValue<ReadonlyArray<number>>([])
    const viewLifecycle = lifecycle.own(new Terminator())
    const controlsView: HTMLElement = <div/>
    const chopToggle: HTMLButtonElement = <button className="chop-toggle"/>
    lifecycle.ownAll(
        chopMode.catchupAndSubscribe(owner => {
            const isChop = owner.getValue()
            viewLifecycle.terminate()
            chopToggle.textContent = isChop ? "Pads" : "Chop"
            chopToggle.classList.toggle("active", isChop)
            if (isChop) {
                replaceChildren(controlsView)
                const backdrop: HTMLElement = <div className="chop-backdrop"/>
                const panel: HTMLElement = <div className="chop-panel">
                    <ChopEditor
                        lifecycle={viewLifecycle}
                        service={service}
                        adapter={adapter}
                        octave={octave}
                        currentSample={currentSample}
                        trimStart={chopTrimStart}
                        trimEnd={chopTrimEnd}
                        markers={chopMarkers}
                        onClose={() => chopMode.setValue(false)}/>
                </div>
                backdrop.appendChild(panel)
                document.body.appendChild(backdrop)
                viewLifecycle.ownAll(
                    Events.subscribe(backdrop, "pointerdown", (event: PointerEvent) => {
                        if (event.target === backdrop) {chopMode.setValue(false)}
                    }),
                    {terminate: () => backdrop.remove()}
                )
            } else {
                replaceChildren(controlsView,
                    <SlotGrid lifecycle={viewLifecycle} service={service} adapter={adapter} octave={octave}/>)
            }
        }),
        Events.subscribe(chopToggle, "click", () => chopMode.setValue(!chopMode.getValue()))
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => {
                          parent.addMenuItem(MenuItem.default({label: "Reset All"})
                              .setTriggerProcedure(() => project.editing.modify(() => adapter.reset())))
                          MenuItems.forAudioUnitInput(parent, service, deviceHost)
                      }}
                      populateControls={() => (
                          <div className={controlsWrapperClass}>
                              {chopToggle}
                              {controlsView}
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Playfield.defaultIcon}/>
    )
}
