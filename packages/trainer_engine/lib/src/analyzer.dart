import 'dart:math' as math;

import 'body.dart';
import 'camera.dart';
import 'detector.dart';
import 'features.dart';
import 'feedback.dart';
import 'filtering.dart';
import 'geometry.dart';
import 'landmarks.dart';
import 'messages.dart';
import 'recognition.dart';
import 'rules.dart';
import 'types.dart';

const engineVersion = '0.1.0';
const seriesPoints = 60;

enum AnalyzerStatus { noPerson, calibrating, analysing, paused }

class KeyMetric {
  final String name, label, unit;
  final double value, confidence;
  const KeyMetric(this.name, this.label, this.value, this.unit, this.confidence);
}

class LiveState {
  final double timestamp;
  final AnalyzerStatus status;
  final CalibrationState calibration;
  final CameraView view;
  final double viewConfidence;
  final Side nearSide;
  /// Filtered, aspect-corrected landmarks (x in [0, aspect], y in [0, 1]).
  final Pose pose;
  final double aspect;
  final String? phase;
  final String? phaseLabel;
  final bool inRepetition;
  final int repCount;
  final int partialReps;
  final ExerciseRepetition? newRepetition;
  final ExerciseRepetition? lastRepetition;
  final int? setScore;
  final double setConfidence;
  final List<KeyMetric> keyMetrics;
  final FeedbackItem? feedback;
  final List<FeedbackItem> visualCues;
  final List<TechniqueError> currentErrors;
  final bool stopSetRecommended;
  final double engineMs;
  const LiveState({
    required this.timestamp,
    required this.status,
    required this.calibration,
    required this.view,
    required this.viewConfidence,
    required this.nearSide,
    required this.pose,
    required this.aspect,
    required this.phase,
    required this.phaseLabel,
    required this.inRepetition,
    required this.repCount,
    required this.partialReps,
    required this.newRepetition,
    required this.lastRepetition,
    required this.setScore,
    required this.setConfidence,
    required this.keyMetrics,
    required this.feedback,
    required this.visualCues,
    required this.currentErrors,
    required this.stopSetRecommended,
    required this.engineMs,
  });
}

const _severityRank = {Severity.low: 1, Severity.moderate: 2, Severity.high: 3};

const featureLabels = <String, String>{
  'hipAngle': 'Kąt biodra',
  'kneeAngle': 'Kąt kolana',
  'elbowAngle': 'Kąt łokcia',
  'shoulderAngle': 'Kąt barku',
  'trunkInclination': 'Pochylenie tułowia',
  'trunkLeanSigned': 'Pochylenie tułowia',
  'hipHeight': 'Wysokość bioder',
  'shoulderHeight': 'Wysokość barków',
  'shoulderHeightRel': 'Wysokość barków',
  'wristHeight': 'Wysokość dłoni',
  'minElbowAngle': 'Kąt łokcia',
  'minKneeAngle': 'Kąt kolana',
  'hipBelowKnee': 'Głębokość',
  'wristAboveShoulder': 'Dłonie nad barkami',
  'bodyLineAngle': 'Linia ciała',
  'chinAboveHands': 'Broda nad drążkiem',
};

/// Orchestrates one exercise set: pose frame -> normalization -> filtering -> view/calibration ->
/// features -> repetition state machine -> live checks / rule evaluation -> scoring -> feedback.
class ExerciseAnalyzer {
  final ExerciseDefinition exercise;
  late final LandmarkFilter _filter;
  final _view = ViewTracker();
  late final CalibrationMonitor _calibration;
  late final FeatureExtractor _extractor;
  late final RepetitionDetector _detector;
  final _continuity = ContinuityMonitor();
  late final FeedbackEngine _feedback;
  late final RuleBasedRecognizer _recognizer;
  final RuleOverrides overrides;
  final double bufferMs;
  final double minScoreConfidence;
  final double Function() _clock;

