import type { Metadata } from "next";
import LiveLab from "@/components/lab/LiveLab";

export const metadata: Metadata = {
  title: "Analiza techniki na żywo - martwy ciąg",
  description: "Demo silnika analizy ruchu: kamera, estymacja pozy, liczenie powtórzeń i ocena techniki.",
};

export default function LabPage() {
  return <LiveLab />;
}
