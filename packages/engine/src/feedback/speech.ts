/**
 * Text-to-speech output, separate from the analysis engine. Uses the Web Speech
 * API in browsers; React Native apps can implement `SpeechOutput` with expo-speech.
 */
export interface SpeechOutput {
  speak(text: string, opts?: { interrupt?: boolean }): void;
  cancel(): void;
  enabled: boolean;
}

export class BrowserSpeech implements SpeechOutput {
  enabled = true;
  private voice: SpeechSynthesisVoice | null = null;

  constructor(private readonly lang = "pl-PL", private readonly rate = 1.1) {
    if (typeof speechSynthesis === "undefined") {
      this.enabled = false;
      return;
    }
    const pick = () => {
      const voices = speechSynthesis.getVoices();
      this.voice = voices.find((v) => v.lang === lang) ?? voices.find((v) => v.lang.startsWith(lang.slice(0, 2))) ?? null;
    };
    pick();
    speechSynthesis.addEventListener?.("voiceschanged", pick);
  }

  speak(text: string, opts: { interrupt?: boolean } = {}): void {
    if (!this.enabled || typeof speechSynthesis === "undefined") return;
    if (opts.interrupt) speechSynthesis.cancel();
    else if (speechSynthesis.speaking) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.lang;
    u.rate = this.rate;
    if (this.voice) u.voice = this.voice;
    speechSynthesis.speak(u);
  }

  cancel(): void {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }
}
