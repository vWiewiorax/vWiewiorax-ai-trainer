import 'package:material_ui/material_ui.dart';
import 'package:trainer_engine/trainer_engine.dart';

/// Draws the filtered pose over the camera preview. Points are in engine space
/// (x in [0, aspect], y in [0, 1]); [mirror] flips x to match a mirrored front-camera preview.
class SkeletonPainter extends CustomPainter {
  final Pose pose;
  final double aspect;
  final bool mirror;
  final Color color;
  SkeletonPainter(this.pose, this.aspect, {required this.mirror, this.color = const Color(0xFF34D399)});

  Offset? _pt(String name, Size size) {
    final p = pose[name];
    if (p == null || p.confidence < 0.3) return null;
    final nx = p.x / aspect;
    return Offset((mirror ? 1 - nx : nx) * size.width, p.y * size.height);
  }

  @override
  void paint(Canvas canvas, Size size) {
    final line = Paint()
      ..color = color
      ..strokeWidth = 4
      ..strokeCap = StrokeCap.round;
    for (final (a, b) in skeletonConnections) {
      final pa = _pt(a, size), pb = _pt(b, size);
      if (pa != null && pb != null) canvas.drawLine(pa, pb, line);
    }
    final dot = Paint()..color = Colors.white;
    for (final n in pose.keys) {
      final p = _pt(n, size);
      if (p != null) canvas.drawCircle(p, 5, dot);
    }
  }

  @override
  bool shouldRepaint(SkeletonPainter old) => old.pose != pose || old.mirror != mirror;
}
