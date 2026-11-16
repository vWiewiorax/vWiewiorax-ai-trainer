import 'package:camera/camera.dart';
import 'package:material_ui/material_ui.dart';
import 'package:trainer_engine/trainer_engine.dart';

import 'ui/live_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  var cameras = <CameraDescription>[];
  String? error;
  try {
    cameras = await availableCameras();
  } on CameraException catch (e) {
    error = e.description ?? e.code;
  }
  runApp(TrainerApp(cameras: cameras, cameraError: error));
}

class TrainerApp extends StatelessWidget {
  final List<CameraDescription> cameras;
  final String? cameraError;
  const TrainerApp({super.key, required this.cameras, this.cameraError});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'AI Trainer',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(colorSchemeSeed: const Color(0xFF10B981), brightness: Brightness.dark, useMaterial3: true),
        home: SetupScreen(cameras: cameras, cameraError: cameraError),
      );
}

/// Exercise + camera choice before a set. No accounts, plans or dashboards on purpose.
class SetupScreen extends StatefulWidget {
  final List<CameraDescription> cameras;
  final String? cameraError;
  const SetupScreen({super.key, required this.cameras, this.cameraError});

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  String _exerciseId = exercises.keys.first;
  CameraDescription? _camera;
  ResolutionPreset _resolution = ResolutionPreset.medium;
  bool _accurate = false;
  bool _voice = true;

  @override
  void initState() {
    super.initState();
    final cams = widget.cameras;
    _camera = cams.where((c) => c.lensDirection == CameraLensDirection.front).firstOrNull ?? cams.firstOrNull;
  }

  String _camLabel(CameraDescription c) => switch (c.lensDirection) {
        CameraLensDirection.front => 'Przednia (widzisz ekran)',
        CameraLensDirection.back => 'Tylna (lepsza jakość)',
        CameraLensDirection.external => 'Zewnętrzna',
      };

  @override
  Widget build(BuildContext context) {
    final def = exercises[_exerciseId]!;
    return Scaffold(
      appBar: AppBar(title: const Text('Analiza techniki')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (widget.cameraError != null)
            Card(
              color: Colors.red.shade900,
              child: Padding(padding: const EdgeInsets.all(12), child: Text('Kamera niedostępna: ${widget.cameraError}')),
            ),
          const Text('Ćwiczenie', style: TextStyle(fontWeight: FontWeight.bold)),
          RadioGroup<String>(
            groupValue: _exerciseId,
            onChanged: (v) => setState(() => _exerciseId = v!),
            child: Column(children: [
              for (final e in exercises.values) RadioListTile<String>(value: e.id, title: Text(e.name)),
            ]),
          ),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text('Ustawienie kamery: ${def.cameraSetup}'),
            ),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<CameraDescription>(
            initialValue: _camera,
            decoration: const InputDecoration(labelText: 'Kamera'),
            items: [for (final c in widget.cameras) DropdownMenuItem(value: c, child: Text(_camLabel(c)))],
            onChanged: (c) => setState(() => _camera = c),
          ),
          DropdownButtonFormField<ResolutionPreset>(
            initialValue: _resolution,
            decoration: const InputDecoration(labelText: 'Rozdzielczość'),
            items: const [
              DropdownMenuItem(value: ResolutionPreset.low, child: Text('Niska (słabszy telefon)')),
              DropdownMenuItem(value: ResolutionPreset.medium, child: Text('Średnia (zalecana)')),
              DropdownMenuItem(value: ResolutionPreset.high, child: Text('Wysoka 720p')),
            ],
            onChanged: (r) => setState(() => _resolution = r!),
          ),
          SwitchListTile(
            title: const Text('Dokładny model pozy'),
            subtitle: const Text('Wolniejszy, lepszy przy zasłoniętych nogach'),
            value: _accurate,
            onChanged: (v) => setState(() => _accurate = v),
          ),
          SwitchListTile(
            title: const Text('Podpowiedzi głosowe po polsku'),
            value: _voice,
            onChanged: (v) => setState(() => _voice = v),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            icon: const Icon(Icons.videocam),
            label: const Padding(padding: EdgeInsets.all(12), child: Text('Start', style: TextStyle(fontSize: 20))),
            onPressed: _camera == null
                ? null
                : () => Navigator.of(context).push(MaterialPageRoute(
                      builder: (_) => LiveScreen(
                        exercise: def,
                        camera: _camera!,
                        resolution: _resolution,
                        accurateModel: _accurate,
                        voice: _voice,
                      ),
                    )),
          ),
          const SizedBox(height: 16),
          const Text(Msg.disclaimer, style: TextStyle(color: Colors.white60, fontSize: 12)),
        ],
      ),
    );
  }
}
