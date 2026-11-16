import 'dart:async';

import 'package:camera/camera.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:trainer_engine/trainer_engine.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../pose/camera_pipeline.dart';
import 'colors.dart';
import 'report_screen.dart';
import 'skeleton_painter.dart';

/// Full-screen live analysis, readable from a few metres: big rep counter, big cue, rep strip.
class LiveScreen extends StatefulWidget {
  final ExerciseDefinition exercise;
  final CameraDescription camera;
  final ResolutionPreset resolution;
  final bool accurateModel;
  final bool voice;
  const LiveScreen({
    super.key,
    required this.exercise,
    required this.camera,
    required this.resolution,
    required this.accurateModel,
    required this.voice,
  });

  @override
  State<LiveScreen> createState() => _LiveScreenState();
}

class _LiveScreenState extends State<LiveScreen> {
  late final CameraPipeline _pipe;
  late ExerciseAnalyzer _analyzer;
  final _tts = FlutterTts();
  LiveState? _state;
  FeedbackItem? _cue;
  DateTime _cueAt = DateTime(0);
  String? _error;
  bool _ready = false;
  late bool _voice = widget.voice;
  final _reps = <ExerciseRepetition>[];

  static const _cueHold = Duration(seconds: 5);

  @override
  void initState() {
    super.initState();
    _analyzer = ExerciseAnalyzer(widget.exercise, candidates: exercises.values.toList());
    _pipe = CameraPipeline(widget.camera, resolution: widget.resolution, accurateModel: widget.accurateModel)
      ..onFrame = _onFrame;
    _init();
  }

  Future<void> _init() async {
    try {
      await _tts.setLanguage('pl-PL');
      await _tts.setSpeechRate(0.5);
      await _tts.awaitSpeakCompletion(false);
    } catch (_) {}
    try {
      await _pipe.initialize();
      await _pipe.start();
      await WakelockPlus.enable();
      if (mounted) setState(() => _ready = true);
    } on CameraException catch (e) {
      if (mounted) {
        setState(() => _error = e.code == 'CameraAccessDenied'
            ? 'Brak zgody na kamerę. Włącz ją w ustawieniach telefonu dla aplikacji AI Trainer.'
            : 'Nie udało się włączyć kamery: ${e.description ?? e.code}');
      }
    }
  }

  void _onFrame(PoseFrame f) {
    if (!mounted) return;
    final s = _analyzer.processFrame(f);
    final fb = s.feedback;
    if (fb != null) {
      _cue = fb;
      _cueAt = DateTime.now();
      if (_voice && fb.voice != null) _speak(fb.voice!);
    }
    if (s.newRepetition != null) _reps.add(s.newRepetition!);
    setState(() => _state = s);
  }

  Future<void> _speak(String text) async {
    try {
      await _tts.stop();
      await _tts.speak(text);
    } catch (_) {}
  }

