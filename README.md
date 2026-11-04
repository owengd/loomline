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

The layout follows the KiCad Editor Android app: chips along the top for the sheet, nets and
parts; a tool rail on the right (along the bottom on a phone); and a status bar at the bottom
showing what's selected.

| To | Do this |
| --- | --- |
| Trace a net | Tap a wire, pin end, label or junction. It's drawn bold orange on every sheet; nothing else fades |
| Follow it a connector at a time | **STEP** in the status bar (or Layers → *Trace in steps*) lights the net only from the wire you tapped to the first connector or terminal pins, with the rest of the net in pale orange and the connectors it stops at boxed. **CONTINUE** carries on through them to the next connectors, **BACK** goes back a step, **ALL** shows the whole net again. Off-page jumps (power symbols, global labels) are a step too. Step mode stays on for later taps until you press **ALL** |
| Follow it to another sheet | **NEXT SHEET** in the status bar steps through each sheet the net reaches |
| See every pin on the net | **NETS** in the rail (or tap the status bar) opens the Net Navigator |
| Inspect a part | Tap the part body or its reference, then **INFO** for fields and pins |
| Find a part | **PARTS** lists every part with a filter box; the search icon covers parts, nets and sheets |
| Change sheet | The sheet chip at the top, or **SHEETS** in the rail; ↑ goes to the parent sheet |
| Enter a sheet | Double-tap the sheet box, or tap it and press **ENTER** |
| Grid dots | Tap the scale chip in the bottom-left corner |
| Share a view | **Copy link** in the Net Navigator or Properties puts the project, sheet and net in the URL |
| Older revision | ← (Projects) → *Recent changes*, then tap a commit |
| Clear | **CLEAR** in the status bar, or tap empty space |

When the app comes back to the foreground it checks GitHub. If someone has pushed a change
to the open project, a banner offers to load it.

On a keyboard: `/` to search, `Esc` to clear, `Backspace` for the parent sheet, `+`, `-`
and `0` to zoom.

## 4. Editing

The three buttons at the top of the rail switch mode: **SELECT** (tap to select and trace),
**WIRE** and **LABEL**. Every change is a small edit to the schematic text, so the rest of the
file stays exactly as KiCad wrote it.

| To | Do this |
| --- | --- |
| Edit reference, value or other fields | Select a part → **EDIT**. **ADD FIELD** adds a new one; DNP is a tick box |
| Move | Select a part, label or wire → **MOVE**, drag, then **DONE**. Attached wires stretch to follow |
| Rotate / mirror | Select a part → **ROTATE**, **MIRROR ↔** or **MIRROR ↕** (labels rotate too) |
| Delete | Select → **DELETE**. Junctions that are no longer needed go with it |
| Copy a part | Select it → **COPY**. The copy gets the next free reference and starts in move mode |
| Draw a wire | **WIRE**, then tap points; it snaps to the 1.27 mm grid and finishes when it lands on a pin or wire. **FLIP** swaps the corner, **BACK** removes the last point |
| Add a label | **LABEL**, tap a wire or pin, choose local, global or hierarchical and type the name |
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
| PLC I/O list | Every I/O module and each channel: terminal points, signal, wire number, what it connects to, used or spare, and the E-bus budget |
| Bill of materials | Parts grouped by value and footprint, plus MPN / manufacturer fields if present |
| Design check | Every problem the check found, with page and zone |
| Install record | Fitted and tested status for every wire and part, with who and when |

The wire list turns each net into individual wires by joining its pins in the shortest way the
drawing allows (pins on the same sheet first). That matches how a loom is usually made up, but
check it against the drawing for nets where the order of terminations matters.

### Beckhoff I/O

**Add a part → Beckhoff I/O** has 54 Beckhoff parts: the C6017-0030 Industrial PC, the EK1100 coupler, power and
E-bus supply terminals (EL9100, EL9110, EL9400, EL9410), and digital in and out, relay, analog
in and out, RTD and load-cell terminals (EL1002…EL1889, EL2002…EL2809, EL2622, EL3001…EL3124,
EL3202, EL3356, EL4002…EL4038). Each is a box with one pin per terminal point, numbered as on
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

## 9. Drawing and adding parts

**DRAW** in the rail opens a palette across the top of the drawing:

| Tool | How |
| --- | --- |
| PART | Opens **Add a part**: search 10,000 symbols from KiCad's library (relays, switches, fuses, lamps, connectors, power symbols, sensors…), or browse by category. Tap one to preview it, then **PLACE** and tap the drawing. Tap again to place another; **ROTATE** turns the last one |
| LINE | Tap each point, then **FINISH** |
| RECT | Tap two opposite corners |
| CIRCLE | Tap the centre, then a point on the edge |
| ARC | Tap the start, a point it passes through, and the end |
| TEXT | Tap where it goes and type it; choose size, direction, bold or italic |

**STYLE** sets line width, dashes, fill and colour for new shapes. In SELECT mode, tap a shape's
outline or a text to select it: **STYLE** or **EDIT**, **MOVE** and **DELETE** work on it.

Everything snaps to the 1.27 mm grid. A placed part gets the next free reference (K3, SW12…),
and its symbol is copied into the schematic file, the same way KiCad does it, so the file
opens in KiCad with nothing else to install. For a part with several units (a dual op-amp, a
relay with separate coil and contacts), select it and tap **ADD UNIT** to place the next one.
The part library is downloaded once and then works offline. See `library/README.md` for where
it comes from and its licence.

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
js/edit.js            schematic edits as text splices: fields, move, rotate, wires, labels, copy
js/app.js             UI: projects, sheets, inspector, search, deep links, editing, saving
sw.js                 offline app shell
samples/              KiCad's complex_hierarchy demo (GPL-3.0, see NOTICE.md); safe to delete
test/compare-pcb.js   node test: compares schematic nets with the pad nets in .kicad_pcb files
test/edit-test.js     node test: applies edits, re-parses and checks connectivity
test/library-test.js  node test: places library parts and draws shapes, then re-parses
test/loom-test.js     node test: wire numbers, wire list, checks and self-compare on every demo project
fonts/                IBM Plex (SIL Open Font License, see OFL-LICENSE.txt)
```

To run the connectivity test against a folder of KiCad projects:

```
node test/compare-pcb.js /path/to/kicad/demos
```

The viewer is written from scratch and contains no KiCad source code. KiCad's file format and
connectivity rules were used as the reference.
