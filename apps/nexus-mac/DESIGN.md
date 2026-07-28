# NexusCode — Design Thesis

This is a decision, not a survey. Three previous passes corrected defects
(contrast ratios, dead space, banner styles, one accent de-emphasised) and the
app still reads as a wireframe, because a pile of corrections never adds up to
a point of view. This document states the point of view. Every screen gets
rebuilt against it — not patched.

## Character

NexusCode is a harness: it makes many AI providers interchangeable and shows
you exactly what it runs — the literal `nexus` command, the raw event stream,
the model that answered. That honesty is the product's whole identity. The UI
must read as an **instrument** — precise, legible, built for someone who wants
to see the machine working — never as a chat toy wrapped in rounded bubbles.
The nearest references are not chat apps; they are Linear, Raycast, Warp,
Zed — professional tools whose UI gets out of the way of dense, fast,
keyboard-driven work.

## What's actually wrong (grounded in the current build)

Screenshots of the shipped app (`chat.png`, `settings.png`, `01_anthropic.png`)
show:
- Sidebar, top strip, canvas, and composer all sit within a few % luminance of
  each other on the same near-black field — nothing tells the eye what's
  chrome versus content versus the one thing that matters right now.
- At 1440pt wide the empty-chat canvas is a single centred column adrift in a
  black field with no edge, no frame, no anchor — "floating text in the void,"
  not "a panel inside an instrument."
- The periwinkle accent appears on the selected nav row, the "Ask first" pill,
  the model-picker dot, and one word of placeholder copy ("**ask**") — four
  unrelated uses, no shared meaning. An accent used for decoration stops being
  legible as a signal.
- Nearly all text renders at `Kind.body` (13pt); `Kind.hero`/`.title` exist in
  the token file but are barely exercised, so there is no editorial contrast
  anywhere except one hero string on the empty state.
- The top strip is four segmented buttons plus two flat pills in a row with no
  grouping, weight, or density decision behind it — it reads as unstyled
  system controls, not considered chrome.

## Research (verified this pass, not recalled)

