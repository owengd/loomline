# Loomline

Design, trace and install electrical systems from KiCad schematics, on a tablet. Loomline opens
schematics straight from a GitHub repository. Tap any wire, pin or label and the whole net lights
up on every sheet it reaches; every wire gets a number; the design is checked as you edit; and the
install crew can tick off each wire as it's fitted and tested, shared with the whole team.

Built for a Galaxy Tab Active5 Pro and an S26 Ultra in Chrome, so the targets are large
enough to use with gloves on. It also works in any desktop browser.

- Reads KiCad 6, 7, 8 and 9 schematics (`.kicad_sch`), including hierarchical sheets, reused
  sheets, buses, bus aliases, global labels and power symbols.
- Wire numbers, a from/to wire list, loom list, connector pin-outs and a BOM, as CSV or PDF.
- Cross-references between the units of multi-unit parts (relay coil and contacts, and so on).
- A live design check, revision compare, and editing that saves to a branch and pull request.
- An install log (fitted / tested per wire and part) shared through the repository.
- Keeps the last downloaded revision on the device, so it works offline in the container or
  on the boat.
- Also opens `.kicad_sch` files or a project ZIP from the device, with no GitHub needed.
- Nothing is uploaded anywhere else. The browser talks only to `api.github.com`.

Connectivity follows eeschema's rules and has been checked against the pad nets in the PCB
files of all of KiCad's demo projects, including bus-heavy and 74-sheet designs, with no
differences. Auto-generated net names (`Net-(R1-Pad2)`) and the name picked for a net with
several labels sometimes differ from KiCad's choice, but the connections are the same.

---

## 1. Put it on GitHub Pages

1. In your organisation, create a new repository, for example `loomline`.
2. Upload everything in this folder to the root of the repository's `main` branch.
3. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**,
   then **main** and **/ (root)**, and save.
4. After a minute the app is live at `https://<your-org>.github.io/loomline/`.
5. On the tablet, open that address in Chrome. Tap **⋮ → Add to home screen** to install it as
   an app, which also lets it open offline.

Pages from a private repository needs a paid GitHub plan. If the org is on the free plan, make
this viewer repository public. That's safe because it contains **no schematics**: your
designs stay in their own private repository and are only fetched by each device using its
own token.

> Don't add a workflow that copies schematics into this repository or into Pages. A Pages
> site is public unless the organisation is on GitHub Enterprise Cloud.

## 2. Create a read-only token (each person, each device)

On github.com go to **Settings → Developer settings → Personal access tokens → Fine-grained
tokens → Generate new token** and set:

| Setting | Value |
| --- | --- |
| Resource owner | your organisation |
| Expiration | whatever your org allows (90 days is a sensible default) |
| Repository access | **Only select repositories** → the schematics monorepo |
| Permissions → Repository → Contents | **Read-only** (Metadata: read-only is added automatically) |

If the organisation requires approval for fine-grained tokens, an org owner approves it under
**Organisation settings → Personal access tokens → Pending requests**. If the org uses SAML
SSO, authorise the token for the org as well.

**Outside collaborators:** if you've been added to the schematics repository as an outside
collaborator rather than as an org member, GitHub doesn't let fine-grained tokens reach it.
Use a classic token instead (**Tokens (classic) → Generate new token**, scope `repo`). That
scope is read *and write* across every repository you can access, so give it a short expiry,
or ask an org owner to make you a member so you can use a read-only fine-grained token.

Then in the app: **Connect repository**, enter `your-org/your-repo`, paste the token and tap
**Connect**. The app finds every `.kicad_pro` in the monorepo and lists them as projects.
Folders of schematics with no `.kicad_pro` are listed too.

### Where the token lives

- With **Remember the token on this device** ticked, the token is kept in the browser's local
  storage on that device. Otherwise it lasts only until the tab closes.
- It is only ever sent to `api.github.com`.
- Every Pages site under `https://<your-org>.github.io/` shares one browser origin, so another
  Pages site in the same org could read it. If that matters, give the viewer a custom domain
  (Settings → Pages → Custom domain) or leave "remember" unticked.
