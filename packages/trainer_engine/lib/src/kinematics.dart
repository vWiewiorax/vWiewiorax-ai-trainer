import 'types.dart';

class _Sample {
  final double t, v, c;
  const _Sample(this.t, this.v, this.c);
}

/// Finite-difference velocity and acceleration over a short window.
class KinematicsTracker {
  final double windowMs;
  final _buffers = <String, List<_Sample>>{};
  KinematicsTracker([this.windowMs = 160]);

  void reset() => _buffers.clear();

  (Measurement?, Measurement?) update(String name, double t, Measurement? m) {
    final buf = _buffers.putIfAbsent(name, () => []);
    if (m == null) {
      buf.clear();
      return (null, null);
    }
    buf.add(_Sample(t, m.value, m.confidence));
    while (buf.length > 2 && t - buf.first.t > windowMs * 2) {
      buf.removeAt(0);
    }
    final velocity = _slope(buf, t, windowMs);
    if (velocity == null) return (null, null);
    final half = buf.where((s) => s.t <= t - windowMs / 2).toList();
    final prev = half.length >= 2 ? _slope(half, half.last.t, windowMs) : null;
    final dt = prev != null ? (windowMs / 2) / 1000 : 0;
    final accel = prev != null && dt > 0
        ? Measurement((velocity.value - prev.value) / dt,
            velocity.confidence < prev.confidence ? velocity.confidence : prev.confidence)
        : null;
    return (velocity, accel);
  }
}

Measurement? _slope(List<_Sample> buf, double t, double windowMs) {
  final pts = buf.where((s) => t - s.t <= windowMs).toList();
  if (pts.length < 2) return null;
  final dt = (pts.last.t - pts.first.t) / 1000;
  if (dt <= 0) return null;
  return Measurement((pts.last.v - pts.first.v) / dt, pts.first.c < pts.last.c ? pts.first.c : pts.last.c);
}
