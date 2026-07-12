# SciFigure Studio Design Contract

Last updated: 2026-07-12 01:25:59 +08:00

## Product Character

SciFigure Studio is a high-density scientific figure workspace. The authenticated product must feel precise, quiet, and operational. It inherits the public site's confident scientific identity without turning editing surfaces into a marketing page.

## Visual Language

- Brand ink: `#071411` and `#0b211c` for global navigation and strong hierarchy.
- Action green: `#176b5b` for primary commands, selected navigation, and active controls.
- Mint: `#8de6d1` for healthy, editable, saved, and live states.
- Warm gold: `#e6c26b` for pending confirmation and attention states.
- Signal red: `#d1543f` only for errors and destructive actions.
- Workspace: neutral gray-green surfaces (`#f3f6f5`, `#e9efed`) with white figure paper.
- Borders are subtle and functional. Radius is at most 8px for work surfaces.

## Typography

- Product UI: Aptos / Segoe UI / Microsoft YaHei fallback stack.
- Dense controls use 12-14px type; panel headings use 13-15px.
- Large display type is reserved for the public landing page and the authenticated home welcome area.
- Letter spacing remains zero except short uppercase technical labels.

## Information Architecture

- Global navigation answers: where am I, what project is active, and what is the primary next command.
- App sidebar owns product destinations, not editing tools.
- Editor icon rail owns editor modes.
- Left panel owns resources and object structure.
- Center owns figure, code, data, and render state.
- Right panel owns properties, layout, components, palette, and draft application.

## Component Rules

- Primary buttons use deep green; secondary buttons use white or pale mint.
- Tabs use a quiet underline or filled selected state without shifting layout.
- Status pills are compact and semantic; they are not decorative badges.
- Avoid cards inside cards. Page sections are unframed; cards are reserved for repeated projects/assets or framed tools.
- Icon-only controls require accessible labels and tooltips.
- Resize separators must remain visually discoverable without intercepting canvas interactions.

## Interaction And Safety Constraints

- Visual work must not change SVG hit testing, pointer capture, drag overlays, patch generation, Draft Batch, history, save persistence, figure identity, renderer routing, or export behavior.
- Editor sidebars remain resizable and preserve their current width state.
- Pending drag and draft actions remain visible above the canvas and must never block SVG pointer events.
- Motion is limited to meaningful state changes and must respect `prefers-reduced-motion`.

## Responsive Behavior

- Desktop is the primary authoring surface.
- At narrower widths, global navigation reduces labels before controls overlap.
- Editor side panels may hide at the existing breakpoint; the canvas and primary actions remain usable.
- Text must wrap or truncate within stable control dimensions.

## Verification Baseline

Every workspace visual change must pass TypeScript lint, unit tests, production build, public-auth smoke, and targeted editor interaction smoke tests. Desktop and mobile screenshots must be inspected for overlap, clipping, blank canvas, and inaccessible controls.
