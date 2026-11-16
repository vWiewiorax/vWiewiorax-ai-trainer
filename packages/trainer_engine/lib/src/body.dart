import 'geometry.dart';
import 'landmarks.dart';
import 'types.dart';

/// Reference segment lengths measured during calibration (camera units).
class BodyBaseline {
  final double torso, thigh, shin, upperArm, forearm, shoulderWidth, hipWidth, legLength, height;
  const BodyBaseline({
    required this.torso,
    required this.thigh,
    required this.shin,
    required this.upperArm,
    required this.forearm,
    required this.shoulderWidth,
    required this.hipWidth,
    required this.legLength,
    required this.height,
  });
}

/// Partial segment measurement: keys torso, thigh, shin, upperArm, forearm, shoulderWidth, hipWidth, legLength, height.
typedef Segments = Map<String, double>;

bool pointOk(Point? p, double minConfidence) => p != null && p.confidence >= minConfidence;

Point? mid(Pose pose, String a, String b, double minConfidence) {
  final pa = pose[a], pb = pose[b];
  if (pointOk(pa, minConfidence) && pointOk(pb, minConfidence)) {
    final m = midpoint(pa!, pb!);
    return Point(m.x, m.y, confidence: pa.confidence < pb.confidence ? pa.confidence : pb.confidence);
  }
  return null;
}

Segments measureSegments(Pose pose, Side side, [double minConfidence = 0.5]) {
  Point? s(String n) => pose[sided(side, n)];
  double? seg(Point? a, Point? b) => pointOk(a, minConfidence) && pointOk(b, minConfidence) ? distance(a!, b!) : null;
  final out = <String, double>{};
  void put(String k, double? v) {
    if (v != null && v != 0) out[k] = v;
  }

  final thigh = seg(s('Hip'), s('Knee'));
  final shin = seg(s('Knee'), s('Ankle'));
  put('torso', seg(s('Shoulder'), s('Hip')));
  put('thigh', thigh);
  put('shin', shin);
  put('upperArm', seg(s('Shoulder'), s('Elbow')));
  put('forearm', seg(s('Elbow'), s('Wrist')));
  put('shoulderWidth', seg(pose['leftShoulder'], pose['rightShoulder']));
  put('hipWidth', seg(pose['leftHip'], pose['rightHip']));
  if (thigh != null && thigh != 0 && shin != null && shin != 0) out['legLength'] = thigh + shin;
  final ankle =
      mid(pose, 'leftAnkle', 'rightAnkle', minConfidence) ?? (pointOk(s('Ankle'), minConfidence) ? s('Ankle') : null);
  final nose = pose['nose'];
  if (pointOk(nose, minConfidence) && ankle != null) put('height', (ankle.y - nose!.y).abs());
  return out;
}
