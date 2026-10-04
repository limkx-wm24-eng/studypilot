import { GRADE_SCALE, type LetterGrade } from './gradeScale';

export type GradeCourse = { semesterLabel: string; creditHours: number; grade: LetterGrade | null };
export type Gpa = { points: number; credits: number; gpa: number | null };
const round = (value: number) => Math.round(value * 10000) / 10000;

export function calculateGpa(courses: GradeCourse[]): Gpa {
  const graded = courses.filter((course) => course.grade !== null);
  const credits = graded.reduce((total, course) => total + course.creditHours, 0);
  const points = graded.reduce((total, course) => total + course.creditHours * GRADE_SCALE[course.grade!], 0);
  return { points, credits, gpa: credits ? round(points / credits) : null };
}

export function calculateCgpa(courses: GradeCourse[]): Gpa { return calculateGpa(courses); }

export function neededAverage(current: Gpa, targetCgpa: number, futureCredits: number) {
  if (!current.credits || futureCredits <= 0) return { needed: null, reachable: false };
  const needed = (targetCgpa * (current.credits + futureCredits) - current.points) / futureCredits;
  return { needed: round(needed), reachable: needed >= 0 && needed <= 4 };
}