- **Disconnect** in the Projects panel removes it. Revoke it on GitHub if a device is lost.

## 3. Using it

The layout follows desktop electrical CAD (AutoCAD Electrical, Capital X Panel Designer), sized
for fingers: a dark title bar with the sheet and nets chips; a **ribbon** of tools in tabs
(**Home**, **Insert**, **Wire**, **Draw**, **Analyse**, **View**; tap the open tab again, or the
arrow at the right, to fold it away); a **Stencils** dock on the left; panels and their tab rail
on the right (along the bottom on a phone); and a status bar at the bottom showing what's
selected and what you can do with it. On a wide screen the Properties panel opens when you
select a part (View → *Properties* turns that off).

| To | Do this |
| --- | --- |
| Trace a net | Tap a wire, pin end, label or junction. It's drawn bold orange on every sheet; nothing else fades |
| Follow it a section at a time | **STEP** in the status bar (or Layers → *Trace in steps*) lights only the wire you tapped, up to the first junction or pin, with the rest of the net in pale orange and the parts it stops at boxed. **CONTINUE** adds the next sections, **BACK** goes back a step, **ALL** shows the whole net again. Layers → *Steps stop only at connectors* makes each step run to the next connectors instead. Off-page jumps (power symbols, global labels) are a step too. Step mode stays on for later taps until you press **ALL** |
| Say what a cable is | Tap a wire, then **CABLE**: type, product code, core size, colour / marking and length for that section (between junctions and pins). Pick from the **Cable list** (the AC75 M27500 cables, Ethernet and coax, kept in `js/cables.js`), then the **Core** this section is (M27500: core 1 white, then white with blue, orange, green… stripes; plus the screen), which fills Colour / marking; or type: product codes and types already used are offered as you type, and picking a known product code fills in its type and size. The details are saved in the schematic as a KiCad net class flag on the wire (fields Cable_Type, Cable_PN, Cable_Size, Cable_Colour, Cable_Length, plus Cable_Label, the text shown on the drawing: core colour, gauge and core count, e.g. "White/Blue 26 AWG 4 core", written along the wire beside a small dot, placed where it clears other text, tags and wires — on the other side of the wire or a little further along if needed; **FLIP SIDE** on a selected tag swaps it over), so they go through the usual branch and pull request and KiCad keeps them. Tapping a cabled wire shows its details in the status bar; **Reports → Cable schedule** lists every section and totals length by cable |
| Follow it to another sheet | **NEXT SHEET** in the status bar steps through each sheet the net reaches |
| See every pin on the net | **NETS** in the rail (or tap the status bar) opens the Net Navigator |
| Inspect a part | Tap the part body or its reference, then **INFO** for fields and pins |
| Find a part | **PARTS** lists every part with a filter box; the search icon covers parts, nets and sheets |
| Change sheet | The sheet chip at the top, or **SHEETS** in the rail; ↑ goes to the parent sheet, and ← / → in the title bar step back and forward through the sheets you've visited (like a browser) |
| Enter a sheet | Double-tap the sheet box, or tap it and press **ENTER** |
| Grid dots | Tap the scale chip in the bottom-left corner |
| Full screen | The ⤢ button at the top (or Layers → *Full screen*) hides the bars. Tap a handle on the top, right or bottom edge, or swipe in from an edge, to bring them back for a few seconds; selecting something shows the status bar. On Android it also hides the system bars |
| Share a view | **Copy link** in the Net Navigator or Properties puts the project, sheet and net in the URL |
| Older revision | ← (Projects) → *Recent changes*, then tap a commit |
| Clear | **CLEAR** in the status bar, or tap empty space |

When the app comes back to the foreground it checks GitHub. If someone has pushed a change
to the open project, a banner offers to load it.

On a keyboard: `/` to search, `Esc` to clear, `Backspace` for the parent sheet, `+`, `-`
and `0` to zoom.

