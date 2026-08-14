/**
 * Scene data for the LUXEdesign scroll-scrub journey.
 *
 * ONE client-supplied 12s flythrough sliced into five strictly forward-tiling
 * legs. Each leg starts exactly where the previous ends (boundaries at
 * 0 / 2.45 / 4.90 / 7.35 / 9.70 / ~12.05s), so a chapter boundary freezes a
 * real frame of the flight and the engine crossfade between adjoining legs
 * carries motion without replay or rewind. Posters are exact first frames of
 * each encoded leg.
 *
 * Keep this array a module constant — changing its identity rebuilds the
 * media controller.
 */
import type {
  ScrollScrubScene,
  ScrollScrubTheme,
} from "@/components/scroll-scrub/scroll-scrub";

/** Brand tokens for the journey layer. */
export const scrollScrubTheme: ScrollScrubTheme = {
  accent: "#D8B36A",
  background: "#0B0A08",
  ink: "#F4EEE2",
  muted: "#C4B8A4",
};

export const scrollScrubScenes: ScrollScrubScene[] = [
  {
    body: "A first-person flight glides straight through your home and out to the horizon, captured in one shot. Scroll — you're flying it right now.",
    clip: "/assets/world/scene-01.mp4",
    id: "arrival",
    kicker: "LUXEdesign.online — Cinematic drone flythroughs",
    label: "Arrival",
    linger: 0.45,
    mobileClip: "/assets/world/scene-01-mobile.mp4",
    mobilePoster: "/assets/world/scene-01-mobile-poster.jpg",
    poster: "/assets/world/scene-01-poster.jpg",
    scroll: 2.2,
    tags: ["One continuous flight", "4K HDR cinema grade"],
    title: "Fly straight through your home.",
  },
  {
    align: "right",
    body: "Licensed FPV pilots thread your property in a single unbroken take — through doors, around corners, over the water. No cuts, no staging gimmicks. Your home, as it honestly is.",
    clip: "/assets/world/scene-02.mp4",
    id: "experience",
    kicker: "What we do",
    label: "Experience",
    linger: 0.45,
    mobileClip: "/assets/world/scene-02-mobile.mp4",
    mobilePoster: "/assets/world/scene-02-mobile-poster.jpg",
    poster: "/assets/world/scene-02-poster.jpg",
    scroll: 2.2,
    tags: ["Licensed & insured", "One take, no cuts"],
    title: "One take. Every corner.",
  },
  {
    body: "Homes up to 3,500 sq ft. One unbroken interior-to-exterior flight, edited and color-graded to cinema standard, delivered in 48 hours.",
    clip: "/assets/world/scene-03.mp4",
    id: "signature",
    kicker: "From $800 — The Signature Flight",
    label: "Signature",
    linger: 0.45,
    mobileClip: "/assets/world/scene-03-mobile.mp4",
    mobilePoster: "/assets/world/scene-03-mobile-poster.jpg",
    poster: "/assets/world/scene-03-poster.jpg",
    scroll: 2.2,
    tags: ["60-90 sec film", "4K HDR grade", "48-hour delivery"],
    title: "The Signature Flight.",
  },
  {
    align: "right",
    body: "Homes up to 10,000 sq ft. Two flight passes, exterior orbit, twilight option, and licensed-aerial establishing shots — the full cinematic package.",
    clip: "/assets/world/scene-04.mp4",
    id: "estate",
    kicker: "From $1,400 — The Estate Flight",
    label: "Estate",
    linger: 0.45,
    mobileClip: "/assets/world/scene-04-mobile.mp4",
    mobilePoster: "/assets/world/scene-04-mobile-poster.jpg",
    poster: "/assets/world/scene-04-poster.jpg",
    scroll: 2.2,
    tags: ["Two flight passes", "Exterior orbit", "Vertical cut included"],
    title: "The Estate Flight.",
  },
  {
    body: "Homes above 10,000 sq ft. A multi-day production with every pass, every angle, a dedicated film editor and a licensed aerial crew. The definitive record of your property.",
    clip: "/assets/world/scene-05.mp4",
    id: "grand",
    kicker: "From $2,000 — The Estate Grand Tour",
    label: "Grand Tour",
    linger: 0.45,
    mobileClip: "/assets/world/scene-05-mobile.mp4",
    mobilePoster: "/assets/world/scene-05-mobile-poster.jpg",
    poster: "/assets/world/scene-05-poster.jpg",
    scroll: 2.2,
    tags: ["Multi-day production", "Every angle, every pass"],
    title: "The Estate Grand Tour.",
  },
];
