import 'package:material_ui/material_ui.dart';
import 'package:trainer_engine/trainer_engine.dart';

Color scoreColor(int? score) {
  if (score == null) return Colors.blueGrey;
  if (score >= 85) return const Color(0xFF16A34A);
  if (score >= 65) return const Color(0xFFF59E0B);
  return const Color(0xFFDC2626);
}

Color severityColor(Severity? s) => switch (s) {
      Severity.high => const Color(0xFFDC2626),
      Severity.moderate => const Color(0xFFF59E0B),
      Severity.low => const Color(0xFFEAB308),
      null => const Color(0xFF2563EB),
    };

/// Most important issues of a repetition first (severity x confidence).
List<TechniqueError> rankedIssues(ExerciseRepetition r) {
  const rank = {Severity.low: 1, Severity.moderate: 2, Severity.high: 3};
  return [...r.detectedErrors]..sort((a, b) => (rank[b.severity]! * b.confidence).compareTo(rank[a.severity]! * a.confidence));
}

String issueLabel(ExerciseDefinition def, TechniqueError e) =>
    def.rule(e.type)?.label ?? (e.type == 'INCOMPLETE_RANGE_OF_MOTION' ? 'Niepełny zakres ruchu' : e.type);