  final _frames = <BiomechanicalFrame>[];
  final _repFrames = <List<BiomechanicalFrame>>[];
  final _repetitions = <ExerciseRepetition>[];
  final _provisional = <String, TechniqueError>{};
  final _offered = <String>{};
  final _liveSince = <String, double>{};
  String? _lastPhase;
  String? _lastGuidance;
  bool _wasReady = false;
  final _history = <String, List<double>>{};
  final _safetyHits = <String, int>{};
  bool _stopSet = false;

  int _framesReceived = 0, _framesAnalysed = 0;
  final _engineTimes = <double>[], _inferenceTimes = <double>[], _brightness = <double>[];
  double? _firstTs;
  double _lastTs = 0;
  double _visibilitySum = 0;
  int _visibilityN = 0;
  final _viewVotes = <CameraView, int>{};
  final _issues = <String, int>{};
  LiveState? _lastState;

  ExerciseAnalyzer(
    this.exercise, {
    List<ExerciseDefinition>? candidates,
    BodyBaseline? storedBaseline,
    this.overrides = const RuleOverrides(),
    CalibrationOptions calibration = const CalibrationOptions(),
    FeedbackOptions feedback = const FeedbackOptions(),
    this.bufferMs = 30000,
    this.minScoreConfidence = 0.3,
    double Function()? clock,
  }) : _clock = clock ?? _defaultClock {
    final def = exercise;
    _filter = LandmarkFilter(LandmarkFilterOptions(
      perLandmarkMinVisibility: {for (final n in def.occludableLandmarks) n: calibration.occludedMinVisibility},
    ));
    _calibration = CalibrationMonitor(def, calibration);
    if (storedBaseline != null) _calibration.restore(storedBaseline);
    _recognizer = RuleBasedRecognizer(candidates == null || candidates.isEmpty ? [def] : candidates);
    _extractor = FeatureExtractor({...featuresOf(def), ..._recognizer.requiredFeatures}.toList());
    _detector = RepetitionDetector(def.repetition, def.movementPhases);
    _feedback = FeedbackEngine(feedback);
  }

  static final _sw = Stopwatch()..start();
  static double _defaultClock() => _sw.elapsedMicroseconds / 1000;

  LiveState? get state => _lastState;
  List<ExerciseRepetition> get repetitions => List.unmodifiable(_repetitions);

