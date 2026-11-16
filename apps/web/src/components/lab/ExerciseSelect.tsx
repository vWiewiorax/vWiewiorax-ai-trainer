"use client";

import { EXERCISES } from "@trainer/engine";

export function ExerciseSelect({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-slate-400">Ćwiczenie</span>
      <select
        data-testid="exercise-select"
        className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100 disabled:opacity-60"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {Object.values(EXERCISES).map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
    </label>
  );
}
