import 'dart:math' as math;

import 'types.dart';

enum FeedbackKind { technique, setup, safety, rep, info }

class FeedbackItem {
  final String id;
  final FeedbackKind kind;
  final String text;
  final String? voice;
  final Severity? severity;
  final String? errorType;
  double priority;
  double timestamp;
  FeedbackItem({
    this.id = '',
    required this.kind,
    required this.text,
    this.voice,
    this.severity,
    this.errorType,
    required this.priority,
    required this.timestamp,
  });

  String get key => errorType ?? text;

  FeedbackItem copyWith({String? id, double? timestamp, String? voice, bool clearVoice = false}) => FeedbackItem(
        id: id ?? this.id,
        kind: kind,
        text: text,
        voice: clearVoice ? null : (voice ?? this.voice),
        severity: severity,
        errorType: errorType,
        priority: priority,
        timestamp: timestamp ?? this.timestamp,
      );
}

class FeedbackOptions {
  final double globalCooldownMs, repeatCooldownMs, minConfidence, visualTtlMs, maxAgeMs;
  final int maxVoicePerType;
  const FeedbackOptions({
    this.globalCooldownMs = 2500,
    this.repeatCooldownMs = 9000,
    this.minConfidence = 0.4,
    this.maxVoicePerType = 3,
    this.visualTtlMs = 3500,
    this.maxAgeMs = 2500,
  });
}

const _severityWeight = {Severity.low: 1.0, Severity.moderate: 2.0, Severity.high: 3.5};

class FeedbackTick {
  final FeedbackItem? emit;
  final List<FeedbackItem> visual;
  const FeedbackTick(this.emit, this.visual);
}

/// Real-time feedback prioritisation: persistence, minimum confidence, cooldowns, duplicate suppression.
class FeedbackEngine {
  final FeedbackOptions opts;
  var _pending = <FeedbackItem>[];
  var _visual = <FeedbackItem>[];
  double _lastEmit = double.negativeInfinity;
  final _lastByKey = <String, double>{};
  final _voiced = <String, int>{};
  final _occurrences = <String, Set<int>>{};
  int _seq = 0;

  FeedbackEngine([this.opts = const FeedbackOptions()]);

  void reset() {
    _pending = [];
    _visual = [];
    _lastEmit = double.negativeInfinity;
    _lastByKey.clear();
    _voiced.clear();
    _occurrences.clear();
  }

  bool offerError(TechniqueError err, double importance, double t, {bool immediate = false}) {
    if (err.confidence < opts.minConfidence) return false;
    final reps = _occurrences.putIfAbsent(err.type, () => <int>{})..add(err.repIndex ?? -1);
    final persistent = immediate ||
        err.severity == Severity.high ||
        reps.length >= 2 ||
        (err.severity == Severity.moderate && err.confidence >= 0.7);
    if (!persistent) return false;
    final boost = 1 + 0.25 * math.min(4, reps.length - 1);
    _queue(FeedbackItem(
      kind: FeedbackKind.technique,
      text: err.correctiveFeedback,
      voice: err.voiceCue,
      severity: err.severity,
      errorType: err.type,
      priority: _severityWeight[err.severity]! * err.confidence * (0.5 + importance) * boost,
      timestamp: t,
    ));
    return true;
  }

  void offerSystem(FeedbackKind kind, String text, double t, {String? voice, double? priority, String? key}) {
    final base =
        switch (kind) { FeedbackKind.safety => 20.0, FeedbackKind.setup => 4.0, FeedbackKind.rep => 0.5, _ => 1.0 };
    _queue(FeedbackItem(
        kind: kind, text: text, voice: voice, priority: priority ?? base, timestamp: t, errorType: key ?? text));
  }

  FeedbackTick tick(double t) {
    _visual = _visual.where((v) => t - v.timestamp <= opts.visualTtlMs).toList();
    _pending = _pending.where((p) => t - p.timestamp <= opts.maxAgeMs).toList();
    FeedbackItem? emit;
    FeedbackItem? safety;
    for (final p in _pending) {
      if (p.kind == FeedbackKind.safety) {
        safety = p;
        break;
      }
    }
    if (_pending.isNotEmpty && (safety != null || t - _lastEmit >= opts.globalCooldownMs)) {
      _pending.sort((a, b) => b.priority.compareTo(a.priority));
      final next = safety ?? _pending.first;
      _pending.remove(next);
      final key = next.key;
      final voiced = _voiced[key] ?? 0;
      final item = next.copyWith(timestamp: t, clearVoice: voiced >= opts.maxVoicePerType);
      if (item.voice != null) _voiced[key] = voiced + 1;
      _lastEmit = t;
      _lastByKey[key] = t;
      _visual = [item, ..._visual.where((v) => v.key != key)].take(3).toList();
      emit = item;
    }
    return FeedbackTick(emit, List.unmodifiable(_visual));
  }

  void _queue(FeedbackItem item) {
    final key = item.key;
    final last = _lastByKey[key];
    if (item.kind != FeedbackKind.safety && last != null && item.timestamp - last < opts.repeatCooldownMs) return;
    for (final p in _pending) {
      if (p.key == key) {
        p.priority = math.max(p.priority, item.priority);
        p.timestamp = item.timestamp;
        return;
      }
    }
    _pending.add(item.copyWith(id: 'fb-${++_seq}'));
  }
}