  /// Processes one pose-estimation result. Pass a frame with empty landmarks when no person was detected.
  LiveState processFrame(PoseFrame frame) {
    final t0 = _clock();
    final ts = frame.timestamp;
    _framesReceived++;
    _firstTs ??= ts;
    _lastTs = ts;
    if (frame.inferenceMs != null) _pushCapped(_inferenceTimes, frame.inferenceMs!);
    final br = frame.cameraMetadata.brightness;
    if (br != null) _pushCapped(_brightness, br);

    final (points, aspect) = normalizeLandmarks(frame);
    final moved = _continuity.update(points, ts);
    final cut = frame.cameraMetadata.sceneCut ? Discontinuity.jump : moved;
    if (cut != Discontinuity.none) _handleDiscontinuity(cut, ts);
    final box = bodyBox(points, 0.5);
    final filtered = _filter.apply(points, ts, box?.height ?? 0.6);
    final nframe = NormalizedFrame(
      timestamp: ts,
      points: filtered,
      aspect: aspect,
      modelConfidence: frame.modelConfidence,
      cameraMetadata: frame.cameraMetadata,
      inferenceMs: frame.inferenceMs,
    );
    final (view, nearSide) = _view.update(filtered, ts);
    final cal = _calibration.update(nframe, view, nearSide);

    final required = requiredFor(exercise, view.view, nearSide);
    _visibilitySum += mean([for (final n in required) filtered[n]?.confidence ?? 0]);
    _visibilityN++;

    AnalyzerStatus status;
    ExerciseRepetition? newRep;
    var phase = _lastPhase;
    var inRep = false;

    if (!cal.analysisAllowed) {
      status = filtered.isEmpty
          ? AnalyzerStatus.noPerson
          : _wasReady
              ? AnalyzerStatus.paused
              : AnalyzerStatus.calibrating;
      inRep = _detector.update(ts, null).inRep;
      final top = cal.guidance.isNotEmpty ? cal.guidance.first : null;
      if (top != null && top != _lastGuidance) {
        _feedback.offerSystem(FeedbackKind.setup, top, ts, voice: top, key: 'setup:$top');
        _issues[top] = (_issues[top] ?? 0) + 1;
      }
      _lastGuidance = top;
    } else {
      status = AnalyzerStatus.analysing;
      _framesAnalysed++;
      _viewVotes[view.view] = (_viewVotes[view.view] ?? 0) + 1;
      if (!_wasReady) {
        _wasReady = true;
        _feedback.offerSystem(FeedbackKind.info, Msg.ready, ts, voice: 'Gotowe', priority: 5, key: 'ready');
      }
      _lastGuidance = null;
      final bf = _extractor.extract(nframe, view.view, nearSide, cal.baseline);
      _frames.add(bf);
      final cutoff = ts - bufferMs;
      while (_frames.isNotEmpty && _frames.first.timestamp < cutoff) {
        _frames.removeAt(0);
      }
      final update = _detector.update(ts, bf.features[exercise.repetition.signal]);
      phase = update.phase;
      inRep = update.inRep;
      _checkLive(bf, phase, ts, view.view, view.confidence);
      if (phase != _lastPhase && _lastPhase != null && update.inRep) {
        _evaluateEndedPhase(_lastPhase!, ts, view.view, view.confidence);
      }
      if (update.countedNow) {
        _feedback.offerSystem(FeedbackKind.rep, '${update.repCount}', ts,
            voice: '${update.repCount}', key: 'rep:${update.repCount}');
      }
      if (update.finished != null) newRep = _finishRepetition(update.finished!, view.view, view.confidence);
    }
    _lastPhase = phase;

    final fb = _feedback.tick(ts);
    final engineMs = _clock() - t0;
    _pushCapped(_engineTimes, engineMs);
    final scored = _repetitions.where((r) => r.techniqueScore != null).toList();
    final complete = _completeCount();
    final analysing = status == AnalyzerStatus.analysing;
    final state = LiveState(
      timestamp: ts,
      status: status,
      calibration: cal,
      view: view.view,
      viewConfidence: view.confidence,
      nearSide: nearSide,
      pose: filtered,
      aspect: aspect,
      phase: analysing ? phase : null,
      phaseLabel: analysing && phase != null ? _detector.phaseLabel(phase) : null,
      inRepetition: inRep,
      repCount: complete + (inRep && _detector.repCount > complete ? 1 : 0),
      partialReps: _repetitions.where((r) => r.incomplete).length,
      newRepetition: newRep,
      lastRepetition: _repetitions.isEmpty ? null : _repetitions.last,
      setScore: scored.isEmpty ? null : jsRound(mean([for (final r in scored) r.techniqueScore!.toDouble()])),
      setConfidence: scored.isEmpty ? 0 : roundTo(mean([for (final r in scored) r.analysisConfidence]), 2),
      keyMetrics: _keyMetrics(),
      feedback: fb.emit,
      visualCues: fb.visual,
      currentErrors: _provisional.values.toList(),
      stopSetRecommended: _stopSet,
      engineMs: engineMs,
    );
    _lastState = state;
    return state;
  }

  /// Ends the set and returns the post-set report.
  TechniqueAnalysis endSet() {
    final open = _detector.flush(_lastTs);
    if (open != null) _finishRepetition(open, _dominantView(), 0.8);
    return _buildReport();
  }

