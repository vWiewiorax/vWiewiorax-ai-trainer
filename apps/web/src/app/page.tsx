import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-950 p-8 text-center text-slate-100">
      <h1 className="text-3xl font-bold">Silnik analizy techniki ćwiczeń</h1>
      <p className="max-w-xl text-slate-300">
        Demo działa na żywym obrazie z kamery: estymacja pozy (MediaPipe), analiza biomechaniczna, liczenie powtórzeń, ocena techniki martwego ciągu i podpowiedzi w czasie rzeczywistym.
      </p>
      <Link href="/lab" className="rounded-lg bg-emerald-500 px-5 py-3 font-semibold text-slate-950">
        Otwórz analizę na żywo
      </Link>
    </main>
  );
}
