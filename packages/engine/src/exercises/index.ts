import type { ExerciseDefinition } from "../core/types";
import { deadlift } from "./deadlift";
import { romanianDeadlift } from "./romanianDeadlift";
import { backSquat } from "./squat";

export { deadlift, romanianDeadlift, backSquat };

export const EXERCISES: Record<string, ExerciseDefinition> = {
  [deadlift.id]: deadlift,
  [romanianDeadlift.id]: romanianDeadlift,
  [backSquat.id]: backSquat,
};

export function getExercise(id: string): ExerciseDefinition | undefined {
  return EXERCISES[id];
}
