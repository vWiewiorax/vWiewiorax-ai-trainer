import 'dart:math' as math;

import 'geometry.dart';
import 'types.dart';

/* ---------------- series ---------------- */

class Sample {
  final double t, v, c;
  const Sample(this.t, this.v, this.c);
}

class Span {
  final double start, end;
  const Span(this.start, this.end);
}

Span? selectSpan(List<PhaseSpan> phases, String phase, (double, double)? window, Span? rep) {
  double start, end;
  if (phase == 'rep') {
    if (rep == null) return null;
    start = rep.start;
    end = rep.end;
  } else if (phase == 'return') {
    if (phases.length < 2 || phases.last.id != phases.first.id) return null;
    start = phases.last.startTimestamp;
    end = phases.last.endTimestamp;
  } else {
    final spans =
        phases.isNotEmpty && phases.first.id == phase ? [phases.first] : phases.where((p) => p.id == phase).toList();
    if (spans.isEmpty) return null;
    final s = spans.reduce((a, b) => b.endTimestamp - b.startTimestamp > a.endTimestamp - a.startTimestamp ? b : a);
    if (identical(spans.first, phases.first) && s.endTimestamp <= s.startTimestamp) return null;
    start = s.startTimestamp;
    end = s.endTimestamp;
  }
  if (window != null) {
    final d = end - start;
    final s2 = start + d * window.$1;
    end = start + d * window.$2;
    start = s2;
  }
  return end >= start ? Span(start, end) : null;
}

(List<Sample>, int) samplesFor(List<BiomechanicalFrame> frames, String feature, Span span) {
  var total = 0;
  final out = <Sample>[];
  for (final f in frames) {
    if (f.timestamp < span.start - 1 || f.timestamp > span.end + 1) continue;
    total++;
    final m = f.features[feature];
    if (m != null) out.add(Sample(f.timestamp, m.value, m.confidence));
  }
  return (out, total);
}

double? computeStat(List<Sample> s, String stat) {
  if (s.isEmpty) return null;
  switch (stat) {
    case 'min':
      return s.reduce((a, b) => b.v < a.v ? b : a).v;
    case 'max':
      return s.reduce((a, b) => b.v > a.v ? b : a).v;
    case 'mean':
      return s.fold<double>(0, (a, b) => a + b.v) / s.length;
    case 'range':
      var lo = double.infinity, hi = double.negativeInfinity;
      for (final x in s) {
        lo = math.min(lo, x.v);
        hi = math.max(hi, x.v);
      }
      return hi - lo;
    case 'start':
      return _edge(s, true);
    case 'end':
      return _edge(s, false);
    case 'delta':
      return _edge(s, false) - _edge(s, true);
  }
  return null;
}

double _edge(List<Sample> s, bool start) {
  final n = math.min(3, s.length);
  final part = start ? s.sublist(0, n) : s.sublist(s.length - n);
  return part.fold<double>(0, (a, b) => a + b.v) / part.length;
}

/* ---------------- rules ---------------- */

class RuleOverrides {
  final Map<String, double> thresholds;
  final Set<String> disabled;
  final Map<String, double> baselines;
  const RuleOverrides({this.thresholds = const {}, this.disabled = const <String>{}, this.baselines = const {}});
}

class RuleOutcome {
  final String type;
  final ErrorDefinition rule;
  final bool measured;
  final bool skipped;
  final String? reason;
  final double confidence;
  final TechniqueError? error;
  RuleOutcome(this.rule,
      {required this.measured, this.skipped = false, this.reason, required this.confidence, this.error})
      : type = rule.type;
}

class RepContext {
  final ExerciseDefinition exercise;
  final int repIndex;
  final double startTimestamp, endTimestamp;
  final List<PhaseSpan> phases;
  final List<BiomechanicalFrame> frames;
  final CameraView view;
  final double viewConfidence;
  final RuleOverrides overrides;
  final double coverage;
  final Map<String, List<double>> history;
  const RepContext({
    required this.exercise,
    required this.repIndex,
    required this.startTimestamp,
    required this.endTimestamp,
    required this.phases,
    required this.frames,
    required this.view,
    required this.viewConfidence,
    required this.overrides,
    required this.coverage,
    required this.history,
  });
}

