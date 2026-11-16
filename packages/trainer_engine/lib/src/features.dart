import 'dart:math' as math;

import 'body.dart';
import 'geometry.dart';
import 'kinematics.dart';
import 'landmarks.dart';
import 'types.dart';

class FeatureContext {
  final Pose pose;
  final Side nearSide;
  final CameraView view;
  final BodyBaseline? baseline;

  /// +1 when the athlete faces +x in the image, -1 when facing -x.
  final int facing;
  final double minConfidence;
  const FeatureContext(this.pose, this.nearSide, this.view, this.baseline, this.facing, this.minConfidence);
}

class FeatureSpec {
  /// 'joint' | 'alignment'
  final String group;

  /// 'deg' | 'ratio' | 'body'
  final String unit;
  final String description;
  final Measurement? Function(FeatureContext) compute;
  const FeatureSpec(this.group, this.unit, this.description, this.compute);
}

const _minSeg = 1e-4;

List<Point>? _pts(FeatureContext ctx, List<String> names) {
  final out = <Point>[];
  for (final n in names) {
    final p = ctx.pose[n];
    if (!pointOk(p, ctx.minConfidence)) return null;
    out.add(p!);
  }
  return out;
}

double _conf(List<Point?> ps) =>
    ps.map((p) => p == null ? 0.0 : p.confidence * (p.interpolated ? 0.8 : 1)).reduce(math.min);

Measurement? _angle3(FeatureContext ctx, String a, String b, String c) {
  final p = _pts(ctx, [a, b, c]);
  if (p == null) return null;
  final v = jointAngle(p[0], p[1], p[2]);
  return v == null ? null : Measurement(v, _conf(p));
}

String _l(Side s, String base) => sided(s, base);

class _Centers {
  final Point? shoulder, hip, knee, ankle, wrist;
  const _Centers(this.shoulder, this.hip, this.knee, this.ankle, this.wrist);
}

_Centers _centers(FeatureContext ctx) {
  final near = ctx.nearSide;
  final sideView = ctx.view == CameraView.side || ctx.view == CameraView.frontSide;
  Point? nearPoint(String n) => pointOk(ctx.pose[n], ctx.minConfidence) ? ctx.pose[n] : null;
  Point? pick(String a, String b, String nearName) => sideView
      ? nearPoint(nearName) ?? mid(ctx.pose, a, b, ctx.minConfidence)
      : mid(ctx.pose, a, b, ctx.minConfidence) ?? nearPoint(nearName);
  return _Centers(
    pick('leftShoulder', 'rightShoulder', _l(near, 'Shoulder')),
    pick('leftHip', 'rightHip', _l(near, 'Hip')),
    pick('leftKnee', 'rightKnee', _l(near, 'Knee')),
    pick('leftAnkle', 'rightAnkle', _l(near, 'Ankle')),
    pick('leftWrist', 'rightWrist', _l(near, 'Wrist')),
  );
}

class _Len {
  final double torso, legLength, shin, shoulderWidth;
  const _Len(this.torso, this.legLength, this.shin, this.shoulderWidth);
}

_Len? _lengths(FeatureContext ctx) {
  final b = ctx.baseline;
  if (b != null) return _Len(b.torso, b.legLength, b.shin, b.shoulderWidth);
  final m = measureSegments(ctx.pose, ctx.nearSide, ctx.minConfidence);
  final torso = m['torso'], leg = m['legLength'], shin = m['shin'];
  if (torso == null || leg == null || shin == null) return null;
  return _Len(torso, leg, shin, m['shoulderWidth'] ?? torso * 0.8);
}

Point? _midfoot(FeatureContext ctx) {
  final heel = ctx.pose[_l(ctx.nearSide, 'Heel')];
  final toe = ctx.pose[_l(ctx.nearSide, 'FootIndex')];
  if (pointOk(heel, ctx.minConfidence) && pointOk(toe, ctx.minConfidence)) {
    return Point((heel!.x + toe!.x) / 2, (heel.y + toe.y) / 2, confidence: math.min(heel.confidence, toe.confidence));
  }
  final ankle = ctx.pose[_l(ctx.nearSide, 'Ankle')];
  return pointOk(ankle, ctx.minConfidence) ? ankle!.withConfidence(ankle.confidence * 0.7) : null;
}