## 4. Editing

The ribbon's **Home** tab has selection, the clipboard and arrange tools; **Wire** and
**Insert** add wiring and labels; **Draw** adds lines, shapes and text. Every change is a small
edit to the schematic text, so the rest of the file stays exactly as KiCad wrote it.

| To | Do this |
| --- | --- |
| Edit reference, value or other fields | Select a part → **EDIT**. **ADD FIELD** adds a new one; DNP is a tick box |
| Move | Select a part, label or wire → **MOVE**, drag, then **DONE**. Attached wires stretch to follow |
| Rotate / mirror | Select a part → **ROTATE**, **MIRROR ↔** or **MIRROR ↕** (labels rotate too) |
| Delete | Select → **DELETE**. Junctions that are no longer needed go with it |
| Duplicate a part | Select it → **DUPLICATE**. The copy gets the next free reference and starts in move mode |
| Select several things | Home → **Box select**, then drag a box: everything wholly inside it is selected (drag again to add more, tap an item to add or remove it, two fingers still pan). **Select all** takes the whole sheet. Then **MOVE**, **COPY**, **DUPLICATE** or **DELETE** the lot |
| Copy and paste | Select one thing or a box of things → **Copy**, then **Paste** and tap where the top-left of the copy goes, on this sheet or any other (even another project). Parts get the next free references, and their symbols come along. `Ctrl+C`, `Ctrl+V`, `Ctrl+D` (duplicate), `Ctrl+A` and `Delete` work on a keyboard |
| Draw a wire | Wire → **Draw wire**, then tap points; it snaps to the 1.27 mm grid and finishes when it lands on a pin or wire. **FLIP** swaps the corner, **BACK** removes the last point |
| Add a label | Insert → **Net label**, **Off-sheet** (a KiCad global label: joins the net across sheets) or **Sheet port** (hierarchical label), then tap a wire or pin and type the name |
| No-connect flag | Tap a pin → **NO-CONN** |
| Undo / redo | The arrows in the top bar, or `Ctrl+Z` / `Ctrl+Y` |

If an edit joins two nets that were separate (for example rotating a big part with wires
attached), the app says which nets merged and offers **UNDO**.

The red chip in the top bar counts unsaved edits. They're kept on the device, so closing the
tab doesn't lose them; next time you open the project it offers to restore them.

### Saving

Tap the red edits chip. **SAVE TO GITHUB** commits the changed files to a new branch
(`loomline/<project>-<date>` by default) and opens a pull request into the branch you were
viewing. Saving again from that branch adds another commit to the same pull request. Nothing
is ever written to `main` directly.

Saving needs a token with write access: a classic token with the `repo` scope, or a
fine-grained token with **Contents: Read and write** and **Pull requests: Read and write**.
Without one, **DOWNLOAD ZIP** gives you the edited files to commit yourself.

Open the branch in KiCad and run ERC before merging the pull request. The editor covers
common changes but isn't a replacement for eeschema: it doesn't edit buses or sheets, or update
the PCB.

## 5. Wire numbers, cross-references and reports

**Wire numbers.** Every net that joins two or more pins gets a wire number. A net with a label
uses the label's name (`CAN_H`, `+12V`); if a reused sheet makes the same local name appear more
than once, the sheet number is added (`PIEZO_IN.3`). Other nets are numbered by sheet and
position: sheet 2's wires are `201`, `202`… from the top of the sheet down. Auto numbers move
when the drawing changes, so before you print heat-shrink labels select the wire and tap
**FIX NO.**: that adds a local label with the number, so it never changes again. The layers
button (top bar) turns numbers, cross-references, check markers and install colours on and off.

