import 'dart:math' as math;

import 'geometry.dart';
import 'rules.dart';
import 'types.dart';

/// Deterministic recognizer with soft predicate scoring over one repetition window.
class RuleBasedRecognizer {
  final List<ExerciseDefinition> candidates;
  final double minConfidence;
  final double minMargin;
  RuleBasedRecognizer(this.candidates, {this.minConfidence = 0.6, this.minMargin = 0.1});

  List<String> get requiredFeatures => {
        for (final c in candidates)
          for (final p in c.recognition) p.feature
      }.toList();

  RecognitionResult classify(List<BiomechanicalFrame> frames, [String? expected]) {
    if (frames.length < 5) {
      return const RecognitionResult(detectedExercise: null, confidence: 0, alternatives: [], matchesExpected: null);
    }
    final span = Span(frames.first.timestamp, frames.last.timestamp);
    final scored = [for (final d in candidates) (d.id, _score(d, frames, span))]..sort((a, b) => b.$2.compareTo(a.$2));
    final best = scored.isNotEmpty ? scored.first : null;
    final second = scored.length > 1 ? scored[1] : null;
    final decisive = best != null && best.$2 >= minConfidence && (second == null || best.$2 - second.$2 >= minMargin);
    double? expectedScore;
    if (expected != null) {
      expectedScore = 0;
      for (final s in scored) {
        if (s.$1 == expected) expectedScore = s.$2;
      }
    }
    return RecognitionResult(
      detectedExercise: decisive ? best.$1 : null,
      confidence: roundTo(best?.$2 ?? 0, 2),
      alternatives: [
        for (final s in scored.skip(decisive ? 1 : 0).take(decisive ? 3 : 4))
          RecognitionAlternative(s.$1, roundTo(s.$2, 2)),
      ],
      matchesExpected: expected != null ? expectedScore! >= minConfidence : null,
    );
  }
}

double _score(ExerciseDefinition def, List<BiomechanicalFrame> frames, Span span) {
  var total = 0.0, got = 0.0;
  for (final p in def.recognition) {
    total += p.weight;
    final (samples, _) = samplesFor(frames, p.feature, span);
    final good = samples.where((s) => s.c >= 0.4).toList();
    if (good.length < 3) continue;
    final st = computeStat(good, p.stat);
    if (st == null) continue;
    final width = math.max(math.max((p.max ?? 0).abs(), (p.min ?? 0).abs()), 1e-3) * 0.15;
    var miss = 0.0;
    if (p.min != null && st < p.min!) miss = p.min! - st;
    if (p.max != null && st > p.max!) miss = math.max(miss, st - p.max!);
    final credit = miss == 0 ? 1.0 : math.max(0.0, 1 - miss / width);
    got += credit * p.weight;
  }
  return total > 0 ? got / total : 0;
}
