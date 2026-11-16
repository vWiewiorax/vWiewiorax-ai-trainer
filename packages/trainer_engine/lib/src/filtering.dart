import 'dart:math' as math;

import 'landmarks.dart';
import 'types.dart';

/// One Euro filter (Casiez et al., CHI 2012).
class OneEuroParams {
  final double minCutoff;
  final double beta;
  final double dCutoff;
  const OneEuroParams({this.minCutoff = 1.7, this.beta = 0.4, this.dCutoff = 1.0});
}

double _alpha(double dt, double cutoff) {
  final r = 2 * math.pi * cutoff * dt;
  return r / (r + 1);
}

class OneEuroFilter {
  final OneEuroParams params;
  double? _x;
  double _dx = 0;
  double? _t;
  OneEuroFilter([this.params = const OneEuroParams()]);

  void reset() {
    _x = null;
    _dx = 0;
    _t = null;
  }

  double filter(double x, double t) {
    if (_x == null || _t == null) {
      _x = x;
      _t = t;
      return x;
    }
    final dt = math.max(1e-3, (t - _t!) / 1000);
    final dx = (x - _x!) / dt;
    final aD = _alpha(dt, params.dCutoff);
    final dxHat = aD * dx + (1 - aD) * _dx;
    final cutoff = params.minCutoff + params.beta * dxHat.abs();
    final a = _alpha(dt, cutoff);
    final xHat = a * x + (1 - a) * _x!;
    _x = xHat;
    _dx = dxHat;
    _t = t;
    return xHat;
  }
}

class LandmarkFilterOptions {
  final double minVisibility;
  final double maxSpeed;
  final double holdMs;
  final double holdDecay;
  final OneEuroParams smoothing;
  final Map<String, double> perLandmarkMinVisibility;
  const LandmarkFilterOptions({
    this.minVisibility = 0.5,
    this.maxSpeed = 8,
    this.holdMs = 250,
    this.holdDecay = 0.7,
    this.smoothing = const OneEuroParams(),
    this.perLandmarkMinVisibility = const {},
  });
}

class _Track {
  final OneEuroFilter fx;
  final OneEuroFilter fy;
  Point? last;
  double lastTs;
  double lastMeasuredTs = double.negativeInfinity;
  _Track(OneEuroParams p, this.lastTs)
      : fx = OneEuroFilter(p),
        fy = OneEuroFilter(p);
}

/// Visibility gating, outlier rejection, short occlusion hold and One Euro smoothing.
class LandmarkFilter {
  final LandmarkFilterOptions opts;
  final _tracks = <String, _Track>{};
  LandmarkFilter([this.opts = const LandmarkFilterOptions()]);

  void reset() => _tracks.clear();

  Pose apply(Pose raw, double t, double bodyScale) {
    final out = <String, Point>{};
    final scaleRef = math.max(0.05, bodyScale);
    for (final name in landmarkNames) {
      final track = _tracks.putIfAbsent(name, () => _Track(opts.smoothing, t));
      final p = raw[name];
      final usable = p != null && p.confidence >= (opts.perLandmarkMinVisibility[name] ?? opts.minVisibility);
      var accepted = false;
      final last = track.last;
      if (usable && last != null && !last.interpolated) {
        final dt = math.max(1, t - track.lastTs) / 1000;
        final dx = p.x - last.x, dy = p.y - last.y;
        final speed = math.sqrt(dx * dx + dy * dy) / dt / scaleRef;
        accepted = speed <= opts.maxSpeed;
      } else if (usable) {
        accepted = true;
        if ((last?.interpolated ?? false) || t - track.lastMeasuredTs > opts.holdMs) {
          track.fx.reset();
          track.fy.reset();
        }
      }
      if (accepted) {
        final point = Point(track.fx.filter(p!.x, t), track.fy.filter(p.y, t), z: p.z, confidence: p.confidence);
        track.last = point;
        track.lastTs = t;
        track.lastMeasuredTs = t;
        out[name] = point;
      } else if (last != null && t - track.lastMeasuredTs <= opts.holdMs) {
        final held = Point(last.x, last.y, z: last.z, confidence: last.confidence * opts.holdDecay, interpolated: true);
        track.last = held;
        track.lastTs = t;
        out[name] = held;
      } else {
        track.last = null;
        track.lastTs = t;
      }
    }
    return out;
  }
}
