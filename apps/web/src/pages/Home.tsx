import { Link } from 'react-router-dom';
import { useSession } from '../lib/session.js';
import { AccountMenu } from '../components/AccountMenu.js';
import { Specimen } from '../components/Specimen.js';
import { ThemeToggle } from '../components/ThemeToggle.js';
import { VERA } from '../components/Vera.js';

/**
 * The landing page has one job: show a stranger what a cited answer looks like
 * before asking them to sign in for one. Everything here is written for
 * someone who has not read the README — the loop's own stage names, the
 * retrieval vocabulary and the architecture live inside the app, where there
 * is a trace drawer to make them mean something.
 */

/** The bar's links, named for what the section answers. */
const SECTIONS = [
  { href: '#features', label: 'Features' },
  { href: '#how', label: 'How it works' },
];

/** What you actually do, in the order you do it. */
const STEPS = [
  {
    title: 'Add your material',
    body: 'PDFs, typed notes, photos of a whiteboard, lecture recordings, voice notes. Scanned pages work too — the words inside the image are read out and indexed like any other text.',
    aside: 'or connect a mailbox and let the corpus keep arriving on its own',
  },
  {
    title: 'Ask in plain language',
    body: 'No keywords, no syntax. Follow-ups work the way they do in conversation: ask “and what about in the recording?” and it knows what “that” meant.',
    aside: 'every question stays in a thread you can return to',
  },
  {
    title: 'Check the answer',
    body: 'Each claim carries a small number. Press it and the source opens beside the answer — the rendered page, or the recording seeked to the second the sentence was spoken.',
    aside: 'this is the part worth trying first',
  },
];

/**
 * What it reads. The file extensions are the point: a stranger scanning this
 * page wants to know whether their own pile of material is the kind this
 * handles, and a list of real extensions answers that faster than a sentence
 * about "multimodal ingestion" ever will.
 */
const READS = [
  {
    kinds: '.pdf  .txt  .md  .docx',
    title: 'Your documents',
    body: 'Lecture PDFs, typed notes, papers, handbooks. A scanned page with no text layer is read by OCR, so a photocopied chapter is as searchable as a typed one.',
  },
  {
    kinds: '.mp4  .mov  .mp3  .m4a  .wav',
    title: 'Your recordings',
    body: 'Lecture video and voice notes are transcribed with timestamps kept. An answer can cite fourteen seconds into a two-hour class, and open the player there.',
  },
  {
    kinds: '.png  .jpg  .webp',
    title: 'Your photos and figures',
    body: 'A photograph of a whiteboard, a slide, a diagram. The words inside the picture are read out and indexed, and the figure itself is what a citation opens.',
  },
  {
    kinds: 'imap  ·  gmail',
    title: 'Your inbox',
    body: 'Connect a mailbox and every message and attachment joins the corpus on a timer. Sender and date are indexed too, so “what did my supervisor say about the deadline” is a question you can actually ask.',
  },
];

