import 'dart:math' as math;

import 'body.dart';
import 'geometry.dart';
import 'landmarks.dart';
import 'messages.dart';
import 'types.dart';

/* ---------------- normalize ---------------- */

/// Upright, un-mirrored, aspect-corrected camera space (1 unit = image height).
(Pose, double) normalizeLandmarks(PoseFrame frame) {
  final meta = frame.cameraMetadata;
  final rotated = meta.rotation == 90 || meta.rotation == 270;
  final w = rotated ? meta.height : meta.width;
  final h = rotated ? meta.width : meta.height;
  final aspect = h > 0 ? w / h : 1.0;
  final src = meta.mirrored ? unmirror(frame.landmarks) : frame.landmarks;
  final points = <String, Point>{};
  for (final name in landmarkNames) {
    final l = src[name];
    if (l == null || !l.x.isFinite || !l.y.isFinite) continue;
    final (ux, uy) = switch (meta.rotation) {
      90 => (1 - l.y, l.x),
      180 => (1 - l.x, 1 - l.y),
      270 => (l.y, 1 - l.x),
      _ => (l.x, l.y),
    };
    points[name] = Point(ux * aspect, uy, z: l.z, confidence: math.min(l.visibility, l.presence ?? 1));
  }
  return (points, aspect);
}

Map<String, Landmark> unmirror(Map<String, Landmark> set) {
  final out = <String, Landmark>{};
  for (final name in landmarkNames) {
    final l = set[name];
    if (l != null) out[name] = Landmark(x: 1 - l.x, y: l.y, z: l.z, visibility: l.visibility, presence: l.presence);
  }
  for (final (a, b) in mirrorPairs) {
    final la = out[a], lb = out[b];
    if (lb != null) {
      out[a] = lb;
    } else {
      out.remove(a);
    }
    if (la != null) {
      out[b] = la;
    } else {
      out.remove(b);
    }
  }
  return out;
}

class BodyBox {
  final double minX, maxX, minY, maxY;
  const BodyBox(this.minX, this.maxX, this.minY, this.maxY);
  double get height => maxY - minY;
  double get width => maxX - minX;
}

BodyBox? bodyBox(Pose points, [double minConfidence = 0.3]) {
  var minX = double.infinity, maxX = double.negativeInfinity, minY = double.infinity, maxY = double.negativeInfinity;
  var n = 0;
  for (final p in points.values) {
    if (p.confidence < minConfidence) continue;
    n++;
    minX = math.min(minX, p.x);
    maxX = math.max(maxX, p.x);
    minY = math.min(minY, p.y);
    maxY = math.max(maxY, p.y);
  }
  return n < 4 ? null : BodyBox(minX, maxX, minY, maxY);
}

/* ---------------- view ---------------- */

class ViewEstimate {
  final CameraView view;
  final double confidence;
  final double? widthRatio;
  const ViewEstimate(this.view, this.confidence, this.widthRatio);
}

ViewEstimate? estimateViewInstant(Pose pose, [double minConfidence = 0.4]) {
  final sh = mid(pose, 'leftShoulder', 'rightShoulder', minConfidence);
  final hp = mid(pose, 'leftHip', 'rightHip', minConfidence);
  if (sh == null || hp == null) return null;
  final torso = distance(sh, hp);
  if (torso < 0.05) return null;
  final incl = inclinationFromVertical(hp, sh);
  if (incl == null || incl > 35) return null;
  final sw = distance(pose['leftShoulder']!, pose['rightShoulder']!);
  final hw = distance(pose['leftHip']!, pose['rightHip']!);
  final ratio = (sw + hw * 1.3) / 2 / torso;
  CameraView view;
  double c;
  if (ratio < 0.25) {
    view = CameraView.side;
    c = 1 - ratio / 0.25 * 0.4;
  } else if (ratio < 0.5) {
    view = CameraView.frontSide;
    c = 0.6;
  } else {
    view = _facesCamera(pose) ? CameraView.front : CameraView.rear;
    c = math.min(1, 0.6 + (ratio - 0.5));
  }
  return ViewEstimate(view, clampD(c, 0.3, 1) * math.min(sh.confidence, hp.confidence), ratio);
}

