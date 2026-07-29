# NexusCode — Design Thesis

This replaces a thesis that was rejected four times. It is not a refinement of
it. Where a rule from the old document survives here, it survives because it
was re-derived independently and measured, not because it was already written
down.

## Why the last thesis failed

The old thesis was: *instrument, not chat toy* — ration the accent to exactly
three uses, depth from surfaces and hairlines and never shadows, restraint
everywhere. As a set of tastes it is defensible; Linear runs a near-identical
rulebook. It still produced an app the owner called flat, generic, and worse.

The reason is worth stating precisely, because it is the trap to avoid:

**Restraint only reads as expensive when there is something underneath it to
restrain.** Linear looks costly because beneath the restraint sit a display
face tracked to −3px, a 96px section rhythm, and a surface ladder whose steps
are genuinely visible. The old thesis adopted the *subtractions* — one accent,
no shadows, small type, quiet everything — and none of the substance. What
shipped was not restrained, it was empty. "Restrained" and "nothing there" look
identical in a screenshot.

So this thesis adds. Every rule below either introduces contrast that was
absent or fixes something that measured wrong.

## What was actually wrong — measured, not asserted

Sampling the shipped build at 1440x900 on Meridian (relative luminance, WCAG):

| surface | intended role | measured |
|---|---|---|
| sidebar | darkest (`surfaceSunken`) | **0.0244 — the brightest large surface** |
| composer band | sunken | 0.0217 |
| canvas panel | raised, level 1 | 0.0123 |
| control strip | — | 0.0048 |

The depth order was exactly inverted, and the four surfaces sat in essentially
random value order. **No token was wrong.** `.ultraThinMaterial` was applied
directly to the sidebar, and a thin material over a near-black token does not
render near-black — it renders whatever is behind the window, lightened. The
material was overruling every token in the theme. That single defect is most of
why the chrome pulled the eye and the content read as a hole.

Three more, from the same screenshots:

- **The "instrument frame" did nothing.** The old thesis called `CanvasPanel`
  its highest-leverage change. On screen its border was invisible (panel and
  floor were within a hair of each other) and its 12pt inset spent 24pt of
  width and height on a gutter that communicated nothing — on the screen whose
  central complaint was dead space.
- **The transcript had no structure.** A prompt was bold 13pt text; an answer
  was 13pt text with a 2px grey rule beside it. The only differentiator was
  font weight, and the rule carried no information because it was identical on
  every turn.
- **The type ramp never used its own range.** One 28pt hero per screen, and
  everything else at 11–13pt with default tracking.

## Identity: a console for many minds

The one thing this product knows that no general chat app does is
**provenance** — which backend answered, on what model, at what cost. That is
the whole reason the app exists, and it was rendered as grey text in two
places.

Provenance is now the visual signature. Every answer is introduced by its
provider's identity colour and model id. This is also what stops the result
from being a Linear tribute act: it is the one axis where NexusCode has more to
say than its references do.

## Type

`TextStyle` carries face, tracking and leading as one value — the old `Kind`
handed back a bare `Font`, which is precisely why nothing in the app had
considered tracking or leading.

| role | size | weight | tracking | leading |
|---|---|---|---|---|
| `display` | 32 | bold | −0.9 | — |
| `title` | 20 | semibold | −0.4 | — |
| `heading` | 15 | semibold | −0.15 | — |
| `prose` | 15 | regular | −0.05 | +5.5 |
| `body` | 13 | regular | — | — |
| `label` | 12 | **medium** | — | — |
| `caption` | 11.5 | regular | — | — |
| `eyebrow` | 10.5 | semibold | +0.8 | — |
| `mono` | 12 | regular | — | — |
| `monoMicro` | 10.5 | medium | — | — |

Three decisions carry this:

1. **Negative tracking at display sizes.** At 32pt, SwiftUI's default letter
   spacing is the difference between "a headline" and "some big text". This is
   the most reliable "designed, not default" signal available in a UI face.
2. **`label` is `.medium`, not `.regular`.** The half-step between regular and
   semibold makes a control's name read as deliberate without a bold's density.
   It is the single most-copied decision in Linear's type system.
3. **`prose` is 15pt with generous leading**, not 13pt. This is the surface a
   user reads all day; 13pt at default leading is why the transcript read as a
   debug dump rather than writing. Claude and ChatGPT both sit in this register.

Sizes stay anchored to real macOS metrics rather than invented ones — that part
of the old system was right and is kept.

## Depth: luminance stacking, lit from above

A dark UI has no overhead light to cast a shadow downward, so a drop shadow
over near-black renders as grey smudge. That much the old thesis had right, and
shadows at rest stay banned. But "surfaces and hairlines" alone was not enough
to make anything look like material. Depth is now two things:

- **Luminance** — each rung measurably lighter than the one below it.
- **A specular edge** — the bright 1px line along a raised surface's *top*,
  where it turns toward the ambient light (`Depth.specular`). This is the
  mechanism that was missing entirely, and it is what separates a dark UI that
  looks like real material from one that looks like flat swatches.

The specular edge is not the "cheap glow" that was rejected before. A glow is a
coloured halo bled around an element to make it shout; this is an achromatic
one-pixel line that only describes the surface's own geometry. A light theme
has the opposite physics, so it gets a bottom-weighted dark edge instead.

