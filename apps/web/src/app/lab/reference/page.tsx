import type { Metadata } from "next";
import VideoAnalysis from "@/components/lab/VideoAnalysis";

export const metadata: Metadata = {
  title: "Analiza nagrania i wzorzec trenera",
  description: "Ten sam silnik co analiza na żywo, uruchomiony na nagraniu: wzorzec ruchu trenera i dane do walidacji.",
};

export default function ReferencePage() {
  return <VideoAnalysis />;
}
