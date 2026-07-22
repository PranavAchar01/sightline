import Call from "@/components/Call";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 bg-black px-6 py-16 text-white">
      <header className="flex max-w-2xl flex-col gap-4 text-center">
        <h1 className="text-5xl font-semibold tracking-tight">Sightline</h1>
        <p className="text-lg leading-relaxed text-neutral-400">
          Support calls die on one sentence: <em>&ldquo;can you describe what you&rsquo;re
          seeing?&rdquo;</em> Sightline&rsquo;s voice agent watches the customer&rsquo;s screen
          instead — diagnosing from what&rsquo;s actually there, then filing the ticket itself.
        </p>
      </header>

      <Call />

      <footer className="max-w-md text-center text-xs leading-relaxed text-neutral-600">
        Desktop Chrome or Edge. You&rsquo;ll be asked to share a screen and allow your
        microphone. Nothing is recorded — frames are held only for the length of the call.
      </footer>
    </main>
  );
}