Measurement? _heightAboveAnkles(FeatureContext ctx, Point? p) {
  final c = _centers(ctx);
  final len = _lengths(ctx);
  if (p == null || c.ankle == null || len == null || len.legLength < _minSeg) return null;
  return Measurement((c.ankle!.y - p.y) / len.legLength, _conf([p, c.ankle]));
}

Measurement? _tilt(FeatureContext ctx, String a, String b) {
  final p = _pts(ctx, [a, b]);
  if (p == null || distance(p[0], p[1]) < 0.02) return null;
  final v = signedAngleFromHorizontal(p[0], p[1]);
  if (v == null) return null;
  final abs = v.abs();
  return Measurement(math.min(abs, 180 - abs), _conf(p));
}

final Map<String, FeatureSpec> _sidedAngles = () {
  final out = <String, FeatureSpec>{};
  const defs = [
    ('KneeAngle', 'Hip', 'Knee', 'Ankle', 'Kąt w stawie kolanowym (180° = wyprost)'),
    ('HipAngle', 'Shoulder', 'Hip', 'Knee', 'Kąt tułów-udo w stawie biodrowym (180° = wyprost)'),
    ('ElbowAngle', 'Shoulder', 'Elbow', 'Wrist', 'Kąt w stawie łokciowym (180° = wyprost)'),
    ('ShoulderAngle', 'Hip', 'Shoulder', 'Elbow', 'Kąt ramię-tułów'),
    ('AnkleAngle', 'Knee', 'Ankle', 'FootIndex', 'Kąt goleń-stopa'),
  ];
  for (final (name, a, b, c, d) in defs) {
    for (final side in Side.values) {
      out['${side.name}$name'] =
          FeatureSpec('joint', 'deg', d, (ctx) => _angle3(ctx, _l(side, a), _l(side, b), _l(side, c)));
    }
    final near = name[0].toLowerCase() + name.substring(1);
    out[near] = FeatureSpec('joint', 'deg', '$d, strona bliżej kamery',
        (ctx) => _angle3(ctx, _l(ctx.nearSide, a), _l(ctx.nearSide, b), _l(ctx.nearSide, c)));
  }
  return out;
}();

FeatureSpec _minOfSides(String name) => FeatureSpec('joint', 'deg', 'Mniejszy z lewego i prawego: $name', (ctx) {
      final l = _sidedAngles['left$name']!.compute(ctx);
      final r = _sidedAngles['right$name']!.compute(ctx);
      if (l != null && r != null) return l.value <= r.value ? l : r;
      final one = l ?? r;
      return one == null ? null : Measurement(one.value, one.confidence * 0.6);
    });

FeatureSpec _sideDiff(String name) => FeatureSpec('alignment', 'deg', 'Różnica lewa-prawa: $name', (ctx) {
      final l = _sidedAngles['left$name']!.compute(ctx);
      final r = _sidedAngles['right$name']!.compute(ctx);
      return l != null && r != null
          ? Measurement((l.value - r.value).abs(), math.min(l.confidence, r.confidence))
          : null;
    });

