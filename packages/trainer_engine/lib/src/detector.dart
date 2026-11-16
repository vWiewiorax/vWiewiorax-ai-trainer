import 'dart:math' as math;

import 'types.dart';

/// States: 'low' | 'rising' | 'high' | 'falling'.
class RepCycle {
  int index;
  final double startTimestamp;
  final double endTimestamp;
  final double durationMs;
  final List<PhaseSpan> phases;
  final bool complete;
  final double range;
  final double min;
  final double max;
  final double gapMs;
  final bool counted;
  RepCycle({
    this.index = 0,
    required this.startTimestamp,
    required this.endTimestamp,
    required this.durationMs,
    required this.phases,
    required this.complete,
    required this.range,
    required this.min,
    required this.max,
    required this.gapMs,
    required this.counted,
  });
}

class DetectorUpdate {
  final String? phase;
  final PhaseKind? phaseKind;
  final int repCount;
  final bool countedNow;
  final RepCycle? finished;
  final bool inRep;
  const DetectorUpdate(this.phase, this.phaseKind, this.repCount, this.countedNow, this.finished, this.inRep);
}

class _Span {
  final String state;
  final double start;
  final double end;
  const _Span(this.state, this.start, this.end);
}

class _Cycle {
  final double start;
  final double setupStart;
  final spans = <_Span>[];
  bool reachedOpposite = false;
  double min;
  double max;
  double gapMs = 0;
  bool counted = false;
  double? closingSince;
  _Cycle(this.start, this.setupStart, this.min, this.max);
}

const _setupWindowMs = 700.0;
const _settleMs = 350.0;
const _maxGapMs = 400.0;

/// Exercise-agnostic repetition state machine with hysteresis, minimum phase durations,
/// minimum range and debounced counting.
class RepetitionDetector {
  final RepetitionConfig cfg;
  final List<PhaseDefinition> phaseDefs;
  String? _state;
  double _stateSince = 0;
  (double, double)? _extreme;
  double? _lastT;
  double? _lastValidT;
  int _count = 0;
  _Cycle? _cycle;
  late final Map<String, PhaseKind> _kinds;
  late final String _opposite;

  RepetitionDetector(this.cfg, this.phaseDefs) {
    _opposite = cfg.startPosition == 'low' ? 'high' : 'low';
    _kinds = cfg.startPosition == 'low'
        ? {
            'low': PhaseKind.start,
            'rising': PhaseKind.concentric,
            'high': PhaseKind.end,
            'falling': PhaseKind.eccentric
          }
        : {
            'high': PhaseKind.start,
            'falling': PhaseKind.eccentric,
            'low': PhaseKind.end,
            'rising': PhaseKind.concentric
          };
  }

  int get repCount => _count;

  void reset() {
    _state = null;
    _extreme = null;
    _cycle = null;
    _count = 0;
    _lastT = null;
    _lastValidT = null;
  }

  void abort() {
    if (_cycle?.counted ?? false) _count--;
    _cycle = null;
    _state = null;
    _extreme = null;
    _lastValidT = null;
  }

  DetectorUpdate update(double t, Measurement? m) {
    final dt = _lastT == null ? 0 : t - _lastT!;
    _lastT = t;
    RepCycle? finished;
    var countedNow = false;
    if (m == null || !m.value.isFinite) {
      if (_cycle != null && _lastValidT != null && t - _lastValidT! > _maxGapMs) _cycle!.gapMs += dt;
      return _result(null, false);
    }
    _lastValidT = t;
    final v = m.value;
    final lo = cfg.lowThreshold, hi = cfg.highThreshold, h = cfg.hysteresis;
    if (_state == null) {
      if (v <= lo) {
        _enter('low', t, v);
      } else if (v >= hi) {
        _enter('high', t, v);
      }
      return _result(null, false);
    }
    if (_cycle != null) {
      _cycle!.min = math.min(_cycle!.min, v);
      _cycle!.max = math.max(_cycle!.max, v);
    }
    final elapsed = t - _stateSince;
    switch (_state) {
      case 'low':
        _trackExtreme(t, v, true);
        if (v > lo + h) _leave('rising', t, v);
      case 'high':
        _trackExtreme(t, v, false);
        if (v < hi - h) _leave('falling', t, v);
      case 'rising':
        if (v >= hi && elapsed >= cfg.minPhaseMs) {
          _transition('high', t, v);
        } else if (v <= lo) {
          _transition('low', t, v);
        }
      case 'falling':
        if (v <= lo && elapsed >= cfg.minPhaseMs) {
          _transition('low', t, v);
        } else if (v >= hi) {
          _transition('high', t, v);
        }
    }
    final c = _cycle;
    if (c != null && _state == _opposite && !c.reachedOpposite) {
      c.reachedOpposite = true;
      if (cfg.countAt == _opposite && t - c.start >= cfg.minRepMs * 0.4) {
        c.counted = true;
        _count++;
        countedNow = true;
      }
    }
    if (c != null && _state == cfg.startPosition) {
      c.closingSince ??= t;
      if (t - c.closingSince! >= _settleMs) {
        final r = _finalize(_extreme?.$1 ?? t);
        finished = r.$1;
        countedNow = countedNow || r.$2;
      }
    }
    return _result(finished, countedNow);
  }

