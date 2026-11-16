import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:trainer_engine/trainer_engine.dart';

/// Replays pose frames exported from the TypeScript engine (packages/engine/scripts/export-parity.ts)
/// and checks that the Dart port produces the same repetitions, errors and cues.
/// Synthetic data validates software logic only, not real-world accuracy.
void main() {
  final dir = Directory('test/fixtures');
  final files = dir.listSync().whereType<File>().where((f) => f.path.endsWith('.json')).toList()
    ..sort((a, b) => a.path.compareTo(b.path));

  for (final file in files) {
    final fx = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    test('parity: ${fx['name']}', () {
      final raw = fx['frames'] as List<dynamic>? ??
          (jsonDecode(File(fx['file'] as String).readAsStringSync()) as Map<String, dynamic>)['frames'] as List<dynamic>;
      final frames = [for (final f in raw) PoseFrame.fromJson(f as Map<String, dynamic>)];
      final a = ExerciseAnalyzer(exercises[fx['exerciseId']]!, candidates: exercises.values.toList());
      final cues = <Map<String, dynamic>>[];
      for (final f in frames) {
        final s = a.processFrame(f);
        final fb = s.feedback;
        if (fb != null) cues.add({'t': s.timestamp, 'kind': fb.kind.name, 'key': fb.key, 'voice': fb.voice});
      }
      final report = a.endSet();
      final exp = fx['expected'] as Map<String, dynamic>;
      final reps = [
        for (final r in report.repetitions)
          {
            'index': r.index,
            'startTimestamp': r.startTimestamp,
            'endTimestamp': r.endTimestamp,
            'score': r.techniqueScore,
            'confidence': r.analysisConfidence,
            'incomplete': r.incomplete,
            'errors': [for (final e in r.detectedErrors) '${e.type}:${e.severity.name.toUpperCase()}']..sort(),
          },
      ];
      expect(reps, _num(exp['repetitions']), reason: 'repetitions');
      expect(report.repetitionCount, exp['repetitionCount']);
      expect(report.partialRepetitions, exp['partialRepetitions']);
      expect(report.averageTechniqueScore, exp['averageTechniqueScore']);
      expect(report.analysisConfidence, closeTo((exp['analysisConfidence'] as num).toDouble(), 0.011));
      expect(report.recognition.detectedExercise, exp['detectedExercise']);
      expect(cues, _num(exp['cues']), reason: 'cues');
    });
  }
}

/// JSON ints -> doubles where the Dart side uses doubles, so deep equality works.
dynamic _num(dynamic v) {
  if (v is List) return [for (final x in v) _num(x)];
  if (v is Map) {
    return {
      for (final e in v.entries)
        e.key: switch (e.key) {
          'startTimestamp' || 'endTimestamp' || 't' || 'confidence' => (e.value as num).toDouble(),
          _ => _num(e.value),
        },
    };
  }
  return v;
}
