import { createFileRoute } from "@tanstack/react-router";

import { ScrollScrub } from "@/components/scroll-scrub/scroll-scrub";
import { scrollScrubScenes, scrollScrubTheme } from "@/scroll-scrub-scenes";

export const Route = createFileRoute("/")({
  component: Index,
});

const BOOK = "bookings@luxedesign.online";

const mailto = (subject: string) =>
  `mailto:${BOOK}?subject=${encodeURIComponent(subject)}`;

function Index() {
  return (
    <main className="luxe">
      <div className="luxe-veil" aria-hidden="true" />
      <TopNav />
      <ScrollScrub scenes={scrollScrubScenes} theme={scrollScrubTheme} />
      <Sections />
    </main>
  );
}

function TopNav() {
  return (
    <header className="luxe-nav">
      <a className="luxe-brand" href="#arrival" aria-label="LUXEdesign home">
        <span className="luxe-brand-mark" aria-hidden="true" />
        <span className="luxe-brand-word">
          LUXE<em>design</em>
        </span>
      </a>
      <nav className="luxe-nav-links" aria-label="Site">
        <a href="#experience">The Experience</a>
        <a href="#packages">Packages</a>
        <a href="#process">Process</a>
        <a className="luxe-nav-cta" href={mailto("Booking inquiry — a property flythrough")}>
          Book a flight
        </a>
      </nav>
    </header>
  );
}

function Sections() {
  return (
    <div className="luxe-after">
      <section className="luxe-packages" id="packages" aria-labelledby="packages-title">
        <p className="luxe-kicker">Packages &amp; pricing</p>
        <h2 className="luxe-h2" id="packages-title">
          Three flights. <em>One take each.</em>
        </h2>
        <p className="luxe-lede">
          Every flight is flown by a licensed, insured FPV pilot, graded frame by
          frame, and mastered in 4K HDR. Pricing is flat and fixed by interior
          square footage — no surprises.
        </p>

        <div className="luxe-tier-grid">
          <article className="luxe-tier">
            <p className="luxe-tier-name">The Signature Flight</p>
            <p className="luxe-tier-price">
              $800 <span>flat</span>
            </p>
            <p className="luxe-tier-size">Homes up to 3,500 sq ft</p>
            <ul>
              <li>One continuous interior-to-exterior flythrough, 60–90 seconds</li>
              <li>4K HDR cinema grade</li>
              <li>Licensed &amp; insured pilot, half-day on site</li>
              <li>48-hour delivery, full social &amp; listing rights</li>
            </ul>
            <a className="luxe-btn" href={mailto("Booking — The Signature Flight ($800)")}>
              Book Signature
            </a>
          </article>

          <article className="luxe-tier luxe-tier--featured">
            <p className="luxe-tier-flag">Most requested</p>
            <p className="luxe-tier-name">The Estate Flight</p>
            <p className="luxe-tier-price">
              $1,400 <span>flat</span>
            </p>
            <p className="luxe-tier-size">Homes up to 10,000 sq ft</p>
            <ul>
              <li>Two flight passes — interior flythrough + exterior orbit</li>
              <li>Licensed aerial drone for establishing shots</li>
              <li>Vertical cut for Reels, TikTok &amp; Shorts included</li>
              <li>Twilight flight option</li>
              <li>48-hour delivery, full rights</li>
            </ul>
            <a className="luxe-btn luxe-btn--gold" href={mailto("Booking — The Estate Flight ($1,400)")}>
              Book Estate
            </a>
          </article>

          <article className="luxe-tier">
            <p className="luxe-tier-name">The Estate Grand Tour</p>
            <p className="luxe-tier-price">
              $2,000 <span>from</span>
            </p>
            <p className="luxe-tier-size">Estates above 10,000 sq ft</p>
            <ul>
              <li>Multi-day production, every wing fully covered</li>
              <li>All passes, all altitudes, interior + aerial + twilight</li>
              <li>Dedicated film editor, custom music licensing</li>
              <li>Full asset library delivered — master film, stills, socials</li>
            </ul>
            <a className="luxe-btn" href={mailto("Booking — The Estate Grand Tour (from $2,000)")}>
              Book Grand Tour
            </a>
          </article>
        </div>
        <p className="luxe-note">
          Every package: $250 deposit to lock the date, balance on delivery.
          Travel within 50 miles included.
        </p>
      </section>

      <section className="luxe-process" id="process" aria-labelledby="process-title">
        <p className="luxe-kicker">How it works</p>
        <h2 className="luxe-h2" id="process-title">
          Booking to delivery <em>in four steps.</em>
        </h2>
        <ol className="luxe-steps">
          <li>
            <span className="luxe-step-n">01</span>
            <h3>Book your date</h3>
            <p>
              Email the property address and your preferred date. We confirm
              within 24 hours; a $250 deposit locks the slot.
            </p>
          </li>
          <li>
            <span className="luxe-step-n">02</span>
            <h3>The flight day</h3>
            <p>
              Half-day on site. We walk the route with you, then fly it —
              usually in fewer than ten takes, always chasing the best light.
            </p>
          </li>
          <li>
            <span className="luxe-step-n">03</span>
            <h3>Edit &amp; grade</h3>
            <p>
              The best take is edited, stabilized to silk, and color-graded
              frame by frame to cinema standard.
            </p>
          </li>
          <li>
            <span className="luxe-step-n">04</span>
            <h3>Delivery in 48 hours</h3>
            <p>
              Master 4K film plus every cut you booked — web, listing, vertical.
              Yours outright, forever.
            </p>
          </li>
        </ol>
      </section>

      <section className="luxe-book" id="book" aria-labelledby="book-title">
        <p className="luxe-kicker">Reserve your flight</p>
        <h2 className="luxe-h2" id="book-title">
          Your home earned <em>its close-up.</em>
        </h2>
        <p className="luxe-lede">
          Tell us the address and the date. We reply within 24 hours with a
          confirmed flight window.
        </p>
        <div className="luxe-book-actions">
          <a
            className="luxe-btn luxe-btn--gold luxe-btn--big"
            href={mailto("Booking inquiry — a property flythrough")}
          >
            Email bookings@luxedesign.online
          </a>
          <p className="luxe-book-fine">
            LUXEdesign.online — booking nationwide
          </p>
        </div>
      </section>

      <footer className="luxe-footer">
        <p className="luxe-footer-brand">
          LUXE<em>design</em>
        </p>
        <p className="luxe-footer-line">
          Cinematic drone flythroughs of exceptional homes.
        </p>
        <p className="luxe-footer-legal">
          © {new Date().getFullYear()} LUXEdesign.online · Licensed &amp; insured
          drone operations · bookings@luxedesign.online
        </p>
      </footer>
    </div>
  );
}
