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

`Loomline_Connectors.kicad_sym` has the harness connectors from the team's procurement list
(44 symbols, reference J, each with its mating half): Deutsch DT 2, 3 and 4 way (size 16 contacts, 13 A)
and DTM (2, 6, 8 and 12 way, plugs and receptacles; size 20 contacts, 7.5 A), Deutsch ASC (AS
Composite) 6-way plugs and receptacles in all four keyways (N red, A yellow, B blue, D green;
shell 6, e.g. ASC605-06PD green plug), the Bosch F 02U B00 751-01 5-way Trapez sensor plug, Phoenix Contact SACC M8 4-position and
M12 4 and 5-position A-coded cable connectors (plus generic M12 8-pin and D-coded Ethernet), with IEC 61076-2
colour pinouts, a DE-9 CAN connector to
CiA 303-1, BNC, RP-SMA and 2.1 mm DC plug and jack. Manufacturer, part number, series, contacts,
wedgelock, mating half and data sheet are in hidden fields. `connectors.json` is the same for the app.

Marine switching and industrial controls will follow, drawn to IEC 60617.
