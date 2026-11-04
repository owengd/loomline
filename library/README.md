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

Later Loomline libraries (Beckhoff I/O, marine switching, industrial controls and harness
connectors) will be drawn from scratch to IEC 60617 and will live in their own folders here.