- **Linear**: depth from a surface ladder (`#0f1011`→`#18191a`→`#191a1b`) plus
  hairlines (`#23252a`→`#3e3e44`) on a near-black `#010102` floor — almost no
  shadow anywhere. One chromatic accent (`#5e6ad2`), deployed only on the brand
  mark, focus rings, and one primary CTA per section — no second hue, no
  ambient gradient. [How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui), [Linear design system](https://styles.refero.design/style/90ce5883-bb24-4466-93f7-801cd617b0d1)
- **Raycast**: near-black canvas (`#07080a`), 1px hairlines (`#242728`), no
  colour on chrome surfaces at all — colour is reserved for category/extension
  identity (Slack red, Linear green), never for structural UI. [Raycast design system](https://getdesign.md/raycast/design-md)
- **Warp**: elevation is exactly `bg → surface → surface-2`, nothing deeper.
  Density-first: users tolerate small targets because it's a pro tool.
  Tabular numerals on every metric. [Warp design analysis](https://www.getmd.design/voltagent/preview/warp.html), [How we designed Warp's themes](https://www.warp.dev/blog/how-we-designed-themes-for-the-terminal-a-peek-into-our-process)
- **Zed**: macOS-native chrome (native window tabbing, `.SystemUIFont`
  default), UI density is a first-class, user-visible setting, not an
  afterthought. [Zed appearance docs](https://zed.dev/docs/appearance)
- **Apple HIG — Materials**: vibrancy is for sidebars/toolbars specifically —
  it pulls colour forward from whatever's behind the window to anchor the app
  to the desktop, and materials are chosen per-role (sidebar, popover, title
  bar), not applied uniformly. [HIG: Materials](https://developer-mdn.apple.com/design/human-interface-guidelines/foundations/materials/)

Common thread across all four tools: **structural hierarchy comes from value
steps and hairlines, colour is rationed to almost nothing, and the one hue
that exists means one specific thing.** NexusCode already has the plumbing for
this (`ElevationLadder` 0–3, `MaterialUsage`, `AccentSystem`) — it has simply
never been used with a rule behind it. This pass adds the rule.

## The surface ladder

Four levels already exist in `AppTheme.elevation` (`ElevationLadder.level0…3`).
The rule that was missing: **each level is a named ROLE, not a free choice.**

| Level | Role | Used by |
|---|---|---|
| **0 — sunken** | Recessed, "below" the working surface | composer text field interior, code blocks, the window's outermost background |
| **1 — base** | The working surfaces themselves | sidebar, top chrome strip, status bar, **the canvas panel** |
| **2 — overlay** | Floats above level 1 | dropdowns, popovers, the picker sheets |
| **3 — modal** | Always on top | approval sheets, command palettes |

The fix this pass makes structural, not cosmetic: **the canvas is level 1,
never the level-0 window floor.** Today the transcript/empty-state renders
directly on the window background, so it has no edge — that's the "void" the
owner is reacting to. Going forward the canvas is a bounded panel: inset from
the window by `Space.lg`, level-1 surface colour, a `hairline` border on all
four sides. Content inside it may still be a `ScrollView` that's visually
borderless, but the PANEL always has an edge. This is the single highest-
leverage change in this document — it is what turns "text floating in black"
into "an instrument with a screen."

Elevation is **surfaces + 1px hairlines, never drop shadows** — unchanged,
non-negotiable, already the house rule (`DesignSystem.swift`'s `hairline` doc
comment). Shadows over a near-black canvas read as grey smudge; Cinder and
Nightfall are allowed a soft shadow at rest specifically because they render
real material over it, per the existing carve-out.

This was tested against, not just assumed, for one more candidate this pass:
a supplementary shadow under the composer on focus, alongside its existing
2px `chromeBorderFocus` border. Measured on Meridian at full window size, the
border alone already reads as an unmissable focus signal; the shadow added
only a barely-perceptible edge on top of it — a second signal for the one
meaning "this has focus," and the exact register (a glow under the composer)
the owner already called out as cheap once. Rejected — the border is the
whole signal, no exception, the rule stays unqualified.

## Type scale

`Kind` (`DesignSystem.swift`) already matches real macOS metrics (Body 13,
Headline 13 bold, Title3 15, Title2 17, Title1 22 — HIG documented, not
invented) and stays as-is. What changes is **usage discipline**, enforced per
screen in this pass:

- Every screen has exactly one `Kind.hero` or `Kind.title` moment establishing
  what this screen IS — never zero, never two competing ones.
- `Kind.section` (11pt, uppercase, tracked) labels every distinct group — a
  screen with unlabelled stacked content is a screen that hasn't decided its
  own structure.
- `Kind.body` stays 13pt but is **primary-content only** when set in
  `textPrimary`; anything set in `textMuted` must be genuinely secondary
  (metadata, timestamps, hints) — `textMuted` is not a way to make ordinary
  content quieter, it's a semantic demotion.
- `Kind.mono`/`.monoSmall` are reserved for literal machine output — the
  `nexus` command line, raw JSON, diffs, model IDs, provider/model/role picker
  values. Plain English control copy (a button label, a toggle's name) is
  never mono, even sitting right next to a mono value — that's the "terminal
  wearing a window" problem HIG's materials note warns about.

## Colour system

One functional accent (`AccentSystem.primary`, periwinkle in Meridian), one
secondary accent, and the neutral surface ladder for everything else — this
was already the intended shape (Linear runs the identical model: one hue, two
places). What was missing is the rule for **when accent is earned**:

Accent is allowed on exactly three things, because these are the only three
places "this is live / this is yours to act on" is a real signal:
1. **Current selection / navigation position** — the active sidebar row, the
   active tab.
2. **The one primary action per independent section** — Send, the focused CTA
   in an empty state, one `RunButton` per self-contained card on a screen
   built from several independent tool cards (Git's Explain/Review/Commit/PR
   each run a genuinely different command — this is Linear's own rule, cited
   above, "one primary CTA per section," not "per screen"; a single-flow
   screen like Chat still gets exactly one, because it has exactly one
   section). Never two competing accent CTAs answering the SAME decision.
3. **Live/running state** — `StatusDot` while a run is active, streaming text
   cursor, an active-count badge.

Also never a shadow standing in for the same live/running signal a border or
dot already carries on the same element — measured and rejected twice this
pass (the composer's focus shadow, `AgentCard`'s running-state glow): one
signal per meaning, and elevation is surfaces + hairlines regardless of what
that signal is.

**A condition that applies to an entire SET gets one marker on the set,
never one marker per member.** Established when a model-list warning was
first proposed per-row (`PickerOption.warning`, the amber triangle a
write-capable role already earns) for `NexusModel.isVerified`: verification
isn't a per-row fact — when a probe can't run, EVERY model in that
provider's list comes back `.fallback` together, so a per-row treatment
paints one fact as N warnings, spending the accent/attention budget this
section rations for nothing. The fix was one quiet, neutral caption on the
model picker as a whole (`ControlStrip.modelListVerificationCaption`),
appearing only while the WHOLE list is unverified. The same question is
worth asking of any future warning: is this true of one row, or of the set
that row belongs to?

Accent is NOT allowed on: decorative icon tints, placeholder copy, static
segmented-control tracks that aren't mid-interaction, dropdown chevrons, or
"because the row needs some colour." `accentSecondary` is reserved for
provider/model identity badges (the existing per-provider tokens already
carry this) so a provider tag never competes with the primary accent for
attention. Every other surface stays on the neutral ladder:
`textPrimary`/`textSecondary`/`textMuted` over `surface(0…3)`.

## Density and rhythm

Base unit is **4pt** (the existing `Space.xs`), composing exactly as `Space`
already defines it (4/6/8/12/20/32 — HIG's 6pt-in-group / 8pt-between-group /
20pt-window-margin baseline). That scale is right and doesn't change. What's
added: the canvas panel margin is `Space.lg` (12pt) from the window edge on
all sides, and its internal content gets a **max content width** (680pt for
the transcript column, matching a reading measure a dense tool actually wants —
not full-bleed at 1440pt) so text never stretches into an unreadable single
line at wide window sizes. The composition rule holds unchanged: fixed header
+ one region owning remaining height, never top-align short content in a tall
scroll view.

## Motion

Motion communicates a state change, full stop — never decoration. What
animates: the running-state pulse (`StatusDot`), hover/press feedback on real
controls (0.12s ease-out, already right), a sheet or popover's appear/dismiss,
and streamed text arriving token-by-token. What stays still: static chrome,
list rows at rest, anything on screen that hasn't changed state. No bounce, no
spring on a dev tool's dismissal — Warp and Linear both read as instant
because nothing moves that doesn't have to.

## Non-negotiables (unchanged from the brief)

- Elevation is surfaces + hairlines, never drop shadows.
- Contrast floors are asserted by `AppThemeTests` (22 tests) — run them.
- Determinism: no `UUID()` or wall-clock reads in derived view state.
- Fixed header + one region owning remaining height; never top-align short
  content in a tall scroll view.
- All seven hand-authored themes (Meridian, Studio, Cinder, Daylight, Basalt,
  Vantage, Nightfall) keep working. If the system's shape changes, migrate
  them — don't leave one behind.

## Per-screen application

- **Sidebar**: level-1 surface, `materials.sidebar` treatment honoured (not
  overridden to solid), nav row selection is the ONLY accent use in the
  sidebar.
- **Top chrome**: level-1 surface, distinct from the canvas below it by a
  hairline — mode switcher (Ask/Agent/Compare/Race) reads as one grouped
  control, not four independent pills; the model/provider pickers are visually
  demoted to `textSecondary` unless actively open.
- **Canvas**: level-1 bounded panel per "surface ladder" above — this is the
  fix for "text floating in a void."
- **Composer**: level-0 sunken field inside the level-1 canvas panel — it
  should read as recessed relative to its container, which is what "sunken"
  is for and what currently isn't happening. Focus is the border alone
  (`chromeBorderFocus`, 2px) — no supplementary shadow; see "surface ladder"
  above for why that was tried and rejected.
- **Transcript**: max content width per "density and rhythm," `Kind.mono` only
  for literal machine output.
- **Empty states**: `HeroEmptyState` keeps its hero glyph/gradient (the one
  earned use of `accentGradient` per screen) but must sit inside the now-
  framed canvas panel, not the raw window background.
- **Pickers / dropdowns**: level-2 overlay, always with a hairline, never
  accent-tinted unless representing the current selection.
- **Buttons**: `SoftButton` unchanged in mechanics; `.accent` tone reserved for
  the one primary action per screen per the colour rule above.
- **Badges** (`CountPill`): neutral tone by default; `.accent` only when the
  count reflects something currently live (an active run count), not a static
  total.
- **Status** (`StatusDot`, `Metric`): the status bar is the other legitimate
  home for `accentSecondary` (live cost/token counters) alongside the primary
  accent's running-state dot — the two are allowed to coexist here because
  they're both live data, not decoration.