final Map<String, FeatureSpec> features = {
  ..._sidedAngles,
  'minElbowAngle': _minOfSides('ElbowAngle'),
  'minKneeAngle': _minOfSides('KneeAngle'),
  'elbowAngleDiff': _sideDiff('ElbowAngle'),
  'kneeAngleDiff': _sideDiff('KneeAngle'),
  'hipAngleDiff': _sideDiff('HipAngle'),
  'trunkInclination': FeatureSpec('joint', 'deg', 'Pochylenie tułowia od pionu', (ctx) {
    final c = _centers(ctx);
    if (c.hip == null || c.shoulder == null) return null;
    final v = inclinationFromVertical(c.hip!, c.shoulder!);
    return v == null ? null : Measurement(v, _conf([c.hip, c.shoulder]));
  }),
  'trunkLeanSigned': FeatureSpec('joint', 'deg', 'Pochylenie tułowia ze znakiem (+ do przodu, - do tyłu)', (ctx) {
    final c = _centers(ctx);
    if (c.hip == null || c.shoulder == null) return null;
    final dx = ctx.facing * (c.shoulder!.x - c.hip!.x);
    final dy = c.hip!.y - c.shoulder!.y;
    if (hypot(dx, dy) < _minSeg) return null;
    return Measurement(toDegrees(math.atan2(dx, dy)), _conf([c.hip, c.shoulder]));
  }),
  'neckAlignment': FeatureSpec('joint', 'deg', 'Kąt ucho-bark-biodro',
      (ctx) => _angle3(ctx, _l(ctx.nearSide, 'Ear'), _l(ctx.nearSide, 'Shoulder'), _l(ctx.nearSide, 'Hip'))),
  'bodyLineAngle': FeatureSpec('joint', 'deg', 'Kąt bark-biodro-kostka',
      (ctx) => _angle3(ctx, _l(ctx.nearSide, 'Shoulder'), _l(ctx.nearSide, 'Hip'), _l(ctx.nearSide, 'Ankle'))),
  'forearmInclination': FeatureSpec('joint', 'deg', 'Odchylenie przedramienia od pionu', (ctx) {
    final p = _pts(ctx, [_l(ctx.nearSide, 'Elbow'), _l(ctx.nearSide, 'Wrist')]);
    if (p == null) return null;
    final v = angleBetween(sub(p[1], p[0]), const V2(0, -1));
    return v == null ? null : Measurement(math.min(v, 180 - v), _conf(p));
  }),
  'trunkChordRatio': FeatureSpec('alignment', 'ratio', 'Długość bark-biodro względem pozycji stojącej (proxy)', (ctx) {
    final b = ctx.baseline;
    if (b == null || b.torso < _minSeg) return null;
    final p = _pts(ctx, [_l(ctx.nearSide, 'Shoulder'), _l(ctx.nearSide, 'Hip')]);
    return p == null ? null : Measurement(distance(p[0], p[1]) / b.torso, _conf(p));
  }),
  'shoulderTilt': FeatureSpec(
      'alignment', 'deg', 'Przechylenie linii barków', (ctx) => _tilt(ctx, 'leftShoulder', 'rightShoulder')),
  'hipTilt': FeatureSpec('alignment', 'deg', 'Przechylenie linii bioder', (ctx) => _tilt(ctx, 'leftHip', 'rightHip')),
  'trunkLateralLean': FeatureSpec('alignment', 'deg', 'Boczne odchylenie tułowia', (ctx) {
    final sh = mid(ctx.pose, 'leftShoulder', 'rightShoulder', ctx.minConfidence);
    final hp = mid(ctx.pose, 'leftHip', 'rightHip', ctx.minConfidence);
    if (sh == null || hp == null) return null;
    final d = sub(sh, hp);
    return Measurement(toDegrees(math.atan2(d.x, -d.y)).abs(), _conf([sh, hp]));
  }),
  'hipShift': FeatureSpec('alignment', 'body', 'Przesunięcie bioder w bok / długość nogi', (ctx) {
    final hp = mid(ctx.pose, 'leftHip', 'rightHip', ctx.minConfidence);
    final an = mid(ctx.pose, 'leftAnkle', 'rightAnkle', ctx.minConfidence);
    final len = _lengths(ctx);
    if (hp == null || an == null || len == null) return null;
    return Measurement((hp.x - an.x).abs() / len.legLength, _conf([hp, an]));
  }),
  'kneeValgusRatio': FeatureSpec('alignment', 'ratio', 'Rozstaw kolan / rozstaw kostek', (ctx) {
    final p = _pts(ctx, ['leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle']);
    if (p == null) return null;
    final ankles = (p[2].x - p[3].x).abs();
    if (ankles < 0.02) return null;
    return Measurement((p[0].x - p[1].x).abs() / ankles, _conf(p));
  }),
  'hipHeight': FeatureSpec('alignment', 'body', 'Wysokość bioder', (ctx) => _heightAboveAnkles(ctx, _centers(ctx).hip)),
  'shoulderHeight':
      FeatureSpec('alignment', 'body', 'Wysokość barków', (ctx) => _heightAboveAnkles(ctx, _centers(ctx).shoulder)),
  'shoulderHeightRel': FeatureSpec('alignment', 'body', 'Wysokość barków względem pozycji stojącej', (ctx) {
    final c = _centers(ctx);
    final len = _lengths(ctx);
    if (c.shoulder == null || c.ankle == null || len == null) return null;
    final standing = len.legLength + len.torso;
    if (standing < _minSeg) return null;
    return Measurement((c.ankle!.y - c.shoulder!.y) / standing, _conf([c.shoulder, c.ankle]));
  }),
  'wristHeight':
      FeatureSpec('alignment', 'body', 'Wysokość nadgarstków', (ctx) => _heightAboveAnkles(ctx, _centers(ctx).wrist)),
  'wristToMidfootX': FeatureSpec('alignment', 'body', 'Nadgarstek względem śródstopia / tułów', (ctx) {
    final w = ctx.pose[_l(ctx.nearSide, 'Wrist')];
    final mf = _midfoot(ctx);
    final len = _lengths(ctx);
    if (!pointOk(w, ctx.minConfidence) || mf == null || len == null) return null;
    return Measurement(ctx.facing * (w!.x - mf.x) / len.torso, _conf([w, mf]));
  }),
  'shoulderToWristX': FeatureSpec('alignment', 'body', 'Bark względem nadgarstka / tułów', (ctx) {
    final p = _pts(ctx, [_l(ctx.nearSide, 'Shoulder'), _l(ctx.nearSide, 'Wrist')]);
    final len = _lengths(ctx);
    if (p == null || len == null) return null;
    return Measurement(ctx.facing * (p[0].x - p[1].x) / len.torso, _conf(p));
  }),
  'kneeForward': FeatureSpec('alignment', 'body', 'Wysunięcie kolana przed palce / goleń', (ctx) {
    final p = _pts(ctx, [_l(ctx.nearSide, 'Knee'), _l(ctx.nearSide, 'FootIndex')]);
    final len = _lengths(ctx);
    if (p == null || len == null) return null;
    return Measurement(ctx.facing * (p[0].x - p[1].x) / len.shin, _conf(p));
  }),
  'heelLift': FeatureSpec('alignment', 'body', 'Wysokość pięty względem palców / goleń', (ctx) {
    final p = _pts(ctx, [_l(ctx.nearSide, 'Heel'), _l(ctx.nearSide, 'FootIndex')]);
    final len = _lengths(ctx);
    if (p == null || len == null) return null;
    return Measurement((p[1].y - p[0].y) / len.shin, _conf(p));
  }),
  'hipBelowKnee': FeatureSpec('alignment', 'body', 'Biodro względem kolana / tułów', (ctx) {
    final p = _pts(ctx, [_l(ctx.nearSide, 'Hip'), _l(ctx.nearSide, 'Knee')]);
    final len = _lengths(ctx);
    if (p == null || len == null) return null;
    return Measurement((p[0].y - p[1].y) / len.torso, _conf(p));
  }),
  'wristAboveShoulder': FeatureSpec('alignment', 'body', 'Nadgarstki nad barkami / tułów', (ctx) {
    final c = _centers(ctx);
    final len = _lengths(ctx);
    if (c.wrist == null || c.shoulder == null || len == null) return null;
    return Measurement((c.shoulder!.y - c.wrist!.y) / len.torso, _conf([c.wrist, c.shoulder]));
  }),
  'wristToShoulderDistance': FeatureSpec('alignment', 'body', 'Odległość nadgarstek-bark / tułów', (ctx) {
    final p = _pts(ctx, [_l(ctx.nearSide, 'Shoulder'), _l(ctx.nearSide, 'Wrist')]);
    final len = _lengths(ctx);
    if (p == null || len == null) return null;
    return Measurement(distance(p[0], p[1]) / len.torso, _conf(p));
  }),
  'wristHeightDiff': FeatureSpec('alignment', 'body', 'Różnica wysokości nadgarstków / tułów', (ctx) {
    final p = _pts(ctx, ['leftWrist', 'rightWrist']);
    final len = _lengths(ctx);
    if (p == null || len == null) return null;
    return Measurement((p[0].y - p[1].y).abs() / len.torso, _conf(p));
  }),
  'splitStance': FeatureSpec('alignment', 'body', 'Rozstaw stóp przód-tył / noga', (ctx) {
    final p = _pts(ctx, ['leftAnkle', 'rightAnkle']);
    final len = _lengths(ctx);
    if (p == null || len == null) return null;
    return Measurement((p[0].x - p[1].x).abs() / len.legLength, _conf(p));
  }),
  'comOffset': FeatureSpec('alignment', 'body', 'Środek ciężkości względem śródstopia (proxy)', (ctx) {
    final c = _centers(ctx);
    final mf = _midfoot(ctx);
    final len = _lengths(ctx);
    if (c.hip == null || c.shoulder == null || mf == null || len == null) return null;
    final com = c.hip!.x * 0.6 + c.shoulder!.x * 0.4;
    return Measurement(ctx.facing * (com - mf.x) / len.legLength, _conf([c.hip, c.shoulder, mf]));
  }),
  'chinAboveHands': FeatureSpec('alignment', 'body', 'Nos względem nadgarstków / tułów', (ctx) {
    final c = _centers(ctx);
    final len = _lengths(ctx);
    final nose = ctx.pose['nose'];
    if (c.wrist == null || !pointOk(nose, ctx.minConfidence) || len == null) return null;
    return Measurement((c.wrist!.y - nose!.y) / len.torso, _conf([c.wrist, nose]));
  }),
};