**Cross-references.** Parts with several units (a relay's coil and contacts, a dual op-amp) show
where their other units are, as `K1B p4 C3` (unit, page, drawing zone) under each unit. The
Properties panel lists them; tap one to jump to it.

**Reports** (REPORTS in the rail, or Settings → Tools on a phone). Each can be viewed, exported as
CSV, or printed / saved as a PDF:

| Report | Contents |
| --- | --- |
| Wire list | Every wire: number, from part and pin, to part and pin, net, pages |
| Loom list | The same wires grouped by the two parts they join, connectors first |
| Connector pin-outs | For each connector or terminal strip: pin, name, wire, net and where it goes |
| Cable schedule | Total cable length per type and product code for ordering (the cores of one cable — same cable, same two ends, same length — count once as a cable run), each cable run with the cores tagged, and every tagged core with its two ends |
| PLC I/O list | Every I/O module and each channel: terminal points, signal, wire number, what it connects to, used or spare, and the E-bus budget |
| Bill of materials | Parts grouped by value and footprint, plus MPN / manufacturer fields if present |
| Design check | Every problem the check found, with page and zone |
| Install record | Fitted and tested status for every wire and part, with who and when |

The wire list turns each net into individual wires by joining its pins in the shortest way the
drawing allows (pins on the same sheet first). That matches how a loom is usually made up, but
check it against the drawing for nets where the order of terminations matters.

### Hydraulic valves

**Add a part → Hydraulics** has the Bucher WS22GD cartridge seat valve (2/2, size 5, normally
closed) and the normally open WS22OD. The symbol shows the valve to ISO 1219 with ports 1 and 2;
its three pins are the coil's M8 plug (1 = +V, 3 = 0 V, 4 = not used), so the coil wiring traces
and appears in the wire list like any other part. Reference letter Y. The coil (12 V DC holding,
15 W), connector, ordering code and hydraulic ratings are in the part's fields (INFO).

### Our connectors

**Add a part → Connectors** lists the team's own connectors first (they are also in the stencil dock
as **Our connectors**): Deutsch DT and DTM, Deutsch ASC in all four keyways, the Bosch 5-way Trapez
pressure-sensor plug, Phoenix Contact M8 4-position and M12 4 and 5-position
connectors (plus generic M12 8-pin and Ethernet), DE-9 CAN, BNC, RP-SMA and 2.1 mm
DC power, each as a male and female pair. Pin names follow the standard colour codes or the data sheet; part number, contacts,
wedgelock, mating half and data sheet link are in the part's fields (INFO).

### Beckhoff I/O

**Add a part → Beckhoff I/O** has 59 Beckhoff parts: the C6017-0030 Industrial PC, the EK1100 coupler, power and
E-bus supply terminals (EL9100, EL9110, EL9400, EL9410), and digital in and out, relay, analog
in and out, RTD and load-cell terminals (EL1002…EL1889, EL2002…EL2809, EL2622, EL3001…EL3124,
EL3202, EL3356, EL4002…EL4038), plus the EL2535 PWM valve output, EL2838 8-channel 2 A output, EL3078 8-channel multi-function analog input, EL6021 RS422/RS485 serial and EL6751 CANopen master (its pins are the 9-pin D-sub: 2 CAN_L, 7 CAN_H, 3/6 CAN GND, 9 optional supply). Each is a box with one pin per terminal point, numbered as on
the terminal itself and named by channel (DI3, AO1, AI2+, R1+, UD+…), with order code,
signal type and channel count in its fields. Terminal point assignments were taken from
Beckhoff's own documentation; if you use a variant (-0010 and so on), check its datasheet.

The **C6017-0030** Industrial PC has its X101 power plug on the left (1 PC-ON, 2 P-S,
3 0 V, 4 +24 V; at least 22 V at the plug) and PE, and its ports on the right: X102/X103
LAN 2.5G, X104 DisplayPort, X105/X106 USB 3.1, plus X201/X202 LAN and X203/X204 USB marked
(opt), which are fitted with the C9900-E320 interface option. Run EtherCAT from a LAN port
to the EK1100 with a wire or label. The PC isn't on the E-bus, so it doesn't count towards
the E-bus budget.

The **PLC I/O list** report lists every module and channel, marks channels as used or spare,
and adds up the E-bus load against what the couplers and EL9410s supply. So far only some
terminals carry an E-bus figure; the report says how many don't. Spare channels on I/O
modules aren't flagged by the design check.