  void _handleDiscontinuity(Discontinuity kind, double ts) {
    final hadCycle = _detector.snapshot(ts) != null;
    _detector.abort();
    _lastPhase = null;
    if (kind == Discontinuity.jump) {
      _filter.reset();
      _view.reset();
      _calibration.start();
      _wasReady = false;
    }
    final msg = kind == Discontinuity.jump
        ? Msg.sceneChange
        : hadCycle
            ? Msg.repInterrupted
            : null;
    if (msg != null) {
      _feedback.offerSystem(FeedbackKind.setup, msg, ts, voice: msg, key: 'cut:${kind.name}', priority: 4);
      _issues[msg] = (_issues[msg] ?? 0) + 1;
    }
  }

  int _completeCount() => _repetitions.where((r) => !r.incomplete).length;

  RepContext _ctxFor(double start, double end, List<PhaseSpan> phases, CameraView view, double viewConfidence,
      double coverage, int repIndex) {
    final from = (phases.isNotEmpty ? phases.first.startTimestamp : start) - 1;
    return RepContext(
      exercise: exercise,
      repIndex: repIndex,
      startTimestamp: start,
      endTimestamp: end,
      phases: phases,
      frames: _frames.where((f) => f.timestamp >= from && f.timestamp <= end + 1).toList(),
      view: view,
      viewConfidence: viewConfidence,
      overrides: overrides,
      coverage: coverage,
      history: _history,
    );
  }

  void _evaluateEndedPhase(String phaseId, double ts, CameraView view, double viewConfidence) {
    final snap = _detector.snapshot(ts);
    if (snap == null) return;
    final rules = exercise.evaluationRules
        .where((r) => r.condition.phase == phaseId && r.condition.kind != 'tempoConsistency')
        .toList();
    if (rules.isEmpty) return;
    final phases = refineOnset(exercise, snap.$2, _frames);
    final ctx = _ctxFor(phases.length > 1 ? phases[1].startTimestamp : snap.$1, ts, phases, view, viewConfidence, 1,
        _repetitions.length + 1);
    for (final rule in rules) {
      final out = evaluateRule(rule, ctx);
      if (out.error != null) {
        _provisional[out.error!.type] = out.error!;
        _offerError(out, ts);
      }
    }
  }

  void _checkLive(BiomechanicalFrame bf, String? phase, double ts, CameraView view, double viewConfidence) {
    final def = exercise;
    for (final chk in def.liveChecks) {
      final rule = def.rule(chk.rule);
      if (rule == null || rule.condition.kind != 'stat' || !rule.views.contains(view)) continue;
      if (overrides.disabled.contains(rule.type) && !rule.safetyCritical) continue;
      final c = rule.condition;
      final f = bf.features[c.feature!];
      final thr = overrides.thresholds[rule.type] ?? c.threshold;
      final confidence = f != null ? f.confidence * rule.reliability * (0.6 + 0.4 * viewConfidence) : 0.0;
      final deviation = f != null ? (c.compare == '>' ? f.value - thr : thr - f.value) : 0.0;
      final bad = f != null &&
          phase != null &&
          chk.phases.contains(phase) &&
          confidence >= rule.minConfidence &&
          deviation > 0;
      if (!bad) {
        _liveSince.remove(rule.type);
        continue;
      }
      final since = _liveSince.putIfAbsent(rule.type, () => ts);
      if (ts - since < chk.persistMs) continue;
      final repIndex = _repetitions.length + 1;
      final id = '${def.id}-$repIndex-${rule.type}';
      if (!_offered.add(id)) continue;
      final err = TechniqueError(
        id: id,
        type: rule.type,
        exercise: def.id,
        phase: phase,
        severity: severityFromBands(deviation, c.bands),
        confidence: roundTo(confidence, 2),
        startTimestamp: jsRound(since).toDouble(),
        endTimestamp: jsRound(ts).toDouble(),
        description: rule.description,
        correctiveFeedback: rule.correction,
        voiceCue: rule.voice,
        recommendedAction: rule.recommendedAction,
        category: rule.category,
        measured: MeasuredValue(roundTo(f.value, 3), thr, features[c.feature!]?.unit ?? ''),
        repIndex: repIndex,
      );
      _provisional[err.type] = err;
      _feedback.offerError(err, rule.importance, ts, immediate: true);
    }
  }