  /// Phases of the currently open cycle up to t.
  (double, List<PhaseSpan>)? snapshot(double t) {
    final c = _cycle;
    if (c == null) return null;
    final spans = [...c.spans];
    if (_state != null) spans.add(_Span(_state!, _stateSince, t));
    return (
      c.start,
      [
        PhaseSpan(cfg.phases.byState(cfg.startPosition), PhaseKind.start, c.setupStart, c.start),
        for (final s in spans)
          if (s.end > s.start) PhaseSpan(cfg.phases.byState(s.state), _kinds[s.state]!, s.start, s.end),
      ]
    );
  }

  RepCycle? flush(double t) {
    if (_cycle == null) return null;
    if (cfg.requireReturn && _state != cfg.startPosition) {
      if (_cycle!.counted) _count--;
      _cycle = null;
      return null;
    }
    return _finalize(t).$1;
  }

  void _enter(String state, double t, double v) {
    _state = state;
    _stateSince = t;
    _extreme = state == 'low' || state == 'high' ? (t, v) : null;
  }

  void _trackExtreme(double t, double v, bool isMin) {
    final eps = cfg.hysteresis * 0.3;
    final e = _extreme;
    if (e == null) {
      _extreme = (t, v);
      return;
    }
    final better = isMin ? v < e.$2 : v > e.$2;
    if (better) {
      _extreme = (t, v);
    } else if ((v - e.$2).abs() <= eps) {
      _extreme = (t, e.$2);
    }
  }

  void _leave(String next, double t, double v) {
    final boundary = _extreme?.$1 ?? t;
    final from = _state!;
    if (from == cfg.startPosition) {
      if (_cycle != null) _finalize(boundary);
      final ev = _extreme?.$2 ?? v;
      _cycle = _Cycle(boundary, math.max(_stateSince, boundary - _setupWindowMs), math.min(v, ev), math.max(v, ev));
    } else if (_cycle != null) {
      _cycle!.spans.add(_Span(from, _stateSince, boundary));
    }
    _state = next;
    _stateSince = boundary;
    _extreme = null;
  }

  void _transition(String next, double t, double v) {
    _cycle?.spans.add(_Span(_state!, _stateSince, t));
    _enter(next, t, v);
  }

  (RepCycle?, bool) _finalize(double end) {
    final c = _cycle;
    _cycle = null;
    if (c == null) return (null, false);
    if (_state != null && _state != cfg.startPosition) {
      c.spans.add(_Span(_state!, _stateSince, end));
    } else if (_state == cfg.startPosition && c.closingSince != null) {
      c.spans.add(_Span(_state!, _stateSince, math.max(_stateSince, end)));
    }
    final range = c.max - c.min;
    final duration = end - c.start;
    if (range < cfg.minRange || duration < cfg.minRepMs * 0.5) {
      if (c.counted) _count--;
      return (null, false);
    }
    var countedNow = false;
    final complete = c.reachedOpposite && duration >= cfg.minRepMs;
    if (complete && !c.counted) {
      _count++;
      c.counted = true;
      countedNow = true;
    }
    if (!complete && c.counted) {
      _count--;
      c.counted = false;
    }
    final spans = c.spans.where((s) => s.end > s.start).toList();
    final phases = <PhaseSpan>[
      PhaseSpan(cfg.phases.byState(cfg.startPosition), PhaseKind.start, c.setupStart, c.start),
      for (var i = 0; i < spans.length; i++)
        PhaseSpan(
          cfg.phases.byState(spans[i].state),
          spans[i].state == cfg.startPosition && i == spans.length - 1 ? PhaseKind.start : _kinds[spans[i].state]!,
          spans[i].start,
          spans[i].end,
        ),
    ];
    return (
      RepCycle(
        startTimestamp: c.start,
        endTimestamp: end,
        durationMs: duration,
        phases: phases,
        complete: complete,
        range: range,
        min: c.min,
        max: c.max,
        gapMs: c.gapMs,
        counted: c.counted,
      ),
      countedNow
    );
  }

  DetectorUpdate _result(RepCycle? finished, bool countedNow) {
    final phase =
        _state != null && (_cycle != null || _state == cfg.startPosition) ? cfg.phases.byState(_state!) : null;
    return DetectorUpdate(phase, _state != null ? _kinds[_state] : null, _count, countedNow, finished, _cycle != null);
  }

  String phaseLabel(String id) {
    for (final p in phaseDefs) {
      if (p.id == id) return p.label;
    }
    return id;
  }
}
