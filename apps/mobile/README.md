# AI Trainer - aplikacja mobilna (Flutter, Android i iOS)

Analiza techniki na żywo z kamery telefonu. Pozę wykrywa Google ML Kit bezpośrednio na telefonie
(bez internetu, obraz nie opuszcza urządzenia). Analizę robi silnik `packages/trainer_engine`
(Dart), który daje te same wyniki co wersja przeglądarkowa (`packages/engine`).

Analiza z jednej kamery to wsparcie treningowe, nie ocena medyczna. Pochylenie pleców i tor sztangi
są mierzone pośrednio z obrazu 2D.

## Co jest w aplikacji
- wybór ćwiczenia: martwy ciąg klasyczny, martwy ciąg rumuński, przysiad ze sztangą,
- wybór kamery (przednia / tylna), rozdzielczości i modelu pozy,
- obraz z kamery ze szkieletem, duży licznik powtórzeń, faza ruchu i ocena serii,
- duże podpowiedzi w trakcie ruchu (czytelne z kilku metrów) i polski głos z syntezatora telefonu,
- pasek powtórzeń: numer, ocena i główny błąd każdego powtórzenia,
- raport po serii: każde powtórzenie z listą błędów i tym, jak je poprawić.

## Instalacja na Windows (jednorazowo)
1. Flutter: https://docs.flutter.dev/get-started/install/windows/mobile (rozpakuj np. do `C:\src\flutter` i dodaj `C:\src\flutter\bin` do PATH).
2. Android Studio (instaluje Android SDK). Po instalacji w PowerShell:
   ```
   flutter doctor --android-licenses
   flutter doctor
   ```
3. VS Code + rozszerzenie **Flutter** (VS Code samo je zaproponuje po otwarciu repo).
4. Telefon z Androidem: Ustawienia -> Informacje o telefonie -> 7 x "Numer kompilacji" (tryb dewelopera),
   potem Opcje programistyczne -> **Debugowanie USB**. Podłącz kablem i zezwól na debugowanie.

## Uruchomienie z VS Code
```
git pull
cd apps/mobile
flutter pub get
```
Otwórz folder repo w VS Code, na dole po prawej wybierz telefon jako urządzenie, potem
**Run and Debug** -> "AI Trainer (telefon, debug)" -> F5. Pierwsza kompilacja trwa kilka minut.
Do sprawdzenia płynności użyj "AI Trainer (telefon, profile - realna szybkość)" (debug jest wolniejszy).

Bez VS Code: `flutter run` w `apps/mobile`.

## Testy
- VS Code: zakładka **Testing** (ikona kolby) pokazuje testy z `packages/trainer_engine/test` i `apps/mobile/test`.
- Konsola:
  ```
  cd packages/trainer_engine; dart test
  cd ../../apps/mobile; flutter test
  ```
- `packages/trainer_engine/test/parity_test.dart` odtwarza zapisane klatki i sprawdza, że silnik Dart daje
  te same powtórzenia, błędy i komunikaty co silnik TypeScript. Po zmianie definicji ćwiczeń w TS:
  ```
  cd packages/engine
  npx tsx scripts/gen-dart.ts
  npx tsx scripts/export-parity.ts
  ```

## Jak ustawić telefon
- Martwy ciąg i przysiad: telefon z boku, na wysokości bioder, 2,5-4 m od Ciebie, cała sylwetka w kadrze.
- Przednia kamera: widzisz ekran i podpowiedzi. Tylna kamera: lepszy obraz, ale słuchaj głosu.
- Stań prosto na 1-2 s, aż pojawi się "Gotowe. Możesz zaczynać."

## iPhone
Wymaga Maca z Xcode (albo usługi w chmurze, np. Codemagic) i konta Apple. Na Macu:
```
cd apps/mobile
flutter pub get
cd ios; pod install; cd ..
flutter run
```
Minimalna wersja iOS: 15.5 (wymóg ML Kit). Wersji iOS nie testowałem.