**Materials keep their translucency but lose control of value.** `themedFill`
draws the material for texture, then lays the surface's own colour back over it
at 82% (dark) / 55% (light). The native parallax survives; the material
deciding how light a surface is does not. That belongs to the theme.

Verified after the change, same sampling method:

| surface | before | after |
|---|---|---|
| status bar | — | 0.0025 |
| sidebar | 0.0244 | **0.0050** |
| canvas + control strip | 0.0123 | 0.0123 |
| composer | 0.0217 | 0.0137 |

Content is now 2.5× the chrome beside it, and the strip shares the canvas
surface rather than adding a fifth competing band.

## Colour

- **One structural accent per theme**, for selection, focus, the one primary
  action per section, and live state. Never decorative. This rule is kept
  because it was independently re-derived, and it is now actually enforceable:
  selection was previously a large `accentMuted` block that was, measurably,
  the loudest object on every screen.
- **Selection is a raised surface, not a colour wash.** The selected sidebar
  row sits one rung up the ladder with a specular edge, and the accent appears
  only as a 3pt rail. The row reads as lifted rather than painted, and the
  accent stays a signal.
- **Provider identity colours are load-bearing** (`ProviderIdentity`). They may
  appear anywhere provenance is shown and nowhere else. Following Raycast's
  rule — colour belongs to category identity, never structural chrome — these
  cannot collide with the accent's meaning because they never appear on a
  control.

## Space

The scale is unchanged at 4/6/8/12/20/32 — it is HIG-grounded, and swapping 6
for 8 would not have made anything read as modern. What was missing is the
**large** end: with nothing between 20 and 32, every screen had to choose
between cramped and cavernous. Added: `section` (28), `page` (40), `turn` (34).

Radii: control 7, card 11, panel 16.

## The transcript

The highest-stakes surface, and the least designed thing in the old build.

- **Reading measure 720pt**, up from 660. Claude and ChatGPT run ~768,
  Perplexity ~720; 660 at 15pt prose was landing under 60 characters a line.
- **The user's turn is a slab** — filled at level 2, inset from the leading
  edge, capped at 78% of the measure so the indent survives the longest prompt.
  Deliberately not a bubble: no tail, no capsule, no saturated fill, because
  round coloured bubbles read as casual texting and undercut the tool framing.
  But it *is* a container, because weight alone was not doing the job.
- **The assistant's turn is introduced by an attribution row** — provider
  identity dot, `provider/model` in mono, cache state, and the copy control.
  Shown on *every* turn, not only when the provider changed. Repetition is the
  point: a recurring anchor at a fixed rhythm is what lets the eye find turn
  boundaries while scrolling.
- **34pt between turns.** A turn boundary is the largest structural break the
  transcript has and must clearly outrank the 12pt used within a turn.
- **The composer docks with one hairline**, on the canvas's own surface. Two
  gradient scrims were tried and discarded — a scrim can only dissolve content
  it shares a colour with, and a fenced code block carries its own darker fill,
  so the scrim painted a visible lighter rectangle across the code instead of
  fading it.

## Empty states

The chat empty state is **composer-anchored**: kicker, headline, suggestions
and the composer itself sit together as one left-aligned group, vertically
centred. The old layout put the hero in the centre and pinned the composer to
the window's bottom edge, leaving ~40% of the window as unexplained black
between them — the "dead canvas" complaint, directly.

Shared empty states use `MarkPlate` — the glyph on a real level-2 surface with
a specular edge — instead of a 190pt radial glow. Same shape language as
everything else on screen, and it gives the composition a definite top edge to
hang from.

## Motion

Four durations, no springs. A spring on a developer tool's dismissal is what
makes it feel like a toy.

- `state` 0.12s — hover and press.
- `enter` 0.18s + 6pt rise — content arriving (a turn, a screen).
- `overlay` 0.22s — sheets and popovers.
- The running pulse, unchanged.

`enter` is the one addition: it is the difference between a UI that redraws and
one that responds.

## Non-negotiables

- Contrast floors are asserted by `AppThemeTests` — run them.
- Determinism: no `UUID()` or wall-clock reads in derived view state.
- Fixed header + one region owning remaining height; never top-align short
  content in a tall scroll view.
- All seven hand-authored themes and the 16 terminal palettes keep working. If
  the model's shape changes, migrate them — don't leave one behind.
- Drop shadows at rest stay banned on dark themes. The two that opted in
  (Cinder, Nightfall) render real material over them and are the documented
  exception.

## Verification

Green tests prove nothing about how something looks. Screenshot every screen at
1440x900 and at 900pt, on at least one dark and one light theme, and look at
the result — specifically at what the change disturbed, not only at whether it
landed.

Use a **fresh bundle id per verification round** and your own `--scratch-path`.
A reused bundle id once made WindowServer render a convincing, reproducible,
entirely fictional layout bug that survived three disproof attempts.

Two seams exist for this and are inert unless their env vars are set:
`NEXUS_UI_TAB` / `NEXUS_UI_THEME` / `NEXUS_UI_WIDTH` / `NEXUS_UI_HEIGHT` open
the app on a given screen at a given size, and `NEXUS_UI_DEMO=1` replays a
scripted ndjson transcript through the real decoder and reducer. The second
exists because the transcript is empty on a fresh launch, and every previous
design pass reviewed it blank — which is a large part of why it shipped with no
craft in it.