String baseFeatureName(String n) {
  if (n.endsWith('.velocity')) return n.substring(0, n.length - 9);
  if (n.endsWith('.accel')) return n.substring(0, n.length - 6);
  return n;
}

bool isKnownFeature(String n) => features.containsKey(baseFeatureName(n));

/// Turns a filtered pose into a BiomechanicalFrame (only requested features).
class FeatureExtractor {
  late final List<String> base;
  late final List<String> kinematic;
  final _kin = KinematicsTracker();
  final double minConfidence;

  FeatureExtractor(List<String> requested, {this.minConfidence = 0.3}) {
    final all = <String>{...requested};
    kinematic = {
      for (final f in requested)
        if (f != baseFeatureName(f)) baseFeatureName(f)
    }.toList();
    all.addAll(kinematic);
    base = all.where(features.containsKey).toList();
  }

  void reset() => _kin.reset();

  BiomechanicalFrame extract(NormalizedFrame frame, CameraView view, Side nearSide, BodyBaseline? baseline) {
    final pose = frame.points;
    final ctx = FeatureContext(pose, nearSide, view, baseline, _facing(frame, nearSide), minConfidence);
    final joint = <String, Measurement>{}, align = <String, Measurement>{}, feats = <String, Measurement>{};
    for (final name in base) {
      final spec = features[name]!;
      final m = spec.compute(ctx);
      if (m == null || !m.value.isFinite) continue;
      feats[name] = m;
      (spec.group == 'joint' ? joint : align)[name] = m;
    }
    final vel = <String, Measurement>{};
    for (final name in kinematic) {
      final (v, a) = _kin.update(name, frame.timestamp, feats[name]);
      if (v != null) {
        vel['$name.velocity'] = v;
        feats['$name.velocity'] = v;
      }
      if (a != null) feats['$name.accel'] = a;
    }
    final used = feats.values.map((m) => m.confidence).toList();
    return BiomechanicalFrame(
      timestamp: frame.timestamp,
      jointAngles: joint,
      alignmentMetrics: align,
      movementVelocities: vel,
      trajectories: _tracked(frame, nearSide),
      confidence: used.isEmpty ? 0 : used.reduce((a, b) => a + b) / used.length,
      view: view,
      nearSide: nearSide,
      features: feats,
    );
  }
}