  void _offerError(RuleOutcome out, double ts) {
    final err = out.error;
    if (err == null || !_offered.add(err.id)) return;
    _feedback.offerError(err, out.rule.importance, ts);
  }

  ExerciseRepetition _finishRepetition(RepCycle raw, CameraView view, double viewConfidence) {
    final def = exercise;
    final phases = refineOnset(def, raw.phases, _frames);
    final start = phases.length > 1 ? phases[1].startTimestamp : raw.startTimestamp;
    final end = raw.endTimestamp;
    final duration = end - start;
    final index = _repetitions.length + 1;
    final setupStart = phases.isNotEmpty ? phases.first.startTimestamp : start;
    final frames = _frames.where((f) => f.timestamp >= setupStart - 1 && f.timestamp <= end + 1).toList();
    final moving = frames.where((f) => f.timestamp >= start).toList();
    final signal = def.repetition.signal;
    final signalCoverage =
        moving.isEmpty ? 0.0 : moving.where((f) => f.features.containsKey(signal)).length / moving.length;
    final coverage = math.max(0.0, math.min(signalCoverage, 1 - raw.gapMs / math.max(1, duration)));
    final ctx = _ctxFor(start, end, phases, view, viewConfidence, coverage, index);
    final outcomes = evaluateRepetition(ctx);
    var errors = [for (final o in outcomes) if (o.error != null) o.error!];

    if (!raw.complete) {
      errors.add(TechniqueError(
        id: '${def.id}-$index-INCOMPLETE_RANGE_OF_MOTION',
        type: 'INCOMPLETE_RANGE_OF_MOTION',
        exercise: def.id,
        phase: 'rep',
        severity: Severity.moderate,
        confidence: roundTo(math.min(1, coverage), 2),
        startTimestamp: jsRound(start).toDouble(),
        endTimestamp: jsRound(end).toDouble(),
        description: 'Ruch nie osiągnął pełnego zakresu wymaganego do zaliczenia powtórzenia.',
        correctiveFeedback: Msg.incompleteRep,
        voiceCue: 'Pełny zakres',
        category: 'rangeOfMotion',
        repIndex: index,
      ));
    }
    if (raw.gapMs > 300) {
      errors = [for (final e in errors) e.copyWith(confidence: roundTo(e.confidence * coverage, 2))];
    }

    var breakdown = scoreRepetition(def, outcomes, extraConfidence: coverage);
    if (!raw.complete || breakdown.analysisConfidence < minScoreConfidence) {
      breakdown = ScoreBreakdown(
        score: null,
        scoreUncertainty: null,
        analysisConfidence: breakdown.analysisConfidence,
        categories: breakdown.categories,
        unmeasured: breakdown.unmeasured,
      );
    }

    final metrics = <String, MetricSummary>{};
    final names = <String>{for (final f in moving) ...f.features.keys};
    for (final name in names) {
      final vals = [for (final f in moving) if (f.features[name] != null) f.features[name]!.value];
      if (vals.isNotEmpty) {
        metrics[name] = MetricSummary(roundTo(vals.reduce(math.min), 3), roundTo(vals.reduce(math.max), 3),
            roundTo(mean(vals), 3));
      }
    }
    final seriesFeatures = <String, List<double?>>{};
    for (final f in {signal, ...def.comparisonFeatures}) {
      final r = resample([for (final fr in moving) fr.features[f]?.value], seriesPoints);
      seriesFeatures[f] = r != null ? [for (final v in r) roundTo(v, 4)] : List<double?>.filled(seriesPoints, null);
    }
    final rep = ExerciseRepetition(
      id: '${def.id}-rep-$index',
      index: index,
      startTimestamp: jsRound(start).toDouble(),
      endTimestamp: jsRound(end).toDouble(),
      durationMs: jsRound(duration).toDouble(),
      phases: [
        for (final p in phases)
          PhaseSpan(p.id, p.kind, jsRound(p.startTimestamp).toDouble(), jsRound(p.endTimestamp).toDouble()),
      ],
      biomechanicalMetrics: metrics,
      detectedErrors: errors,
      techniqueScore: breakdown.score,
      analysisConfidence: breakdown.analysisConfidence,
      breakdown: breakdown,
      incomplete: !raw.complete,
      series: RepSeries([
        for (var i = 0; i < seriesPoints; i++) jsRound(start + duration * i / (seriesPoints - 1)).toDouble(),
      ], seriesFeatures),
    );
    _repetitions.add(rep);
    _repFrames.add(frames);

    if (raw.complete) {
      for (final p in rep.phases) {
        if (p.kind == PhaseKind.start) continue;
        _history.putIfAbsent(p.id, () => []).add(p.endTimestamp - p.startTimestamp);
      }
    }

    final ts = _lastTs;
    for (final o in outcomes) {
      _offerError(o, ts);
    }
    // The main issue of this rep is said right away, so the athlete knows what to fix in the next one.
    final ranked = errors.where((e) => e.type != 'INCOMPLETE_RANGE_OF_MOTION').toList()
      ..sort((a, b) =>
          (_severityRank[b.severity]! * b.confidence).compareTo(_severityRank[a.severity]! * a.confidence));
    for (final e in ranked) {
      if (_feedback.offerError(e, def.rule(e.type)?.importance ?? 0.5, ts, immediate: true)) break;
    }
    if (!raw.complete) _feedback.offerError(errors.last, 0.7, ts);
    for (final e in errors) {
      final rule = def.rule(e.type);
      if ((rule?.safetyCritical ?? false) && e.severity == Severity.high && e.confidence >= 0.6) {
        final n = (_safetyHits[e.type] ?? 0) + 1;
        _safetyHits[e.type] = n;
        if (n >= 2 && !_stopSet) {
          _stopSet = true;
          _feedback.offerSystem(FeedbackKind.safety, Msg.stopSet, ts, voice: 'Zatrzymaj serię', key: 'stop-set');
        }
      }
    }
    _provisional.clear();
    return rep;
  }

