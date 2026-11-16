/// User-facing system messages (Polish).
const bodyPartPl = <String, String>{
  'nose': 'głowa',
  'leftEye': 'głowa',
  'rightEye': 'głowa',
  'leftEar': 'głowa',
  'rightEar': 'głowa',
  'leftShoulder': 'lewy bark',
  'rightShoulder': 'prawy bark',
  'leftElbow': 'lewy łokieć',
  'rightElbow': 'prawy łokieć',
  'leftWrist': 'lewy nadgarstek',
  'rightWrist': 'prawy nadgarstek',
  'leftIndex': 'lewa dłoń',
  'rightIndex': 'prawa dłoń',
  'leftHip': 'lewe biodro',
  'rightHip': 'prawe biodro',
  'leftKnee': 'lewe kolano',
  'rightKnee': 'prawe kolano',
  'leftAnkle': 'lewa kostka',
  'rightAnkle': 'prawa kostka',
  'leftHeel': 'lewa pięta',
  'rightHeel': 'prawa pięta',
  'leftFootIndex': 'lewa stopa',
  'rightFootIndex': 'prawa stopa',
};

const viewPl = <String, String>{
  'side': 'bokiem do kamery',
  'front': 'przodem do kamery',
  'rear': 'tyłem do kamery',
  'front-side': 'skosem (ok. 45°) do kamery',
  'unknown': 'w kadrze',
};

abstract final class Msg {
  static const noPerson = 'Nie widzę sylwetki. Stań w kadrze tak, żeby było widać całe ciało.';
  static String missing(String parts) => 'Kamera nie widzi: $parts.';
  static const headCut = 'Głowa wychodzi poza kadr. Odsuń kamerę albo ustaw ją wyżej.';
  static const feetCut = 'Stopy wychodzą poza kadr. Odsuń kamerę albo ustaw ją niżej.';
  static const sideCut = 'Przesuń się bliżej środka kadru.';
  static const tooClose = 'Jesteś za blisko. Odsuń kamerę o krok lub dwa.';
  static const tooFar = 'Jesteś za daleko. Podejdź bliżej kamery.';
  static const tooDark = 'Obraz jest ciemny. Doświetl pomieszczenie, żeby analiza była dokładniejsza.';
  static String wrongView(String view) => 'Ustaw się $view.';
  static const standStill = 'Stań prosto i nie ruszaj się przez chwilę.';
  static const calibrating = 'Kalibracja... nie ruszaj się.';
  static const ready = 'Gotowe. Możesz zaczynać.';
  static const lost = 'Straciłem Cię z kadru. Analiza wstrzymana.';
  static const sceneChange = 'Zmieniło się ujęcie albo osoba w kadrze. Kalibruję od nowa.';
  static const repInterrupted = 'Przerwa w obrazie. To powtórzenie nie zostanie ocenione.';
  static const stopSet = 'Zatrzymaj serię i odpocznij. Wykryłem wyraźną utratę kontroli ruchu.';
  static const disclaimer =
      'Analiza z jednej kamery to wsparcie treningowe, a nie ocena medyczna. Nie gwarantuje, że ruch jest bezpieczny.';
  static const incompleteRep = 'Powtórzenie niezaliczone: niepełny zakres ruchu.';
  static String unmeasurable(String what) => 'Nie można ocenić z tego ustawienia kamery: $what.';
}