bool _facesCamera(Pose pose) {
  final nose = pose['nose'];
  final sh = mid(pose, 'leftShoulder', 'rightShoulder', 0.3);
  final ls = pose['leftShoulder'], rs = pose['rightShoulder'];
  if (nose?.z != null && sh != null && ls?.z != null && rs?.z != null) {
    return nose!.z! < (ls!.z! + rs!.z!) / 2;
  }
  final eyes = (pose['leftEye']?.confidence ?? 0) + (pose['rightEye']?.confidence ?? 0);
  final leftOnRight = ls != null && rs != null ? ls.x > rs.x : true;
  return (nose?.confidence ?? 0) > 0.5 && eyes > 1 && leftOnRight;
}

(Side, double) nearSideInstant(Pose pose) {
  const names = ['Shoulder', 'Elbow', 'Wrist', 'Hip', 'Knee', 'Ankle'];
  var l = 0.0, r = 0.0, lz = 0.0, rz = 0.0;
  var nz = 0;
  for (final n in names) {
    final pl = pose['left$n'], pr = pose['right$n'];
    l += pl?.confidence ?? 0;
    r += pr?.confidence ?? 0;
    if (pl?.z != null && pr?.z != null && pointOk(pl, 0.2) && pointOk(pr, 0.2)) {
      lz += pl!.z!;
      rz += pr!.z!;
      nz++;
    }
  }
  final visMargin = (l - r) / names.length;
  if (visMargin.abs() > 0.08 || nz == 0) return (visMargin >= 0 ? Side.left : Side.right, visMargin.abs());
  return (lz <= rz ? Side.left : Side.right, (lz - rz).abs() / nz);
}

class _Vote {
  final double t;
  final CameraView view;
  final double c;
  const _Vote(this.t, this.view, this.c);
}

class ViewTracker {
  final double windowMs;
  final double sideSwitchMs;
  var _votes = <_Vote>[];
  ViewEstimate _current = const ViewEstimate(CameraView.unknown, 0, null);
  Side _side = Side.left;
  (Side, double)? _candidate;
  ViewTracker({this.windowMs = 1200, this.sideSwitchMs = 600});

  void reset() {
    _votes = [];
    _current = const ViewEstimate(CameraView.unknown, 0, null);
    _candidate = null;
  }

  (ViewEstimate, Side) update(Pose pose, double t) {
    final inst = estimateViewInstant(pose);
    if (inst != null) _votes.add(_Vote(t, inst.view, inst.confidence));
    _votes = _votes.where((v) => t - v.t <= windowMs).toList();
    if (_votes.isNotEmpty) {
      final tally = <CameraView, double>{};
      var total = 0.0;
      for (final v in _votes) {
        tally[v.view] = (tally[v.view] ?? 0) + v.c;
        total += v.c;
      }
      var best = CameraView.unknown;
      var bestScore = -1.0;
      tally.forEach((view, score) {
        if (score > bestScore) {
          best = view;
          bestScore = score;
        }
      });
      _current = ViewEstimate(best, total > 0 ? bestScore / total * math.min(1, total / _votes.length) : 0,
          inst?.widthRatio ?? _current.widthRatio);
    }
    final (side, margin) = nearSideInstant(pose);
    if (side != _side && margin > 0.05) {
      if (_candidate == null || _candidate!.$1 != side) {
        _candidate = (side, t);
      } else if (t - _candidate!.$2 >= sideSwitchMs) {
        _side = side;
        _candidate = null;
      }
    } else if (side == _side) {
      _candidate = null;
    }
    return (_current, _side);
  }
}

/* ---------------- continuity ---------------- */

