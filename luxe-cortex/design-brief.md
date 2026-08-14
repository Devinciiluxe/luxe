# JARVIS CORTEX — design brief

## Design read
For an agency operator running an automated inbound/outbound sales engine. Emotional register: mission-control calm inside a cyberpunk HUD — dense telemetry, but every number is alive and every action is instant.

## Concept spine
"The machine thinks in a glowing brain; you steer it." The app IS the video's neural command center made real: a left telemetry rail, a 3D brain of lead-nodes in the center, a live chat/automation layer over it, a right analytics stack, and a command palette to talk to the system.

## Delivery tier
spectacle — real WebGL (Three.js, lazily client-only) brain on a perspective grid, full interactive dashboard around it. This is an app surface, not a scroll page; the animated-website scroll-scrub journey is intentionally n/a.

## Locked palette (direct lift from the reference video)
- bg deep slate: `#070a0f`, panels `#0b0e14` with glass translucency
- neural cyan: `#00F2FE` (idle nodes, structure, checkmarks, telemetry)
- signal magenta: `#FF007F` (active sweep, alerts, processing, CTA heat)
- warn amber: `#FF9F43` (no-show / pending flags, yellow triangles)
- text primary `#e8eef4`, secondary `#8b98a5`
Justification: user-supplied frame forbids the banned-palette checklist; exact hexes above are the contract.

## Locked type
- Display/UI: "Space Grotesk" (futuristic sans) — titles, labels, buttons
- Telemetry/numbers: "IBM Plex Mono" — counters, logs, timestamps
Google Fonts via link; both variable weights.

## Layout (video-faithful, three-column command center)
- Header: angled corner brackets; JARVIS logotype center, INBOUND CORTEX left, utility icons right
- Left rail: Lead Hunter live scrape log (status triangles/checks + numbers), bottom sparkline
- Center: 3D brain = each glowing node is a lead linked to neighbors; slow orbit; magenta wave sweeps when that lead is active in chat or automation; click node → opens its chat thread; bottom: Diagnostics + Database Metrics sliders/meters
- Right rail: KPIs (Win Rate/progress index, pipeline value $, active nodes count, automation RUNNING chips, vertical bar graphs, radial efficiency dial)
- Chat layer: Automation Replies drawer + a persistent Chat panel with a message input — typing sends messages, Jarvis auto-replies, node glow follows
- Command bar: ⌘K to control automations (run hunter, pause outreach, send pending replies)

## Hard data contract
D1 tables: leads, conversations, messages, events, proposals, settings. All mutations via server functions. A Durable Object NexusHub fans live events (node glow, new lead, chat reply, metric flicker) to every open tab over WebSocket/SSE. Local fallback: `wrangler dev` works with migrations + local DO.

## Copy
Real terse ops copy ("Pending replies", "Hot queue", etiquette of automation statuses). No lorem ipsum, no em-dashes.

Acceptance gates: no console errors, no dead CTAs, all reveal motion SSR-safe, mobile frame keeps the HUD readable via scaled canvas + stacked panels.