export function Home(): React.ReactElement {
  const { phase } = useSession();
  const signedIn = phase === 'signed-in';
  const target = signedIn ? '/app' : '/signin';
  const cta = signedIn ? 'Open your corpus' : 'Try it';

  return (
    <div className="ground min-h-screen text-ink">
      <header className="sticky top-0 z-20 rule-hair bg-paper/95 px-6 py-3.5 backdrop-blur">
        <div className="mx-auto flex max-w-[1240px] items-center gap-6">
          {/* The same mark the app wears, so the front page and the thing it
              is advertising are visibly one product: a page with a rule
              through it — a document, and the line pointing at the part that
              was cited. */}
          <Link to="/" className="flex shrink-0 items-center gap-2 leading-none text-ink">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden>
              <rect
                x="2.5"
                y="1.5"
                width="11"
                height="13"
                rx="2"
                stroke="var(--ink)"
                strokeWidth="1.4"
              />
              <line
                x1="5"
                y1="9"
                x2="11"
                y2="9"
                stroke="var(--vermillion)"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
            <span
              className="font-display text-[21px] font-semibold"
              style={{ fontOpticalSizing: 'auto' }}
            >
              trace
            </span>
          </Link>

          <nav className="hidden items-center gap-1 sm:flex">
            {SECTIONS.map((section) => (
              <a key={section.href} href={section.href} className="nav-link">
                {section.label}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2.5">
            {/* The button says where it goes. "open" said nothing — it was the
                signed-in half of a sign-in button and read as a stray verb. */}
            <Link
              to={target}
              className="rounded-md px-3.5 py-1.5 text-[13px] font-medium"
              style={{ backgroundColor: 'var(--ink)', color: 'var(--paper)' }}
            >
              {signedIn ? 'Dashboard' : 'Sign in'}
            </Link>

            <span className="h-5 w-px shrink-0" style={{ backgroundColor: 'var(--rule)' }} />

            <ThemeToggle />
            <AccountMenu />
          </div>
        </div>
      </header>

      <main>
        {/* The hero holds the first screen on its own, down to the button.
            The claim and the evidence for the claim belong together, and
            nothing from the next section should peek above the fold and invite
            a skim before either has been read. min-height rather than height:
            on a short window the content still grows and scrolls instead of
            being clipped by its own frame. */}
        <section className="mx-auto flex min-h-[calc(100svh-var(--bar))] max-w-[1100px] flex-col justify-center gap-10 px-6 py-12 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)] lg:items-center lg:gap-12">
          <div className="min-w-0">
            <h1
              className="max-w-[16ch] font-display text-[clamp(2rem,5.2vw,3.3rem)] font-semibold leading-[1.06]"
              style={{ fontOpticalSizing: 'auto' }}
            >
              Every sentence points at the page it came from.
            </h1>

            <p className="measure mt-5 text-[15px] leading-relaxed text-ink-muted">
              Ask questions about your own files — notes, textbooks, recordings, photos — and get
              answers you can check. Press any claim and it opens the exact page, or the exact
              second in the recording, that it came from.
            </p>

            <p className="measure mt-3 text-[15px] leading-relaxed text-ink-muted">
              If your files do not hold the answer, {VERA} says so instead of inventing one.
            </p>

            <div className="mt-7">
              <Link
                to={target}
                className="rounded-md px-4 py-2.5 text-[13px] font-medium"
                style={{ backgroundColor: 'var(--vermillion)', color: '#fff' }}
              >
                {cta}
              </Link>
            </div>
          </div>

          <div className="min-w-0">
            <Specimen />
          </div>
        </section>

        {/* What it reads comes before what it does with it: a visitor's first
            question is whether their own pile of material is the kind this
            handles at all. */}
        <section id="features" className="border-t border-rule bg-paper-sunk py-14">
          <div className="mx-auto max-w-[1100px] px-6">
            <h2 className="font-display text-[26px] font-semibold text-ink">
              Point it at anything you already have
            </h2>
            <p className="measure mt-2.5 text-[14px] leading-relaxed text-ink-muted">
              Five kinds of file and a mailbox, all through the same pipeline, all ending up equally
              searchable and equally citable. A voice note is not a second-class source here.
            </p>

            <div className="mt-8 grid gap-x-10 gap-y-9 sm:grid-cols-2">
              {READS.map((item) => (
                <article key={item.title} className="min-w-0">
                  <p
                    className="font-mono text-[11px] tracking-[0.02em]"
                    style={{ color: 'var(--vermillion)' }}
                  >
                    {item.kinds}
                  </p>
                  <h3 className="mt-2 font-display text-[19px] font-semibold leading-snug text-ink">
                    {item.title}
                  </h3>
                  <p className="mt-1.5 max-w-[46ch] text-[13.5px] leading-relaxed text-ink-muted">
                    {item.body}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="how" className="border-t border-rule py-14">
          <div className="mx-auto max-w-[1100px] px-6">
            <h2 className="font-display text-[24px] font-semibold text-ink">
              Three things to do, in this order
            </h2>

            {/* Cards, and a numbered sequence rather than three cards that
                happen to sit in a row: the rule running between them says the
                order matters, and the last one does not get a tail because
                there is nothing after it. */}
            <ol className="step-row mt-8 grid gap-5 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="step-card">
                  <span className="step-n" aria-hidden>
                    {index + 1}
                  </span>
                  <h3 className="mt-4 font-display text-[18px] font-semibold leading-snug text-ink">
                    {step.title}
                  </h3>
                  <p className="mt-2 flex-1 text-[13.5px] leading-relaxed text-ink-muted">
                    {step.body}
                  </p>
                  <p className="mono-meta mt-4 border-t border-rule pt-3 leading-snug">
                    {step.aside}
                  </p>
                </li>
              ))}
            </ol>

          </div>
        </section>

        <section className="mx-auto max-w-[1100px] px-6 py-16">
          <div className="measure">
            <h2 className="font-display text-[26px] font-semibold leading-snug text-ink">
              Point {VERA} at your own documents.
            </h2>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-muted">
              Your PDFs, your lecture recordings, your mail — answerable in a sentence you can
              check. There is a sample corpus loaded already, so you can ask something before
              adding anything of your own.
            </p>
            <Link
              to={target}
              className="mt-6 inline-block rounded-md px-4 py-2.5 text-[13px] font-medium"
              style={{ backgroundColor: 'var(--ink)', color: 'var(--paper)' }}
            >
              {cta}
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-rule px-6 py-6">
        <p className="mono-meta mx-auto max-w-[1100px]">
          trace · answers from your own documents, with citations that resolve
        </p>
      </footer>
    </div>
  );
}
