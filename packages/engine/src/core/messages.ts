/**
 * User-facing system messages (Polish). Exercise-specific cues live in the
 * exercise definitions. Kept in one place so a locale can be swapped later.
 */
export const MESSAGES = {
  bodyPart: {
    nose: "głowa",
    leftEye: "głowa",
    rightEye: "głowa",
    leftEar: "głowa",
    rightEar: "głowa",
    leftShoulder: "lewy bark",
    rightShoulder: "prawy bark",
    leftElbow: "lewy łokieć",
    rightElbow: "prawy łokieć",
    leftWrist: "lewy nadgarstek",
    rightWrist: "prawy nadgarstek",
    leftIndex: "lewa dłoń",
    rightIndex: "prawa dłoń",
    leftHip: "lewe biodro",
    rightHip: "prawe biodro",
    leftKnee: "lewe kolano",
    rightKnee: "prawe kolano",
    leftAnkle: "lewa kostka",
    rightAnkle: "prawa kostka",
    leftHeel: "lewa pięta",
    rightHeel: "prawa pięta",
    leftFootIndex: "lewa stopa",
    rightFootIndex: "prawa stopa",
  },
  view: {
    side: "bokiem do kamery",
    front: "przodem do kamery",
    rear: "tyłem do kamery",
    "front-side": "skosem (ok. 45°) do kamery",
    unknown: "w kadrze",
  },
  calibration: {
    noPerson: "Nie widzę sylwetki. Stań w kadrze tak, żeby było widać całe ciało.",
    missing: (parts: string) => `Kamera nie widzi: ${parts}.`,
    headCut: "Głowa wychodzi poza kadr. Odsuń kamerę albo ustaw ją wyżej.",
    feetCut: "Stopy wychodzą poza kadr. Odsuń kamerę albo ustaw ją niżej.",
    sideCut: "Przesuń się bliżej środka kadru.",
    tooClose: "Jesteś za blisko. Odsuń kamerę o krok lub dwa.",
    tooFar: "Jesteś za daleko. Podejdź bliżej kamery.",
    tooDark: "Obraz jest ciemny. Doświetl pomieszczenie, żeby analiza była dokładniejsza.",
    wrongView: (view: string) => `Ustaw się ${view}.`,
    standStill: "Stań prosto i nie ruszaj się przez chwilę.",
    calibrating: "Kalibracja... nie ruszaj się.",
    ready: "Gotowe. Możesz zaczynać.",
    lost: "Straciłem Cię z kadru. Analiza wstrzymana.",
    sceneChange: "Zmieniło się ujęcie albo osoba w kadrze. Kalibruję od nowa.",
    repInterrupted: "Przerwa w obrazie. To powtórzenie nie zostanie ocenione.",
  },
  safety: {
    stopSet: "Zatrzymaj serię i odpocznij. Wykryłem wyraźną utratę kontroli ruchu.",
    disclaimer:
      "Analiza z jednej kamery to wsparcie treningowe, a nie ocena medyczna. Nie gwarantuje, że ruch jest bezpieczny.",
  },
  feedback: {
    incompleteRep: "Powtórzenie niezaliczone: niepełny zakres ruchu.",
    unmeasurable: (what: string) => `Nie można ocenić z tego ustawienia kamery: ${what}.`,
  },
} as const;