enum Discontinuity { none, gap, jump }

class ContinuityMonitor {
  final double maxStepMs, maxShift, maxScaleRatio, maxGapMs, minConfidence;
  (double, V2, double)? _prev;
  ContinuityMonitor(
      {this.maxStepMs = 300,
      this.maxShift = 0.6,
      this.maxScaleRatio = 1.35,
      this.maxGapMs = 1000,
      this.minConfidence = 0.5});

  void reset() => _prev = null;

  Discontinuity update(Pose points, double t) {
    Point? ok(String n) {
      final p = points[n];
      return p != null && p.confidence >= minConfidence ? p : null;
    }

    V2? avg(V2? a, V2? b) => a != null && b != null ? midpoint(a, b) : a ?? b;
    final sh = avg(ok('leftShoulder'), ok('rightShoulder'));
    final hip = avg(ok('leftHip'), ok('rightHip'));
    if (sh == null || hip == null) return Discontinuity.none;
    final len = distance(sh, hip);
    if (len < 1e-3) return Discontinuity.none;
    final c = midpoint(sh, hip);
    final prev = _prev;
    _prev = (t, c, len);
    if (prev == null) return Discontinuity.none;
    final dt = t - prev.$1;
    final ratio = math.max(len / prev.$3, prev.$3 / len);
    if (dt > maxGapMs) return ratio > maxScaleRatio ? Discontinuity.jump : Discontinuity.gap;
    if (dt <= maxStepMs && (ratio > maxScaleRatio || distance(c, prev.$2) > maxShift * prev.$3))
      return Discontinuity.jump;
    return Discontinuity.none;
  }
}

/* ---------------- calibration ---------------- */

class CalibrationState {
  final CalibrationStatus status;
  final List<String> guidance;
  final double progress;
  final List<String> missingLandmarks;
  final BodyBaseline? baseline;
  final CameraView view;
  final bool analysisAllowed;

  /// 'standing' | 'motion' | 'stored' | null
  final String? baselineSource;
  const CalibrationState({
    required this.status,
    required this.guidance,
    required this.progress,
    required this.missingLandmarks,
    required this.baseline,
    required this.view,
    required this.analysisAllowed,
    required this.baselineSource,
  });
}

class CalibrationOptions {
  final double minVisibility,
      occludedMinVisibility,
      edgeMargin,
      minBodyHeight,
      maxBodyHeight,
      stillnessMs,
      stillnessTolerance,
      lostAfterMs,
      wrongViewAfterMs,
      minBrightness,
      motionCalibrationMs;
  const CalibrationOptions({
    this.minVisibility = 0.5,
    this.occludedMinVisibility = 0.2,
    this.edgeMargin = 0.015,
    this.minBodyHeight = 0.35,
    this.maxBodyHeight = 0.97,
    this.stillnessMs = 800,
    this.stillnessTolerance = 0.035,
    this.lostAfterMs = 700,
    this.wrongViewAfterMs = 1500,
    this.minBrightness = 0.16,
    this.motionCalibrationMs = 2500,
  });
}

class CalibrationMonitor {
  final ExerciseDefinition def;
  final CalibrationOptions opts;
  CalibrationStatus _status = CalibrationStatus.notStarted;
  BodyBaseline? _baseline;
  double? _stillSince;
  V2? _anchor;
  var _samples = <Segments>[];
  double _lastGood = double.negativeInfinity;
  double? _wrongViewSince;
  double? _motionSince;
  var _motionSamples = <Segments>[];
  String? _source;

  CalibrationMonitor(this.def, [this.opts = const CalibrationOptions()]);

  CalibrationStatus get current => _status;

  void start() {
    _status = CalibrationStatus.positioning;
    _baseline = null;
    _samples = [];
    _stillSince = null;
    _motionSince = null;
    _motionSamples = [];
    _source = null;
  }

