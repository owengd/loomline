# Schematic Tracer

A touch-first viewer for KiCad schematics that opens them straight from a GitHub repository.
Tap any wire, pin or label and the whole net lights up on every sheet it reaches. The
inspector lists every pin on the net, the sheets it crosses and the other names it goes by.

Built for a Galaxy Tab Active5 Pro and an S26 Ultra in Chrome, so the targets are large
enough to use with gloves on. It also works in any desktop browser.

- Reads KiCad 6, 7, 8 and 9 schematics (`.kicad_sch`), including hierarchical sheets, reused
  sheets, buses, bus aliases, global labels and power symbols.
- Opens the latest commit on a branch, or any older commit that touched the project.
- Keeps the last downloaded revision on the device, so it works offline in the container or
  on the boat.
- Also opens `.kicad_sch` files or a project ZIP from the device, with no GitHub needed.
- Nothing is uploaded anywhere. The browser talks only to `api.github.com`.

Connectivity follows eeschema's rules and has been checked against the pad nets in the PCB
files of all of KiCad's demo projects, including bus-heavy and 74-sheet designs, with no
differences. Auto-generated net names (`Net-(R1-Pad2)`) and the name picked for a net with
several labels sometimes differ from KiCad's choice, but the connections are the same.

---

## 1. Put it on GitHub Pages

1. In your organisation, create a new repository, for example `schematic-tracer`.
2. Upload everything in this folder to the root of the repository's `main` branch.
3. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**,
   then **main** and **/ (root)**, and save.
4. After a minute the app is live at `https://<your-org>.github.io/schematic-tracer/`.
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
| Follow it to another sheet | **NEXT** in the status bar steps through each sheet the net reaches |
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

## Limits

- KiCad 5 `.sch` files aren't supported. Open and save them once in KiCad 6 or newer.
- Schematics stored in Git LFS can't be read.
- Schematic only: there's no PCB view.
- In a very large repository (over 100,000 files) GitHub returns a partial file list, and the
  app warns when that happens.

## Updating the app

After changing any file, bump `CACHE` in `sw.js` (for example `tracer-v1.0.1`) so installed
copies pick up the new version.

## Files

```
index.html            app shell
css/app.css           styles
js/kicad-core.js      S-expression parser, schematic model, hierarchy and net connectivity
js/render.js          canvas renderer, gestures, hit-testing
js/github.js          GitHub REST access and project discovery
js/storage.js         IndexedDB cache for downloaded files
js/zip.js             ZIP reader for "Download ZIP" archives
js/app.js             UI: projects, sheets, inspector, search, deep links
sw.js                 offline app shell
samples/              KiCad's complex_hierarchy demo (GPL-3.0, see NOTICE.md); safe to delete
test/compare-pcb.js   node test: compares schematic nets with the pad nets in .kicad_pcb files
fonts/                IBM Plex (SIL Open Font License, see OFL-LICENSE.txt)
```

To run the connectivity test against a folder of KiCad projects:

```
node test/compare-pcb.js /path/to/kicad/demos
```

The viewer is written from scratch and contains no KiCad source code. KiCad's file format and
connectivity rules were used as the reference.