const _minCoverage = 0.6;
const _minSamples = 3;

Severity severityFromBands(double deviation, (double, double) bands) {
  if (deviation >= bands.$2) return Severity.high;
  if (deviation >= bands.$1) return Severity.moderate;
  return Severity.low;
}

const _downgrade = {Severity.high: Severity.moderate, Severity.moderate: Severity.low, Severity.low: Severity.low};

double _clamp01(double x) => math.max(0, math.min(1, x));

List<RuleOutcome> evaluateRepetition(RepContext ctx) =>
    [for (final r in ctx.exercise.evaluationRules) evaluateRule(r, ctx)];

String unitOf(String feature) {
  final angular = RegExp(r'Angle|Inclination|Tilt|Lean|neckAlignment|bodyLine', caseSensitive: false).hasMatch(feature);
  final vel = feature.endsWith('.velocity');
  if (angular) return vel ? 'deg/s' : 'deg';
  return vel ? 'body/s' : 'body';
}

RuleOutcome evaluateRule(ErrorDefinition rule, RepContext ctx) {
  if (ctx.overrides.disabled.contains(rule.type) && !rule.safetyCritical) {
    return RuleOutcome(rule, measured: false, skipped: true, reason: 'wyłączone przez trenera', confidence: 0);
  }
  if (!rule.views.contains(ctx.view)) {
    return RuleOutcome(rule,
        measured: false, reason: 'wymaga widoku: ${rule.views.map((v) => v.id).join('/')}', confidence: 0);
  }
  final cond = rule.condition;
  final span = selectSpan(ctx.phases, cond.phase, cond.window, Span(ctx.startTimestamp, ctx.endTimestamp));
  if (span == null) return RuleOutcome(rule, measured: false, reason: 'brak fazy ${cond.phase}', confidence: 0);
  double threshold(double t) => ctx.overrides.thresholds[rule.type] ?? t;
  final viewFactor = 0.6 + 0.4 * ctx.viewConfidence;

  RuleOutcome finish(double value, double thr, double dev, (double, double) bands, double dataConf, double start,
      double end, String unit) {
    final confidence = _clamp01(dataConf * rule.reliability * viewFactor * math.min(1, ctx.coverage / 0.9));
    if (confidence < rule.minConfidence) {
      return RuleOutcome(rule, measured: false, reason: 'za niska pewność pomiaru', confidence: confidence);
    }
    if (dev <= 0) return RuleOutcome(rule, measured: true, confidence: confidence);
    var severity = severityFromBands(dev, bands);
    if (confidence < 0.6) severity = _downgrade[severity]!;
    return RuleOutcome(rule,
        measured: true,
        confidence: confidence,
        error: TechniqueError(
          id: '${ctx.exercise.id}-${ctx.repIndex}-${rule.type}',
          type: rule.type,
          exercise: ctx.exercise.id,
          phase: cond.phase,
          severity: severity,
          confidence: roundTo(confidence, 2),
          startTimestamp: jsRound(start).toDouble(),
          endTimestamp: jsRound(end).toDouble(),
          description: rule.description,
          correctiveFeedback: rule.correction,
          voiceCue: rule.voice,
          recommendedAction: rule.recommendedAction,
          category: rule.category,
          measured: MeasuredValue(roundTo(value, 3), thr, unit),
          repIndex: ctx.repIndex,
        ));
  }

  RuleOutcome insufficient([String reason = 'za mało wiarygodnych klatek']) =>
      RuleOutcome(rule, measured: false, reason: reason, confidence: 0);

  List<Sample>? getSamples(String feature) {
    final (samples, total) = samplesFor(ctx.frames, feature, span);
    final good = samples.where((s) => s.c >= rule.minConfidence * 0.8).toList();
    if (good.length < _minSamples || (total > 0 && good.length / total < _minCoverage)) return null;
    return good;
  }

  double meanConf(List<Sample> s) => s.fold<double>(0, (a, b) => a + b.c) / s.length;

  switch (cond.kind) {
    case 'stat':
      final s = getSamples(cond.feature!);
      if (s == null) return insufficient();
      final st = computeStat(s, cond.stat!);
      if (st == null) return insufficient();
      final thr = threshold(cond.threshold);
      final gt = cond.compare == '>';
      final dev = gt ? st - thr : thr - st;
      final violating = s.where((x) => gt ? x.v > thr : x.v < thr).toList();
      final point = cond.stat == 'min' || cond.stat == 'max' || cond.stat == 'mean';
      final start = point && violating.isNotEmpty ? violating.first.t : span.start;
      final end = point && violating.isNotEmpty ? violating.last.t : span.end;
      return finish(st, thr, dev, cond.bands, meanConf(s), start, end, unitOf(cond.feature!));
    case 'duration':
      final d = span.end - span.start;
      final thr = threshold(cond.thresholdMs);
      final dev = cond.compare == '>' ? d - thr : thr - d;
      final (samples, total) = samplesFor(ctx.frames, ctx.exercise.repetition.signal, span);
      final conf =
          total > 0 ? math.min(1.0, samples.length / total) * (samples.isNotEmpty ? meanConf(samples) : 0) : 0.0;
      return finish(d, thr, dev, cond.bands, conf, span.start, span.end, 'ms');
    case 'deltaRatio':
      final num = getSamples(cond.numerator!);
      final den = getSamples(cond.denominator!);
      if (num == null || den == null) return insufficient();
      final dn = computeStat(num, 'delta')!;
      final dd = computeStat(den, 'delta')!;
      if (dn.abs() < (cond.minNumerator ?? 0)) {
        return RuleOutcome(rule,
            measured: true, confidence: _clamp01(math.min(meanConf(num), meanConf(den)) * rule.reliability));
      }
      final sign = dd == 0 ? 1.0 : dd.sign;
      final denom = sign * math.max(dd.abs(), cond.minDenominator);
      final ratio = clampD(dn / denom, -10, 10);
      final thr = threshold(cond.threshold);
      final dev = cond.compare == '>' ? ratio - thr : thr - ratio;
      return finish(ratio, thr, dev, cond.bands, math.min(meanConf(num), meanConf(den)), span.start, span.end, 'ratio');
    case 'asymmetry':
      final (ls, _) = samplesFor(ctx.frames, cond.left!, span);
      final (rs, _) = samplesFor(ctx.frames, cond.right!, span);
      final rMap = {for (final r in rs) r.t: r};
      final diffs = <Sample>[];
      for (final l in ls) {
        final r = rMap[l.t];
        if (r != null && l.c >= rule.minConfidence && r.c >= rule.minConfidence) {
          diffs.add(Sample(l.t, (l.v - r.v).abs(), math.min(l.c, r.c)));
        }
      }
      final total = ctx.frames.where((f) => f.timestamp >= span.start && f.timestamp <= span.end).length;
      if (diffs.length < _minSamples || (total > 0 && diffs.length / total < _minCoverage)) return insufficient();
      final sorted = diffs.map((d) => d.v).toList()..sort();
      final value = cond.stat == 'maxAbsDiff'
          ? sorted[((sorted.length - 1) * 0.9).floor()]
          : sorted.reduce((a, b) => a + b) / sorted.length;
      final thr = threshold(cond.threshold);
      final violating = diffs.where((d) => d.v > thr).toList();
      return finish(
          value,
          thr,
          value - thr,
          cond.bands,
          meanConf(diffs),
          violating.isNotEmpty ? violating.first.t : span.start,
          violating.isNotEmpty ? violating.last.t : span.end,
          unitOf(cond.left!));
    case 'tempoConsistency':
      final prev = ctx.history[cond.phase] ?? const <double>[];
      if (prev.length < cond.minPreviousReps) {
        return RuleOutcome(rule,
            measured: false, skipped: true, reason: 'za mało powtórzeń do porównania tempa', confidence: 0);
      }
      final sorted = [...prev]..sort();
      final med = sorted[sorted.length ~/ 2];
      final d = span.end - span.start;
      final rel = med > 0 ? (d - med).abs() / med : 0.0;
      final tol = threshold(cond.tolerance);
      final (samples, total) = samplesFor(ctx.frames, ctx.exercise.repetition.signal, span);
      final conf = total > 0 && samples.isNotEmpty ? samples.length / total * meanConf(samples) : 0.0;
      return finish(rel, tol, rel - tol, cond.bands, conf, span.start, span.end, 'ratio');
    case 'baseline':
      final ref = ctx.overrides.baselines[rule.type];
      if (ref == null)
        return RuleOutcome(rule, measured: false, skipped: true, reason: 'brak indywidualnego wzorca', confidence: 0);
      final s = getSamples(cond.feature!);
      if (s == null) return insufficient();
      final st = computeStat(s, cond.stat!)!;
      final tol = threshold(cond.tolerance);
      return finish(
          st, ref, (st - ref).abs() - tol, cond.bands, meanConf(s), span.start, span.end, unitOf(cond.feature!));
  }
  return insufficient('nieznany typ reguły');
}