int _facing(NormalizedFrame f, Side side) {
  final p = f.points;
  final heel = p[sided(side, 'Heel')], toe = p[sided(side, 'FootIndex')];
  if (pointOk(heel, 0.4) && pointOk(toe, 0.4) && (toe!.x - heel!.x).abs() > 0.01) return toe.x > heel.x ? 1 : -1;
  final nose = p['nose'], ear = p[sided(side, 'Ear')];
  if (pointOk(nose, 0.4) && pointOk(ear, 0.4)) return nose!.x > ear!.x ? 1 : -1;
  return 1;
}

Map<String, Point> _tracked(NormalizedFrame f, Side side) {
  final p = f.points;
  final out = <String, Point>{};
  void set(String k, Point? v) {
    if (v != null && v.confidence >= 0.3) out[k] = v;
  }

  set('hipCenter', mid(p, 'leftHip', 'rightHip', 0.3));
  set('shoulderCenter', mid(p, 'leftShoulder', 'rightShoulder', 0.3));
  set('wristCenter', mid(p, 'leftWrist', 'rightWrist', 0.3));
  set('kneeCenter', mid(p, 'leftKnee', 'rightKnee', 0.3));
  set('nearWrist', p[sided(side, 'Wrist')]);
  set('nearHip', p[sided(side, 'Hip')]);
  set('nearShoulder', p[sided(side, 'Shoulder')]);
  set('nearKnee', p[sided(side, 'Knee')]);
  return out;
}
