import { z } from 'zod';

export const className = z.string().trim().min(1).max(60);
export const CLASS_PALETTE = ['#0f766e', '#6366f1', '#d97706', '#db2777', '#16a34a', '#7c3aed'];