/* ---------------- scoring ---------------- */

const defaultPenalties = {Severity.low: 12.0, Severity.moderate: 30.0, Severity.high: 55.0};

/// Confidence-aware technique score; unmeasured categories are excluded and lower confidence instead.
ScoreBreakdown scoreRepetition(ExerciseDefinition def, List<RuleOutcome> outcomes,
    {Map<Severity, double> penalties = defaultPenalties, double extraConfidence = 1}) {
  final weights = def.scoringConfiguration;
  final totalWeight = weights.values.fold<double>(0, (a, b) => a + b);
  final cats = <CategoryScore>[];
  var weighted = 0.0, measuredWeight = 0.0, confWeighted = 0.0;
  final measuredCats = <(String, double, int)>[];
  for (final e in weights.entries) {
    final cat = e.key, w = e.value;
    if (w == 0) continue;
    final rules = outcomes.where((o) => o.rule.category == cat && !o.skipped).toList();
    final measured = rules.where((o) => o.measured).toList();
    if (measured.isEmpty) {
      cats.add(CategoryScore(
          category: cat,
          weight: 0,
          score: 0,
          measured: false,
          reason: rules.isNotEmpty
              ? rules.map((r) => r.reason).whereType<String>().join('; ')
              : 'brak reguł dla tej kategorii'));
      continue;
    }
    var penalty = 0.0;
    for (final o in measured) {
      final err = o.error;
      if (err == null) continue;
      final p = penalties[err.severity]! * (0.5 + 0.5 * o.rule.importance);
      penalty += p * math.max(0.5, math.min(1.0, o.confidence / 0.75));
    }
    final score = math.max(0.0, 100 - penalty);
    final coverage = measured.length / rules.length;
    final conf = measured.fold<double>(0, (a, b) => a + b.confidence) / measured.length * (0.5 + 0.5 * coverage);
    measuredCats.add((cat, w, jsRound(score)));
    cats.add(CategoryScore(category: cat, weight: w, score: jsRound(score).toDouble(), measured: true));
    weighted += score * w;
    measuredWeight += w;
    confWeighted += conf * w;
  }
  final normalized = [
    for (final c in cats)
      c.measured && measuredWeight > 0
          ? CategoryScore(
              category: c.category, weight: roundTo(c.weight / measuredWeight, 3), score: c.score, measured: true)
          : c,
  ];
  final unmeasured = [
    for (final o in outcomes)
      if (!o.measured && !o.skipped) Unmeasured(o.rule.label, o.reason ?? 'niemierzalne'),
  ];
  if (measuredWeight == 0 || totalWeight == 0) {
    return ScoreBreakdown(
        score: null, scoreUncertainty: null, analysisConfidence: 0, categories: normalized, unmeasured: unmeasured);
  }
  final ac = roundTo(_clamp01(confWeighted / totalWeight * extraConfidence), 2);
  return ScoreBreakdown(
    score: jsRound(weighted / measuredWeight),
    scoreUncertainty: jsRound(4 + (1 - ac) * 26),
    analysisConfidence: ac,
    categories: normalized,
    unmeasured: unmeasured,
  );
}