  Future<void> _endSet() async {
    await _pipe.stop();
    final report = _analyzer.endSet();
    if (!mounted) return;
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ReportScreen(exercise: widget.exercise, report: report)));
    if (!mounted) return;
    setState(() {
      _analyzer = ExerciseAnalyzer(widget.exercise, candidates: exercises.values.toList());
      _reps.clear();
      _cue = null;
      _state = null;
    });
    await _pipe.start();
  }

  @override
  void dispose() {
    WakelockPlus.disable();
    _tts.stop();
    _pipe.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: _error != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, style: const TextStyle(fontSize: 20))))
          : !_ready
              ? const Center(child: CircularProgressIndicator())
              : LayoutBuilder(builder: (context, box) => _live(box)),
    );
  }

  Widget _live(BoxConstraints box) {
    final s = _state;
    final shortSide = box.biggest.shortestSide;
    final big = shortSide * 0.09;
    final cueVisible = _cue != null && DateTime.now().difference(_cueAt) < _cueHold;
    final analysing = s?.status == AnalyzerStatus.analysing;
    final guidance = !analysing && s != null && s.calibration.guidance.isNotEmpty ? s.calibration.guidance.first : null;
    final previewAspect = s?.aspect ?? (1 / _pipe.controller.value.aspectRatio);

    return Stack(fit: StackFit.expand, children: [
      Center(
        child: AspectRatio(
          aspectRatio: previewAspect,
          child: Stack(fit: StackFit.expand, children: [
            CameraPreview(_pipe.controller),
            if (s != null)
              CustomPaint(painter: SkeletonPainter(s.pose, s.aspect, mirror: _pipe.isFront)),
          ]),
        ),
      ),
      // Top: rep count, score, phase.
      Positioned(
        top: 0,
        left: 0,
        right: 0,
        child: SafeArea(
          child: Container(
            color: Colors.black54,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(children: [
              Text('${s?.repCount ?? 0}', style: TextStyle(fontSize: big * 1.6, fontWeight: FontWeight.w900, height: 1)),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(widget.exercise.name, style: const TextStyle(fontSize: 16, color: Colors.white70)),
                  Text(
                    analysing ? (s!.phaseLabel ?? '') : _statusLabel(s?.status),
                    style: TextStyle(fontSize: big * 0.5, fontWeight: FontWeight.bold),
                  ),
                ]),
              ),
              if (s?.setScore != null)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(color: scoreColor(s!.setScore), borderRadius: BorderRadius.circular(12)),
                  child: Text('${s.setScore}', style: TextStyle(fontSize: big * 0.7, fontWeight: FontWeight.w900)),
                ),
            ]),
          ),
        ),
      ),
      // Middle: setup guidance or the latest correction, large.
      if (guidance != null || cueVisible)
        Align(
          alignment: const Alignment(0, 0.35),
          child: Container(
            margin: const EdgeInsets.symmetric(horizontal: 12),
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: (guidance != null && !cueVisible ? const Color(0xFF1E3A8A) : _cueColor(_cue!)).withValues(alpha: 0.9),
              borderRadius: BorderRadius.circular(16),
            ),
            child: Text(
              cueVisible ? _cue!.text : guidance!,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: big * 0.55, fontWeight: FontWeight.bold, color: Colors.white),
            ),
          ),
        ),
      if (s?.stopSetRecommended ?? false)
        Positioned(
          top: big * 2.6,
          left: 12,
          right: 12,
          child: Container(
            color: Colors.red,
            padding: const EdgeInsets.all(8),
            child: const Text(Msg.stopSet, textAlign: TextAlign.center, style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          ),
        ),
      // Bottom: per-rep strip and controls.
      Positioned(
        left: 0,
        right: 0,
        bottom: 0,
        child: SafeArea(
          child: Container(
            color: Colors.black54,
            padding: const EdgeInsets.all(8),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              if (_reps.isNotEmpty)
                SizedBox(
                  height: big * 1.1,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    reverse: true,
                    children: [for (final r in _reps.reversed) _repChip(r, big)],
                  ),
                ),
              const SizedBox(height: 8),
              Row(children: [
                IconButton(
                  tooltip: 'Głos',
                  iconSize: 32,
                  icon: Icon(_voice ? Icons.volume_up : Icons.volume_off),
                  onPressed: () => setState(() => _voice = !_voice),
                ),
                TextButton(onPressed: () => _speak('Biodra w tył, plecy proste.'), child: const Text('Test głosu')),
                const Spacer(),
                FilledButton(
                  style: FilledButton.styleFrom(backgroundColor: Colors.red.shade700),
                  onPressed: _endSet,
                  child: const Padding(padding: EdgeInsets.all(10), child: Text('Zakończ serię', style: TextStyle(fontSize: 18))),
                ),
              ]),
            ]),
          ),
        ),
      ),
    ]);
  }

  Widget _repChip(ExerciseRepetition r, double big) {
    final issues = rankedIssues(r);
    final label = r.incomplete
        ? 'niezaliczone'
        : issues.isEmpty
            ? 'OK'
            : issueLabel(widget.exercise, issues.first);
    return Container(
      margin: const EdgeInsets.only(left: 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: scoreColor(r.incomplete ? 0 : r.techniqueScore), borderRadius: BorderRadius.circular(10)),
      child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
        Text('#${r.index}  ${r.techniqueScore ?? '-'}', style: TextStyle(fontSize: big * 0.38, fontWeight: FontWeight.w900)),
        Text(label, style: const TextStyle(fontSize: 13)),
      ]),
    );
  }

  String _statusLabel(AnalyzerStatus? s) => switch (s) {
        AnalyzerStatus.noPerson => 'Nie widzę sylwetki',
        AnalyzerStatus.calibrating => 'Kalibracja',
        AnalyzerStatus.paused => 'Wstrzymano',
        _ => 'Uruchamianie...',
      };

  Color _cueColor(FeedbackItem c) => switch (c.kind) {
        FeedbackKind.technique => severityColor(c.severity),
        FeedbackKind.safety => Colors.red,
        FeedbackKind.rep => const Color(0xFF16A34A),
        _ => const Color(0xFF1E3A8A),
      };
}