The same symbols are in `library/loomline/Loomline_Beckhoff.kicad_sym` for KiCad on the
desktop: add it in KiCad under Preferences → Manage Symbol Libraries.

## 6. Design check

CHECK in the rail runs after every edit and marks problems on the drawing (a red circle is an
error, an amber triangle a warning). It looks for: unconnected pins, wire ends that touch
nothing, labels that reach no pins, global labels used only once, sheet pins without a matching
hierarchical label (and the reverse), duplicate or unannotated references, missing values, and
outputs driving each other. It covers the common mistakes; run ERC in KiCad before release.

## 7. Compare revisions

From **Recent changes** in the Projects panel, tap **COMPARE** on any commit (or use the layers
button → Compare revisions). Loomline loads that revision and lists what's electrically
different: parts added, removed or changed (with the old and new field values) and connections
that changed, were cut or renamed. On the drawing, changed connections turn purple and changed
parts are outlined. **REVIEW CHANGES** in the save dialog does the same for your unsaved edits.

## 8. Install log

INSTALL in the rail lists every wire (grouped by the parts it joins) and every part, each with
**FIT** and **TEST** buttons. With a wire or part selected on the drawing, **FITTED** and
**TESTED** are in the bottom bar too. The drawing colours wires blue when fitted, green when
tested, and amber when only some of a net's wires are done.

Ticks are saved on the device straight away, so it works with no signal. When GitHub can be
reached they're shared through a branch called `loomline-install` in the schematics repository.
That branch holds only the install log (`install/<project>.json`) and has no history in common
with `main`, so it never mixes with the design or its pull requests. Each sync is a commit, so the
branch history shows who fitted and tested what, and when. Two tablets ticking at the same time
are merged item by item (the later tick wins). Sharing needs a token with write access; with a
read-only token the log stays on the device.

## 9. Stencils, parts and drawing

**Stencils** (Insert → *Stencils*, or the top of the rail) opens a dock of ready-made pieces, like
the stencil panel in Capital X:

- **Wires & junctions**: straight runs, corners, tees, a four-way cross, a crossover (two wires
  crossing without joining), a junction dot and a no-connect flag.
- **Labels & connectors**: net label, off-sheet connector, sheet port, cable tag and text.
- **Parts**: power symbols, fuses and protection, switches, relays, loads and indicators,
  connectors, passives, the Beckhoff I/O terminals and the Bucher hydraulic valves, each with a
  picture. **All 10,000 parts…** opens the full library; the search box at the top searches the
  stencils and the library together. **Recently used** keeps your last twelve.

Tap a stencil, then tap the drawing to place it (tap again for another; **DONE** when finished),
or drag it straight from the dock onto the drawing (a sideways drag or a long press picks it up).

Stencils join what they're dropped on:

- A **tee** or **cross** dropped on a wire branches off it (its arms that lie along the wire are
  already there), with a junction.
- A **two-pin part** (fuse, switch, resistor, diode, lamp…) dropped on a straight wire turns to
  line up with it and goes in series: the wire between its pins is removed.
- A **power symbol** or other part dropped on a wire, pin or wire end connects its nearest pin
  there, splitting the wire and adding a junction if needed.
- If a drop would also touch a net it shouldn't, the app says which nets merged and offers
  **UNDO**.

The **Draw** tab has the drawing tools:

| Tool | How |
| --- | --- |
| Line | Tap each point, then **FINISH** |
| Rectangle | Tap two opposite corners |
| Circle | Tap the centre, then a point on the edge |
| Arc | Tap the start, a point it passes through, and the end |
| Text | Tap where it goes and type it; choose size, direction, colour, bold or italic |

**Line style** sets width, dashes, fill and colour for new shapes (or the selected one). Tap a
shape's outline or a text to select it: **STYLE** or **EDIT**, **MOVE** and **DELETE** work on it.