  void restore(BodyBaseline b) {
    _baseline = b;
    _source = 'stored';
    _status = CalibrationStatus.ready;
  }

  CalibrationState update(NormalizedFrame frame, ViewEstimate view, Side nearSide) {
    if (_status == CalibrationStatus.notStarted) start();
    final t = frame.timestamp;
    final guidance = <String>[];
    final required = requiredFor(def, view.view, nearSide);
    final occludable = def.occludableLandmarks.toSet();
    final missing = required
        .where(
            (n) => !pointOk(frame.points[n], occludable.contains(n) ? opts.occludedMinVisibility : opts.minVisibility))
        .toList();
    final visibleCount = required.length - missing.length;
    final box = bodyBox(frame.points, 0.4);
    final wasReady = _baseline != null &&
        (_status == CalibrationStatus.ready ||
            _status == CalibrationStatus.insufficientVisibility ||
            _status == CalibrationStatus.incorrectCameraAngle);

    var visibilityOk = true;
    if (box == null || visibleCount < required.length * 0.4) {
      guidance.add(Msg.noPerson);
      visibilityOk = false;
    } else if (missing.isNotEmpty) {
      guidance.add(Msg.missing({for (final m in missing) bodyPartPl[m] ?? m}.join(', ')));
      visibilityOk = false;
    }
    if (box != null) {
      if (box.minY < opts.edgeMargin) guidance.add(Msg.headCut);
      if (box.maxY > 1 - opts.edgeMargin) guidance.add(Msg.feetCut);
      if (box.minX < opts.edgeMargin || box.maxX > frame.aspect - opts.edgeMargin) guidance.add(Msg.sideCut);
      if (box.height > opts.maxBodyHeight) {
        guidance.add(Msg.tooClose);
      } else if (box.height < opts.minBodyHeight && def.calibrationPose == 'standing') {
        guidance.add(Msg.tooFar);
      }
    }
    final brightness = frame.cameraMetadata.brightness;
    if (brightness != null && brightness < opts.minBrightness) guidance.add(Msg.tooDark);
    if (visibilityOk) _lastGood = t;

    final viewKnown = view.view != CameraView.unknown && view.confidence > 0.35;
    final viewOk = !viewKnown || def.allowedCameraAngles.contains(view.view);
    if (!viewOk) {
      _wrongViewSince ??= t;
    } else {
      _wrongViewSince = null;
    }
    final viewMsg = Msg.wrongView(viewPl[def.preferredCameraAngle.id]!);

    if (wasReady) {
      if (!visibilityOk && t - _lastGood > opts.lostAfterMs) {
        _status = CalibrationStatus.insufficientVisibility;
        guidance.insert(0, Msg.lost);
      } else if (_wrongViewSince != null && t - _wrongViewSince! > opts.wrongViewAfterMs) {
        _status = CalibrationStatus.incorrectCameraAngle;
        guidance.insert(0, viewMsg);
      } else if (visibilityOk || t - _lastGood <= opts.lostAfterMs) {
        _status = CalibrationStatus.ready;
      }
      return _state(guidance, missing, view.view, 1);
    }
    if (!visibilityOk) {
      _status = CalibrationStatus.insufficientVisibility;
      _resetStillness();
      _resetMotion();
      return _state(guidance, missing, view.view, 0);
    }
    if (!viewOk) {
      _status = CalibrationStatus.incorrectCameraAngle;
      guidance.insert(0, viewMsg);
      _resetStillness();
      _resetMotion();
      return _state(guidance, missing, view.view, 0);
    }
    _motionSince ??= t;
    _motionSamples.add(measureSegments(frame.points, nearSide, opts.minVisibility));
    if (def.calibrationPose == 'standing' && !_isStanding(frame, nearSide)) {
      _resetStillness();
      final motionProgress = math.min(1.0, (t - _motionSince!) / opts.motionCalibrationMs);
      if (motionProgress >= 1) {
        final b = aggregateBaseline(_motionSamples, 0.85);
        if (b != null) {
          _baseline = b;
          _source = 'motion';
          _status = CalibrationStatus.ready;
          return _state([Msg.ready, ...guidance], missing, view.view, 1);
        }
      }
      _status = CalibrationStatus.positioning;
      guidance.insert(0, Msg.standStill);
      return _state(guidance, missing, view.view, motionProgress * 0.95);
    }
    final center = box != null ? V2((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2) : null;
    final tol = opts.stillnessTolerance * math.max(0.3, box?.height ?? 1);
    if (center == null || _anchor == null || distance(center, _anchor!) > tol) {
      _anchor = center;
      _stillSince = t;
      _samples = [];
    }
    _samples.add(measureSegments(frame.points, nearSide, opts.minVisibility));
    final progress = math.min(1.0, (t - (_stillSince ?? t)) / opts.stillnessMs);
    if (progress >= 1) {
      _baseline = aggregateBaseline(_samples);
      if (_baseline != null) {
        _source = 'standing';
        _status = CalibrationStatus.ready;
        return _state([Msg.ready, ...guidance], missing, view.view, 1);
      }
    }
    _status = CalibrationStatus.calibrating;
    return _state([Msg.calibrating, ...guidance], missing, view.view, progress);
  }

  void _resetMotion() {
    _motionSince = null;
    _motionSamples = [];
  }

  void _resetStillness() {
    _stillSince = null;
    _anchor = null;
    _samples = [];
  }

  CalibrationState _state(List<String> g, List<String> missing, CameraView view, double progress) => CalibrationState(
        status: _status,
        guidance: g.toSet().toList(),
        progress: progress,
        missingLandmarks: missing,
        baseline: _baseline,
        view: view,
        analysisAllowed: _status == CalibrationStatus.ready,
        baselineSource: _source,
      );
}

bool _isStanding(NormalizedFrame f, Side side) {
  final p = f.points;
  final sh = p[sided(side, 'Shoulder')],
      hip = p[sided(side, 'Hip')],
      knee = p[sided(side, 'Knee')],
      ankle = p[sided(side, 'Ankle')];
  if (!pointOk(sh, 0.4) || !pointOk(hip, 0.4) || !pointOk(knee, 0.4) || !pointOk(ankle, 0.4)) return false;
  final incl = inclinationFromVertical(hip!, sh!);
  final ka = jointAngle(hip, knee!, ankle!);
  return incl != null && ka != null && incl < 25 && ka > 150;
}

BodyBaseline? aggregateBaseline(List<Segments> samples, [double? q]) {
  double? pick(String k) {
    final v = [
      for (final s in samples)
        if (s[k] != null) s[k]!
    ];
    if (v.isEmpty) return null;
    if (q == null) return median(v);
    v.sort();
    return v[math.min(v.length - 1, (q * (v.length - 1)).floor())];
  }

  final torso = pick('torso'), thigh = pick('thigh'), shin = pick('shin');
  if (torso == null || torso == 0 || thigh == null || thigh == 0 || shin == null || shin == 0) return null;
  return BodyBaseline(
    torso: torso,
    thigh: thigh,
    shin: shin,
    upperArm: pick('upperArm') ?? torso * 0.6,
    forearm: pick('forearm') ?? torso * 0.5,
    shoulderWidth: pick('shoulderWidth') ?? torso * 0.8,
    hipWidth: pick('hipWidth') ?? torso * 0.5,
    legLength: thigh + shin,
    height: pick('height') ?? torso + thigh + shin + torso * 0.35,
  );
}

List<String> requiredFor(ExerciseDefinition def, CameraView view, Side nearSide) {
  if (def.requireSides == 'both' || (view != CameraView.side && view != CameraView.frontSide))
    return def.requiredLandmarks;
  final far = otherSide(nearSide).name;
  return def.requiredLandmarks.where((n) => !n.startsWith(far)).toList();
}
