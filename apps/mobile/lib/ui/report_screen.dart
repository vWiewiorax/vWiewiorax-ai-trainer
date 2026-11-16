import 'package:material_ui/material_ui.dart';
import 'package:trainer_engine/trainer_engine.dart';

import 'colors.dart';

/// Post-set report: per-repetition score and what to fix, aggregated errors, recommendations.
class ReportScreen extends StatelessWidget {
  final ExerciseDefinition exercise;
  final TechniqueAnalysis report;
  const ReportScreen({super.key, required this.exercise, required this.report});

  @override
  Widget build(BuildContext context) {
    final r = report;
    return Scaffold(
      appBar: AppBar(title: Text('Raport: ${exercise.name}')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Wrap(spacing: 12, runSpacing: 12, children: [
          _stat('Powtórzenia', '${r.repetitionCount}'),
          if (r.partialRepetitions > 0) _stat('Niezaliczone', '${r.partialRepetitions}'),
          _stat('Ocena techniki', r.averageTechniqueScore?.toString() ?? '-', color: scoreColor(r.averageTechniqueScore)),
          _stat('Pewność analizy', '${(r.analysisConfidence * 100).round()}%'),
          if (r.consistency != null) _stat('Powtarzalność', '${r.consistency}'),
        ]),
        if (r.averageTechniqueScore == null && r.repetitionCount > 0)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text('Brak oceny: za niska pewność pomiaru (zasłonięte punkty ciała albo złe ustawienie kamery).'),
          ),
        const SizedBox(height: 16),
        const Text('Powtórzenia', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        for (final rep in r.repetitions) _repCard(rep),
        if (r.recommendations.isNotEmpty) ...[
          const SizedBox(height: 16),
          const Text('Co poprawić', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
          for (final t in r.recommendations) ListTile(leading: const Icon(Icons.arrow_right), title: Text(t)),
        ],
        const SizedBox(height: 16),
        for (final n in r.safetyNotes) Text(n, style: const TextStyle(color: Colors.white60, fontSize: 12)),
      ]),
    );
  }

  Widget _stat(String label, String value, {Color? color}) => Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: color ?? Colors.white10, borderRadius: BorderRadius.circular(12)),
        child: Column(children: [
          Text(value, style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w900)),
          Text(label),
        ]),
      );

  Widget _repCard(ExerciseRepetition rep) {
    final issues = rankedIssues(rep);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            CircleAvatar(backgroundColor: scoreColor(rep.incomplete ? 0 : rep.techniqueScore), child: Text('${rep.index}')),
            const SizedBox(width: 12),
            Text(
              rep.incomplete ? 'Niezaliczone' : 'Ocena: ${rep.techniqueScore ?? '-'}',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            const Spacer(),
            Text('${(rep.durationMs / 1000).toStringAsFixed(1)} s'),
          ]),
          if (issues.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(rep.techniqueScore == null && !rep.incomplete
                  ? 'Brak oceny: za mała pewność pomiaru (zasłonięte stawy albo zły kąt kamery).'
                  : 'Bez uwag.'),
            ),
          for (final e in issues)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Icon(Icons.circle, size: 12, color: severityColor(e.severity)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text.rich(TextSpan(children: [
                    TextSpan(text: '${issueLabel(exercise, e)}: ', style: const TextStyle(fontWeight: FontWeight.bold)),
                    TextSpan(text: e.correctiveFeedback),
                  ])),
                ),
              ]),
            ),
        ]),
      ),
    );
  }
}
