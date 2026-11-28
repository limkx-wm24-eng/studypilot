export type Tab = 'dash' | 'classes' | 'tasks' | 'timetable' | 'progress' | 'profile';

import { dayDifference, deadlineText, malaysiaDay } from './dateOnly';
export const daysLeft = (due: string, today = malaysiaDay()) => dayDifference(due, today);
export const dueText = (due: string, today = malaysiaDay()) => deadlineText(daysLeft(due, today));
