import 'dart:math' as math;

class V2 {
  final double x;
  final double y;
  const V2(this.x, this.y);
}

const _eps = 1e-9;

V2 sub(V2 a, V2 b) => V2(a.x - b.x, a.y - b.y);
V2 add(V2 a, V2 b) => V2(a.x + b.x, a.y + b.y);
double dot(V2 a, V2 b) => a.x * b.x + a.y * b.y;
double norm(V2 a) => hypot(a.x, a.y);
double distance(V2 a, V2 b) => hypot(a.x - b.x, a.y - b.y);
V2 midpoint(V2 a, V2 b) => V2((a.x + b.x) / 2, (a.y + b.y) / 2);
double hypot(double a, double b) => math.sqrt(a * a + b * b);
double toDegrees(double rad) => rad * 180 / math.pi;

/// Unsigned angle between two vectors in degrees [0, 180], or null for zero-length vectors.
double? angleBetween(V2 u, V2 v) {
  final nu = norm(u), nv = norm(v);
  if (nu < _eps || nv < _eps) return null;
  final c = (dot(u, v) / (nu * nv)).clamp(-1.0, 1.0);
  return toDegrees(math.acos(c));
}

/// Interior angle at vertex b formed by a-b-c (180 = straight).
double? jointAngle(V2 a, V2 b, V2 c) => angleBetween(sub(a, b), sub(c, b));

/// Angle of from->to relative to vertical "up" in image space, [0, 180].
double? inclinationFromVertical(V2 from, V2 to) => angleBetween(sub(to, from), const V2(0, -1));

/// Signed angle of from->to relative to horizontal; positive when `to` is higher in the image.
double? signedAngleFromHorizontal(V2 from, V2 to) {
  final d = sub(to, from);
  if (norm(d) < _eps) return null;
  return toDegrees(math.atan2(-d.y, d.x));
}

double mean(List<double> v) {
  if (v.isEmpty) return double.nan;
  var s = 0.0;
  for (final x in v) {
    s += x;
  }
  return s / v.length;
}

double std(List<double> v) {
  if (v.length < 2) return 0;
  final m = mean(v);
  var s = 0.0;
  for (final x in v) {
    s += (x - m) * (x - m);
  }
  return math.sqrt(s / (v.length - 1));
}

double percentile(List<double> v, double p) {
  if (v.isEmpty) return double.nan;
  final s = [...v]..sort();
  final idx = math.min(s.length - 1, math.max(0, (p / 100 * s.length).ceil() - 1));
  return s[idx];
}

double median(List<double> v) {
  if (v.isEmpty) return double.nan;
  final s = [...v]..sort();
  final mid = s.length ~/ 2;
  return s.length.isOdd ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

double coefficientOfVariation(List<double> v) {
  final m = mean(v);
  if (!m.isFinite || m.abs() < 1e-9) return 0;
  return std(v) / m.abs();
}

double clampD(double v, double lo, double hi) => math.min(hi, math.max(lo, v));

/// Linear resampling to n evenly spaced samples; null gaps are interpolated.
List<double>? resample(List<double?> values, int n) {
  final known = <(int, double)>[];
  for (var i = 0; i < values.length; i++) {
    final v = values[i];
    if (v != null && v.isFinite) known.add((i, v));
  }
  if (known.length < 2 || n < 2) return null;
  final out = <double>[];
  final last = values.length - 1;
  var k = 0;
  for (var j = 0; j < n; j++) {
    final pos = j / (n - 1) * last;
    while (k < known.length - 2 && known[k + 1].$1 < pos) {
      k++;
    }
    final (i0, v0) = known[k];
    final (i1, v1) = known[k + 1];
    if (pos <= i0) {
      out.add(v0);
    } else if (pos >= i1) {
      out.add(v1);
    } else {
      out.add(v0 + (v1 - v0) * (pos - i0) / (i1 - i0));
    }
  }
  return out;
}

/// JS-compatible rounding (half away from zero is not JS; JS rounds half up).
double roundTo(double v, [int digits = 0]) {
  final f = math.pow(10, digits).toDouble();
  return (v * f + 0.5).floorToDouble() / f;
}

int jsRound(double v) => (v + 0.5).floor();