Everything snaps to the 1.27 mm grid. A placed part gets the next free reference (K3, SW12…),
and its symbol is copied into the schematic file, the same way KiCad does it, so the file
opens in KiCad with nothing else to install. For a part with several units (a dual op-amp, a
relay with separate coil and contacts), select it and tap **ADD UNIT** to place the next one.
The part library is downloaded once and then works offline. See `library/README.md` for where
it comes from and its licence.

## 10. Keyboard (KiCad hotkeys)

On a computer the app takes the same keys as KiCad 9's schematic editor, so people who know KiCad can
work the same way. With nothing selected, a key acts on whatever is under the mouse pointer, as in
KiCad. Press **Ctrl+F1** or **?** (or **View → Keys**) for the full list. Ribbon tooltips show each tool's key.

| Keys | Does |
|---|---|
| E, V, U, F, D | Properties; edit value, reference, footprint; open the data sheet |
| M, G, R, X, Y, Del | Move (wires stay put) or drag (wires follow), rotate, mirror, delete |
| O, Alt+S | Autoplace a part's fields; swap two selected parts or labels |
| Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+D | Copy, cut, paste, duplicate |
| Ctrl+A, Ctrl+Shift+A, Ctrl+Z, Ctrl+Y | Select all, unselect all, undo, redo |
| A, P | Add a symbol, add a power symbol |
| W, J, Q, I, T | Wire (starts at the pointer), junction, no-connect, lines, text |
| L, Ctrl+L, H | Net label, global label, hierarchical label |
| Ins | Repeat the last item; label numbers count on (IN1, IN2, IN3…) |
| B, Z, C | Draw a bus, add a bus entry (R turns it), unfold a member from the bus |
| S, Shift+B | New hierarchical sheet, design blocks |
| / , Shift+Space, Backspace, End | While drawing a wire: flip the corner, 90° / 45° / any angle, undo a segment, finish |
| \`, ~ | Highlight the net under the pointer, clear it |
| Home, Ctrl+Home, F1, F2, F4 | Fit the sheet, fit the objects, zoom in/out at the pointer, centre on the pointer |
| Arrows, Shift+Arrows | Pan |
| PgDn, PgUp, Alt+Backspace | Next sheet, previous sheet, up a sheet |
| Alt+Left, Alt+Right, N, Shift+N | Back / forward through sheets (the mouse's back / forward buttons do the same), next / previous snap grid |
| Ctrl+F, Ctrl+Alt+F, Ctrl+Shift+M | Find, find and replace, measure |
| Ctrl+S, Ctrl+H, Ctrl+P | Save edits, sheet list, print / PDF / SVG |

On a Mac, Cmd works in place of Ctrl. A browser keeps a few Ctrl keys for itself (Ctrl+N, Ctrl+T, Ctrl+W).

## 11. KiCad tools

Most of these are on the ribbon too, so they work by touch.

- **Annotate** (Analyse → Tools): renumbers references across the project, page by page, left to right.
  Either fix only new (R?) and duplicate references, or renumber everything; numbering can run 1, 2, 3… or
  start each page at page × 100 (201, 301…). Units of one part keep one reference. Shows the changes first.
- **Find and replace** (Ctrl+Alt+F): in labels, text and part fields, across every sheet, with a preview.
  Renaming a label renames its net.
- **Symbol fields table** (Analyse → Tools → Fields table): every part's fields in one grid, like KiCad's
  Symbol Fields Table. Edit cells, add a field column (MPN, Manufacturer…), group identical parts so one
  edit sets them all, paste a block from Excel or Sheets, sort, export CSV. APPLY is one undo step.
- **Measure** (Ctrl+Shift+M), **Swap** (Alt+S), **Autoplace fields** (O), **Snap grid** (N), **Wire angle**
  (Shift+Space: 90°, 45° or any).
- **Buses**: draw with **Draw bus** (B), name with a label such as `D[0..7]` or `{SDA SCL}`, add entries (Z),
  or tap a bus → **UNFOLD** (C) to bring a member out with its entry, wire and label in one step.
- **New sheets** (Insert → New sheet, or S): tap two corners, name it; a new sheet file is created and is
  committed with your next save. Select a sheet for **ADD PIN** (adds the pin and the matching sheet port
  inside), **IMPORT PINS** (pins for every sheet port the sub-sheet already has) or **DELETE**.
- **My parts** (Insert → My parts): a simple symbol editor. Type the pins one per line (number, name, then
  optional type and side) and the fields; see it live, then SAVE & PLACE. Start from a selected part to copy
  its pins. Parts are kept on this device under **My parts** in Add part and the stencil dock, and can be
  downloaded as a `.kicad_sym` for KiCad. Every placed part carries its own copy inside the sheet, so
  drawings open in KiCad and on other devices.
- **Design blocks** (Insert → Blocks, or Shift+B): save a selection (say a standard M12 sensor drop) by
  name and place it on any sheet of any project; parts get fresh references. Export the blocks to a file to
  share them with the team, and import them on another device.
- **Print, PDF and SVG** (Analyse → Output → Print / PDF, the layers menu, or Ctrl+P): this sheet or all
  of them, in colour or black and white, with or without wire numbers and cross-references. PRINT / PDF
  opens the system print dialog (choose a printer or Save as PDF); each sheet gets its own page at its
  KiCad paper size, true to scale. SVG downloads vector drawings (a zip for several sheets) with the
  font built in. Unsaved edits are included.

## Limits

- KiCad 5 `.sch` files aren't supported. Open and save them once in KiCad 6 or newer.
- Schematics stored in Git LFS can't be read.
- Schematic only: there's no PCB view.
- In a very large repository (over 100,000 files) GitHub returns a partial file list, and the
  app warns when that happens.

## Updating the app

After changing any file, bump `CACHE` in `sw.js` and the `?v=` numbers on the CSS and script
links in `index.html` (for example `1.6.1`), so installed copies pick up the new version straight away.

## Files

```
index.html            app shell
css/app.css           styles
js/kicad-core.js      S-expression parser, schematic model, hierarchy and net connectivity
js/render.js          canvas renderer, gestures, hit-testing
js/github.js          GitHub REST access and project discovery
js/storage.js         IndexedDB cache for downloaded files
js/zip.js             ZIP reader for "Download ZIP" archives, and writer for edited files
library/              part library (KiCad symbols as gzipped JSON, plus a search index); see library/README.md
tools/build-kicad-library.js  rebuilds library/ from a checkout of KiCad's symbol library
tools/build-loomline-library.js  builds Loomline's own libraries (Beckhoff I/O so far) from tools/*-data.js
js/loom.js            wire numbers, wire list, cross-references, design check, reports, revision compare
js/edit.js            schematic edits as text splices: fields, move, rotate, wires, labels, copy and paste, parts dropped into wires
js/app.js             UI: ribbon, stencil dock, projects, sheets, inspector, search, deep links, editing, saving
sw.js                 offline app shell
samples/              KiCad's complex_hierarchy demo (GPL-3.0, see NOTICE.md); safe to delete
test/compare-pcb.js   node test: compares schematic nets with the pad nets in .kicad_pcb files
test/edit-test.js     node test: applies edits, re-parses and checks connectivity
test/library-test.js  node test: places library parts and draws shapes, then re-parses
test/loom-test.js     node test: wire numbers, wire list, checks and self-compare on every demo project
test/stencil-test.js  node test: stencils on wires, parts dropped in series, copy and paste, group move
test/trace-test.js    node test: step-by-step tracing
test/tools-test.js    node test: annotate, find and replace, autoplace, sheets, buses, box symbols
fonts/                IBM Plex (SIL Open Font License, see OFL-LICENSE.txt)
```

To run the connectivity test against a folder of KiCad projects:

```
node test/compare-pcb.js /path/to/kicad/demos
```

The viewer is written from scratch and contains no KiCad source code. KiCad's file format and
connectivity rules were used as the reference.
