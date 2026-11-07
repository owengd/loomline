# Loomline part library

`kicad/` holds symbols from the official KiCad symbol library, version 9.0.9, as used by
Loomline's **Add a part** tool. Each `<category>.json.gz` bundle contains its libraries' symbols in
KiCad's own S-expression format, with whitespace collapsed and packed as gzipped JSON so the
tablets download less. Nothing else about the symbols has been changed. `index.json` is a
searchable list of every symbol (name, description, keywords, reference prefix, pin and unit
counts).

Only libraries useful for electrical systems are included (switches, relays, power and
protection, connectors, sensors, comms, semiconductors and drawing symbols): 50 libraries,
10,052 symbols. To change the selection, edit `LIBS` in `tools/build-kicad-library.js` and run:

```
node tools/build-kicad-library.js /path/to/kicad-symbols
```

## Licence

The KiCad libraries are © the KiCad Library Team and contributors, and are licensed under
CC-BY-SA 4.0 with the KiCad libraries exception (see `kicad/LICENSE.md`). In short: schematics
that use these symbols don't have to be shared under the same licence, but this collection
does, with its attribution kept.

## Loomline libraries

`loomline/` holds libraries drawn for Loomline. `Loomline_Beckhoff.kicad_sym` (KiCad 8
format, opens in KiCad 8 and 9) has the C6017-0030 Industrial PC and 58 Beckhoff EtherCAT couplers, terminals and communication terminals, built by
`tools/build-loomline-library.js` from the table in `tools/beckhoff-data.js`. Terminal point
assignments come from Beckhoff's documentation (infosys.beckhoff.com and the terminal
manuals), checked November 2026. `beckhoff.json` is the same symbols for the app.

`Loomline_Hydraulics.kicad_sym` has Bucher Hydraulics cartridge valves: WS22GD (2/2 seat valve,
size 5, normally closed) and WS22OD (the normally open version), from data sheet 400-P-121110-EN
(03.2021). The valve is drawn to ISO 1219 (solenoid, two positions, spring, hydraulic ports 1 and 2
as drawing only); its pins are the coil's M8x1 plug: 1 = +V, 3 = 0 V, 4 = not used. Coil, connector,
ordering code and hydraulic data are in hidden fields. `hydraulics.json` is the same for the app.

Marine switching, industrial controls and harness connectors will follow, drawn to IEC 60617.