  List<KeyMetric> _keyMetrics() {
    if (_frames.isEmpty) return const [];
    final last = _frames.last;
    return [
      for (final n in {exercise.repetition.signal, ...exercise.comparisonFeatures})
        if (last.features[n] != null)
          KeyMetric(n, featureLabels[n] ?? n, roundTo(last.features[n]!.value, 2), features[n]?.unit ?? '',
              roundTo(last.features[n]!.confidence, 2)),
    ];
  }

  CameraView _dominantView() {
    var best = CameraView.unknown;
    var n = -1;
    _viewVotes.forEach((v, c) {
      if (c > n) {
        best = v;
        n = c;
      }
    });
    return best;
  }

  TechniqueAnalysis _buildReport() {
    final def = exercise;
    final reps = _repetitions;
    final complete = reps.where((r) => !r.incomplete).toList();
    final scored = complete.where((r) => r.techniqueScore != null).toList();
    final scores = [for (final r in scored) r.techniqueScore!.toDouble()];

    final agg = <String, _Agg>{};
    for (final r in reps) {
      for (final e in r.detectedErrors) {
        final a = agg.putIfAbsent(
            e.type, () => _Agg(e, def.rule(e.type)?.label ?? 'Niepełny zakres ruchu'));
        a.meanConfidence = (a.meanConfidence * a.count + e.confidence) / (a.count + 1);
        a.count++;
        a.repIndices.add(r.index);
        if (_severityRank[e.severity]! > _severityRank[a.maxSeverity]!) a.maxSeverity = e.severity;
      }
    }
    double weight(_Agg a) => _severityRank[a.maxSeverity]! * a.count * roundTo(a.meanConfidence, 2);
    final aggList = agg.values.toList()..sort((a, b) => weight(b).compareTo(weight(a)));
    final detectedErrors = [
      for (final a in aggList)
        AggregatedError(
          type: a.type,
          label: a.label,
          category: a.category,
          count: a.count,
          repIndices: a.repIndices,
          maxSeverity: a.maxSeverity,
          meanConfidence: roundTo(a.meanConfidence, 2),
          correction: a.correction,
          description: a.description,
        ),
    ];

    int? best, worst;
    if (scored.isNotEmpty) {
      best = scored.reduce((a, b) => b.techniqueScore! > a.techniqueScore! ? b : a).index;
      worst = scored.reduce((a, b) => b.techniqueScore! < a.techniqueScore! ? b : a).index;
    }
    double? phaseMean(PhaseKind kind) {
      final d = [
        for (final r in complete)
          for (final p in r.phases)
            if (p.kind == kind) p.endTimestamp - p.startTimestamp,
      ];
      return d.isEmpty ? null : jsRound(mean(d)).toDouble();
    }

    int? consistency;
    if (complete.length >= 2) {
      final durCv = coefficientOfVariation([for (final r in complete) r.durationMs]);
      final sig = def.repetition.signal;
      final roms = [
        for (final r in complete)
          r.biomechanicalMetrics[sig] != null ? r.biomechanicalMetrics[sig]!.max - r.biomechanicalMetrics[sig]!.min : 0.0,
      ];
      final romCv = coefficientOfVariation(roms);
      final scoreStd = scores.length >= 2 ? std(scores) : 0.0;
      consistency = jsRound(clampD(100 - durCv * 60 - romCv * 120 - scoreStd * 0.8, 0, 100));
    }

    final recommendations = <String>[
      for (final e in detectedErrors.take(3))
        e.correction + (def.rule(e.type)?.recommendedAction != null ? ' ${def.rule(e.type)!.recommendedAction}' : ''),
    ];
    final unmeasured = <String, String>{};
    for (final r in complete) {
      for (final u in r.breakdown.unmeasured) {
        unmeasured[u.rule] = u.reason;
      }
    }
    if (unmeasured.isNotEmpty) {
      recommendations.add(Msg.unmeasurable(unmeasured.keys.take(4).join(', ').toLowerCase()));
    }
    if (reps.isEmpty) {
      recommendations.add('Nie wykryto żadnego powtórzenia. Sprawdź ustawienie kamery i wykonaj pełny ruch.');
    }

    final viewTotal = _viewVotes.values.fold<int>(0, (a, b) => a + b);
    final dominant = _dominantView();
    final issues = _issues.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
    final cameraQuality = CameraQuality(
      view: dominant,
      viewConfidence: viewTotal > 0 ? roundTo((_viewVotes[dominant] ?? 0) / viewTotal, 2) : 0,
      meanVisibility: _visibilityN > 0 ? roundTo(_visibilitySum / _visibilityN, 2) : 0,
      usableFrameRatio: _framesReceived > 0 ? roundTo(_framesAnalysed / _framesReceived, 2) : 0,
      brightness: _brightness.isNotEmpty ? roundTo(mean(_brightness), 2) : null,
      issues: [for (final e in issues.take(5)) e.key],
    );
    final elapsed = _firstTs != null ? (_lastTs - _firstTs!) / 1000 : 0.0;
    final processing = ProcessingMetrics(
      framesReceived: _framesReceived,
      framesAnalysed: _framesAnalysed,
      meanEngineMs: roundTo(_engineTimes.isEmpty ? 0 : mean(_engineTimes), 2),
      p95EngineMs: roundTo(_engineTimes.isEmpty ? 0 : percentile(_engineTimes, 95), 2),
      meanInferenceMs: _inferenceTimes.isNotEmpty ? roundTo(mean(_inferenceTimes), 1) : null,
      effectiveFps: elapsed > 0 ? roundTo(_framesReceived / elapsed, 1) : 0,
    );
    final recFrames = [
      for (var i = 0; i < _repFrames.length; i++)
        if (!reps[i].incomplete) ..._repFrames[i],
    ];
    final recognition = _recognizer.classify(recFrames, def.id);
    final safetyNotes = <String>[if (_stopSet) Msg.stopSet, Msg.disclaimer];
    if (def.evaluationRules.any((r) => r.reliability < 0.7)) {
      safetyNotes.add(
          'Część ocen (np. pozycja pleców, tor sztangi) opiera się na pośrednich wskaźnikach z obrazu 2D i ma ograniczoną dokładność.');
    }
    final confs = [for (final r in complete) r.analysisConfidence];
    return TechniqueAnalysis(
      exerciseId: def.id,
      repetitionCount: complete.length,
      partialRepetitions: reps.length - complete.length,
      repetitions: List.unmodifiable(reps),
      averageTechniqueScore: scores.isEmpty ? null : jsRound(mean(scores)),
      analysisConfidence:
          confs.isEmpty ? 0 : roundTo(mean(confs) * math.min(1, 0.5 + cameraQuality.usableFrameRatio), 2),
      detectedErrors: detectedErrors,
      bestRepetition: best,
      worstRepetition: worst,
      consistency: consistency,
      tempo: Tempo(phaseMean(PhaseKind.concentric), phaseMean(PhaseKind.eccentric),
          complete.isEmpty ? null : jsRound(mean([for (final r in complete) r.durationMs])).toDouble()),
      recommendations: recommendations,
      cameraQuality: cameraQuality,
      processingMetrics: processing,
      recognition: recognition,
      safetyNotes: safetyNotes,
      engineVersion: engineVersion,
    );
  }
}

class _Agg {
  final String type, label, category, correction, description;
  int count = 0;
  final repIndices = <int>[];
  Severity maxSeverity;
  double meanConfidence = 0;
  _Agg(TechniqueError e, this.label)
      : type = e.type,
        category = e.category,
        correction = e.correctiveFeedback,
        description = e.description,
        maxSeverity = e.severity;
}

/// Moves the setup / first-movement boundary back to where the onset feature first rose from its setup minimum.
List<PhaseSpan> refineOnset(ExerciseDefinition def, List<PhaseSpan> phases, List<BiomechanicalFrame> frames) {
  final f = def.repetition.onsetFeature;
  if (f == null || phases.length < 2) return phases;
  final setup = phases[0], first = phases[1];
  final eps = def.repetition.onsetEpsilon ?? 0.01;
  final win = frames
      .where((fr) => fr.timestamp >= setup.startTimestamp && fr.timestamp <= first.startTimestamp && fr.features[f] != null)
      .toList();
  if (win.length < 3) return phases;
  var minV = double.infinity;
  for (final fr in win) {
    minV = math.min(minV, fr.features[f]!.value);
  }
  var onset = first.startTimestamp;
  for (var i = win.length - 1; i >= 0; i--) {
    if (win[i].features[f]!.value <= minV + eps) {
      onset = win[i].timestamp;
      break;
    }
  }
  if (onset >= first.startTimestamp) return phases;
  return [
    PhaseSpan(setup.id, setup.kind, setup.startTimestamp, onset),
    PhaseSpan(first.id, first.kind, onset, first.endTimestamp),
    ...phases.skip(2),
  ];
}

/// All features an exercise definition needs.
List<String> featuresOf(ExerciseDefinition def) {
  final out = <String>{def.repetition.signal, ...def.comparisonFeatures};
  if (def.repetition.onsetFeature != null) out.add(def.repetition.onsetFeature!);
  for (final r in def.evaluationRules) {
    final c = r.condition;
    for (final x in [c.feature, c.numerator, c.denominator, c.left, c.right]) {
      if (x != null) out.add(x);
    }
  }
  return out.toList();
}

void _pushCapped(List<double> arr, double v, [int cap = 3000]) {
  arr.add(v);
  if (arr.length > cap) arr.removeAt(0);
}
